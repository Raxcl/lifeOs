//! Syncthing sidecar 管理模块
//!
//! 负责 Syncthing 进程的启动 / 停止，以及通过 REST API 完成
//! 设备配对、文件夹共享、同步状态查询等操作。

use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const FOLDER_ID: &str = "lifeos-vault";
const GUI_PORT: u16 = 22520;
const STARTUP_WAIT_MS: u64 = 600;
const API_RETRY_COUNT: u32 = 25;
const API_RETRY_INTERVAL_MS: u64 = 400;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct SyncState {
    inner: Mutex<Option<RunningSyncthing>>,
}

struct RunningSyncthing {
    /// 由本应用启动的进程为 Some；接管外部已有实例时为 None。
    child: Option<CommandChild>,
    port: u16,
    api_key: String,
    device_id: String,
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

/// 应用退出时调用，终止 Syncthing 子进程。
pub fn cleanup(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SyncState>() {
        if let Ok(mut guard) = state.inner.lock() {
            if let Some(running) = guard.take() {
                if let Some(child) = running.child {
                    let _ = child.kill();
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Serialization types（返回给前端）
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SyncStatus {
    pub running: bool,
    pub device_id: String,
    pub devices: Vec<SyncDevice>,
    pub folder_ok: bool,
}

#[derive(Serialize, Clone)]
pub struct SyncDevice {
    pub id: String,
    pub name: String,
    pub connected: bool,
}

// ---------------------------------------------------------------------------
// REST helpers（ureq → localhost Syncthing API）
// ---------------------------------------------------------------------------

fn api_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn api_get(port: u16, key: &str, path: &str) -> Result<serde_json::Value, String> {
    let resp = ureq::get(&format!("{}{path}", api_base(port)))
        .set("X-API-Key", key)
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| format!("请求 Syncthing API 失败：{e}"))?;
    let text = resp
        .into_string()
        .map_err(|e| format!("读取 Syncthing 响应失败：{e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析 Syncthing 响应失败：{e}"))
}

fn api_post(port: u16, key: &str, path: &str, body: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(body).map_err(|e| format!("序列化请求失败：{e}"))?;
    ureq::put(&format!("{}{path}", api_base(port)))
        .set("X-API-Key", key)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(10))
        .send_string(&json)
        .map_err(|e| format!("Syncthing API 请求失败：{e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 进程生命周期
// ---------------------------------------------------------------------------

/// 启动 Syncthing sidecar 并等待 REST API 就绪。
pub fn start_syncthing(
    app: &tauri::AppHandle,
    state: &SyncState,
    vault_path: &Path,
) -> Result<String, String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "同步状态锁异常".to_string())?;
    if guard.is_some() {
        return Ok("Syncthing 已在运行中".to_string());
    }

    // 1. 准备独立的 Syncthing 配置目录
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?
        .join("syncthing");
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("创建 Syncthing 配置目录失败：{e}"))?;

    let config_xml = config_dir.join("config.xml");
    let port = GUI_PORT;

    // 2. 检测是否已有实例在运行（开发热重载 / 上次未正常关闭）
    if config_xml.exists() {
        if let Ok(xml) = fs::read_to_string(&config_xml) {
            if let Some(existing_key) = extract_xml_tag(&xml, "apikey") {
                if let Ok(resp) = ureq::get(&format!("http://127.0.0.1:{port}/rest/system/status"))
                    .set("X-API-Key", &existing_key)
                    .timeout(Duration::from_millis(800))
                    .call()
                {
                    if let Ok(text) = resp.into_string() {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(id) = json.get("myID").and_then(|v| v.as_str()) {
                                // 已有实例正常响应，直接接管
                                configure_vault_folder(port, &existing_key, id, vault_path)?;
                                *guard = Some(RunningSyncthing {
                                    child: None,
                                    port,
                                    api_key: existing_key,
                                    device_id: id.to_string(),
                                });
                                return Ok(id.to_string());
                            }
                        }
                    }
                }
            }
        }
        // 已有实例无响应，删除锁文件以便重新启动
        let _ = fs::remove_file(config_dir.join("syncthing.lock"));
    }

    // 3. 启动 sidecar 进程（固定 GUI 端口）
    let gui_addr = format!("127.0.0.1:{port}");
    let (_rx, child) = app
        .shell()
        .sidecar("syncthing")
        .map_err(|e| {
            format!("未找到 Syncthing 程序，请确认已正确安装：{e}")
        })?
        .args([
            "--no-browser",
            "--no-upgrade",
            &format!("--gui-address={gui_addr}"),
            "--home",
            config_dir.to_str().unwrap_or("."),
        ])
        .spawn()
        .map_err(|e| format!("启动 Syncthing 失败：{e}"))?;

    // 4. 等待 config.xml 生成
    thread::sleep(Duration::from_millis(STARTUP_WAIT_MS));
    let mut waited = 0u64;
    while !config_xml.exists() && waited < 8000 {
        thread::sleep(Duration::from_millis(API_RETRY_INTERVAL_MS));
        waited += API_RETRY_INTERVAL_MS;
    }
    if !config_xml.exists() {
        let _ = child.kill();
        return Err("Syncthing 启动超时，未生成配置文件".to_string());
    }

    // 5. 从 config.xml 中提取 API Key
    let xml = fs::read_to_string(&config_xml)
        .map_err(|e| format!("读取 Syncthing 配置失败：{e}"))?;
    let api_key = extract_xml_tag(&xml, "apikey")
        .ok_or_else(|| "无法从配置中读取 API Key".to_string())?;

    // 6. 轮询 REST API 直到就绪
    let mut device_id = String::new();
    for _ in 0..API_RETRY_COUNT {
        if let Ok(resp) = ureq::get(&format!("http://127.0.0.1:{port}/rest/system/status"))
            .set("X-API-Key", &api_key)
            .timeout(Duration::from_millis(500))
            .call()
        {
            if let Ok(text) = resp.into_string() {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(id) = json.get("myID").and_then(|v| v.as_str()) {
                        device_id = id.to_string();
                        break;
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(API_RETRY_INTERVAL_MS));
    }

    if device_id.is_empty() {
        let _ = child.kill();
        return Err("无法连接 Syncthing REST API，请检查端口是否被占用".to_string());
    }

    // 7. 自动配置 Vault 同步文件夹
    configure_vault_folder(port, &api_key, &device_id, vault_path)?;

    // 8. 保存运行状态
    *guard = Some(RunningSyncthing {
        child: Some(child),
        port,
        api_key,
        device_id: device_id.clone(),
    });

    Ok(device_id)
}

/// 停止 Syncthing 进程。
pub fn stop_syncthing(state: &SyncState) -> Result<(), String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "同步状态锁异常".to_string())?;
    if let Some(running) = guard.take() {
        if let Some(child) = running.child {
            child
                .kill()
                .map_err(|e| format!("停止 Syncthing 失败：{e}"))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_sync_status(_app: tauri::AppHandle, state: tauri::State<SyncState>) -> Result<SyncStatus, String> {
    let guard = state.inner.lock().map_err(|_| "同步状态锁异常".to_string())?;
    let running = match guard.as_ref() {
        Some(r) => r,
        None => {
            return Ok(SyncStatus {
                running: false,
                device_id: String::new(),
                devices: vec![],
                folder_ok: false,
            })
        }
    };

    let port = running.port;
    let key = &running.api_key;
    let my_id = running.device_id.clone();

    // 查询已配对设备
    let config = api_get(port, key, "/rest/config")?;
    let devices: Vec<SyncDevice> = config
        .get("devices")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|d| {
                    d.get("deviceID")
                        .and_then(|id| id.as_str())
                        .map(|id| id != my_id)
                        .unwrap_or(false)
                })
                .map(|d| SyncDevice {
                    id: d
                        .get("deviceID")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    name: d
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    connected: false,
                })
                .collect()
        })
        .unwrap_or_default();

    // 查询连接状态
    let mut devices = devices;
    if let Ok(conns) = api_get(port, key, "/rest/system/connections") {
        for dev in &mut devices {
            dev.connected = conns
                .get("connections")
                .and_then(|c| c.get(&dev.id))
                .and_then(|c| c.get("connected"))
                .and_then(|c| c.as_bool())
                .unwrap_or(false);
        }
    }

    // 查询文件夹状态
    let folder_ok = api_get(port, key, &format!("/rest/db/status?folder={FOLDER_ID}"))
        .map(|s| {
            s.get("state")
                .and_then(|s| s.as_str())
                .map(|s| s == "idle" || s == "scanning" || s == "syncing")
                .unwrap_or(false)
        })
        .unwrap_or(false);

    Ok(SyncStatus {
        running: true,
        device_id: my_id,
        devices,
        folder_ok,
    })
}

#[tauri::command]
pub fn start_sync(
    app: tauri::AppHandle,
    state: tauri::State<SyncState>,
    vault_path: String,
) -> Result<String, String> {
    let path = Path::new(&vault_path);
    start_syncthing(&app, &state, path)
}

#[tauri::command]
pub fn stop_sync(state: tauri::State<SyncState>) -> Result<String, String> {
    stop_syncthing(&state)?;
    Ok("已停止同步".to_string())
}

#[tauri::command]
pub fn add_sync_device(
    state: tauri::State<SyncState>,
    device_id: String,
    device_name: Option<String>,
) -> Result<String, String> {
    let device_id = device_id.trim().to_string();
    if device_id.is_empty() {
        return Err("请输入对方设备码".to_string());
    }

    let guard = state.inner.lock().map_err(|_| "同步状态锁异常".to_string())?;
    let running = guard
        .as_ref()
        .ok_or_else(|| "Syncthing 未运行，请先开启同步".to_string())?;
    let port = running.port;
    let key = running.api_key.clone();
    let my_id = running.device_id.clone();
    drop(guard);

    if device_id == my_id {
        return Err("不能添加自己为本机设备".to_string());
    }

    let mut config = api_get(port, &key, "/rest/config")?;

    // 检查是否已存在
    let exists = config
        .get("devices")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter().any(|d| {
                d.get("deviceID")
                    .and_then(|id| id.as_str())
                    .map(|id| id == device_id)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if exists {
        return Err("该设备已配对，无需重复添加".to_string());
    }

    // 添加设备
    let name = device_name.unwrap_or_else(|| "新设备".to_string());
    let new_device = serde_json::json!({
        "deviceID": device_id,
        "name": name,
        "addresses": ["dynamic"],
        "compression": "metadata",
        "introducer": false,
        "skipIntroductionRemovals": false,
        "introducedBy": "",
        "paused": false,
        "allowedNetworks": [],
        "autoAcceptFolders": false,
        "maxSendKbps": 0,
        "maxRecvKbps": 0,
        "maxRequestKiB": 0,
        "untrusted": false,
        "remoteGUIPort": 0
    });

    if let Some(devices) = config.get_mut("devices").and_then(|d| d.as_array_mut()) {
        devices.push(new_device);
    }

    // 把新设备加入所有文件夹
    if let Some(folders) = config.get_mut("folders").and_then(|f| f.as_array_mut()) {
        for folder in folders.iter_mut() {
            if let Some(devs) = folder.get_mut("devices").and_then(|d| d.as_array_mut()) {
                let already = devs.iter().any(|d| {
                    d.get("deviceID")
                        .and_then(|id| id.as_str())
                        .map(|id| id == device_id)
                        .unwrap_or(false)
                });
                if !already {
                    devs.push(serde_json::json!({
                        "deviceID": device_id,
                        "introducedBy": "",
                        "encryptionPassword": ""
                    }));
                }
            }
        }
    }

    api_post(port, &key, "/rest/config", &config)?;
    Ok(format!("已添加设备「{name}」，等待对方确认连接"))
}

#[tauri::command]
pub fn remove_sync_device(
    state: tauri::State<SyncState>,
    device_id: String,
) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|_| "同步状态锁异常".to_string())?;
    let running = guard
        .as_ref()
        .ok_or_else(|| "Syncthing 未运行".to_string())?;
    let port = running.port;
    let key = running.api_key.clone();
    drop(guard);

    let mut config = api_get(port, &key, "/rest/config")?;

    if let Some(devices) = config.get_mut("devices").and_then(|d| d.as_array_mut()) {
        devices.retain(|d| {
            d.get("deviceID")
                .and_then(|id| id.as_str())
                .map(|id| id != device_id)
                .unwrap_or(true)
        });
    }

    if let Some(folders) = config.get_mut("folders").and_then(|f| f.as_array_mut()) {
        for folder in folders.iter_mut() {
            if let Some(devs) = folder.get_mut("devices").and_then(|d| d.as_array_mut()) {
                devs.retain(|d| {
                    d.get("deviceID")
                        .and_then(|id| id.as_str())
                        .map(|id| id != device_id)
                        .unwrap_or(true)
                });
            }
        }
    }

    api_post(port, &key, "/rest/config", &config)?;
    Ok("已移除该设备".to_string())
}

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/// 从 XML 文本中提取 `<tag>value</tag>` 的内容。
fn extract_xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim().to_string())
}

/// 确保 Vault 文件夹已注册为 Syncthing 共享文件夹。
fn configure_vault_folder(
    port: u16,
    key: &str,
    my_device_id: &str,
    vault_path: &Path,
) -> Result<(), String> {
    let mut config = api_get(port, key, "/rest/config")?;

    let folders = config
        .get_mut("folders")
        .and_then(|f| f.as_array_mut())
        .ok_or_else(|| "无法读取 Syncthing 文件夹配置".to_string())?;

    let vault_str = vault_path
        .to_str()
        .ok_or_else(|| "日记本路径包含无效字符".to_string())?;

    if let Some(folder) = folders.iter_mut().find(|f| {
        f.get("id")
            .and_then(|id| id.as_str())
            .map(|id| id == FOLDER_ID)
            .unwrap_or(false)
    }) {
        // 已存在 → 更新路径
        folder["path"] = serde_json::Value::String(vault_str.to_string());
    } else {
        // 新增
        folders.push(serde_json::json!({
            "id": FOLDER_ID,
            "label": "LifeOS Vault",
            "path": vault_str,
            "type": "sendreceive",
            "devices": [{ "deviceID": my_device_id, "introducedBy": "", "encryptionPassword": "" }],
            "rescanIntervalS": 60,
            "fsWatcherEnabled": true,
            "fsWatcherDelayS": 1,
            "ignorePerms": false,
            "autoNormalize": true,
            "paused": false
        }));
    }

    api_post(port, key, "/rest/config", &config)
}
