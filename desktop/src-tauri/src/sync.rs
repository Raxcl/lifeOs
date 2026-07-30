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

/// 默认 folder ID（手动配对模式 / 向后兼容）
const DEFAULT_FOLDER_ID: &str = "lifeos-vault";
const GUI_PORT: u16 = 22520;
const STARTUP_WAIT_MS: u64 = 600;
const API_RETRY_COUNT: u32 = 25;
const API_RETRY_INTERVAL_MS: u64 = 400;
/// 放在 Vault 根目录的同步标记文件，会随 Syncthing 同步到所有设备。
/// 新设备只要 Vault 里有此文件就知道应该自动启动同步。
const SYNC_MARKER_FILE: &str = ".lifeos-sync";

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
    /// 当前使用的 Syncthing 文件夹 ID（服务器模式为动态值，手动模式为 DEFAULT_FOLDER_ID）
    folder_id: String,
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

/// 应用启动时调用：如果之前配置过 Syncthing，自动拉起同步服务。
///
/// 判断逻辑（满足任一即自动启动）：
/// 1. 本机 app_config_dir/syncthing/config.xml 存在（本机曾开启过同步）
/// 2. Vault 根目录存在 `.lifeos-sync` 标记文件（其他设备已开启同步并同步过来）
pub fn auto_start_if_configured(app: &tauri::AppHandle) {
    // 等待应用初始化完成
    thread::sleep(Duration::from_secs(2));

    let state = match app.try_state::<SyncState>() {
        Some(s) => s,
        None => return,
    };

    // 解析 Vault 路径（复用主工程的设置）
    // 如果 settings.json 不存在或未配置 vault_dir，回退到默认数据目录
    let vault_path = resolve_vault_path(app);
    let vault_path = match vault_path {
        Some(p) => p,
        None => return,
    };

    // 判断是否应该自动启动同步
    let config_dir = match app.path().app_config_dir() {
        Ok(dir) => dir.join("syncthing"),
        Err(_) => return,
    };
    let has_local_config = config_dir.join("config.xml").exists();
    let has_sync_marker = vault_path.join(SYNC_MARKER_FILE).exists();

    if !has_local_config && !has_sync_marker {
        // 本机从未开启同步，且 Vault 中也没有同步标记 → 用户未使用过同步功能
        return;
    }

    let folder_id = resolve_sync_folder_id(app);
    if let Err(e) = start_syncthing(app, &state, &vault_path, &folder_id) {
        log::warn!("自动恢复同步服务失败：{e}");
    } else {
        log::info!("同步服务已自动恢复");
    }
}

/// 解析 Vault 路径：优先 settings.json 中的配置，回退到默认数据目录。
fn resolve_vault_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    // 1. 环境变量覆盖
    if let Ok(value) = std::env::var("LIFEOS_VAULT_DIR") {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return Some(std::path::PathBuf::from(value));
        }
    }
    // 2. settings.json 配置
    if let Ok(dir) = app.path().app_config_dir() {
        let settings_file = dir.join("settings.json");
        if let Some(v) = fs::read_to_string(&settings_file)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|json| json.get("vault_dir").and_then(|v| v.as_str()).map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
        {
            return Some(std::path::PathBuf::from(v));
        }
    }
    // 3. 默认路径
    app.path().app_data_dir().ok().map(|d| d.join("LifeOS-Vault"))
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
    /// idle / scanning / syncing / error
    pub folder_state: String,
    /// 待同步文件数
    pub need_files: u64,
    /// 待同步字节数
    pub need_bytes: u64,
    /// 已同步文件数
    pub in_sync_files: u64,
}

#[derive(Serialize, Clone)]
pub struct SyncDevice {
    pub id: String,
    pub name: String,
    pub connected: bool,
    /// 同步完成度 0-100
    pub completion: f64,
    /// 入站速率 bytes/s
    pub in_bps: f64,
    /// 出站速率 bytes/s
    pub out_bps: f64,
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

fn api_put(port: u16, key: &str, path: &str, body: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(body).map_err(|e| format!("序列化请求失败：{e}"))?;
    ureq::put(&format!("{}{path}", api_base(port)))
        .set("X-API-Key", key)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(10))
        .send_string(&json)
        .map_err(|e| format!("Syncthing API 请求失败：{e}"))?;
    Ok(())
}

fn api_post(port: u16, key: &str, path: &str, body: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(body).map_err(|e| format!("序列化请求失败：{e}"))?;
    ureq::post(&format!("{}{path}", api_base(port)))
        .set("X-API-Key", key)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(10))
        .send_string(&json)
        .map_err(|e| format!("Syncthing API 请求失败：{e}"))?;
    Ok(())
}

fn api_delete(port: u16, key: &str, path: &str) -> Result<(), String> {
    ureq::delete(&format!("{}{path}", api_base(port)))
        .set("X-API-Key", key)
        .timeout(Duration::from_secs(10))
        .call()
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
    folder_id: &str,
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
                                configure_vault_folder(port, &existing_key, id, vault_path, folder_id)?;
                                *guard = Some(RunningSyncthing {
                                    child: None,
                                    port,
                                    api_key: existing_key,
                                    device_id: id.to_string(),
                                    folder_id: folder_id.to_string(),
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

    // 7. 自动配置 Vault 同步文件夹（内部已确保标记文件存在）
    configure_vault_folder(port, &api_key, &device_id, vault_path, folder_id)?;

    // 8. 保存运行状态
    *guard = Some(RunningSyncthing {
        child: Some(child),
        port,
        api_key,
        device_id: device_id.clone(),
        folder_id: folder_id.to_string(),
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

/// 日记本路径变更时调用：热更新 Syncthing 同步文件夹指向新路径。
/// 如果 Syncthing 未运行则静默跳过。
pub fn notify_vault_path_changed(state: &SyncState, new_vault_path: &Path) {
    let guard = match state.inner.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let running = match guard.as_ref() {
        Some(r) => r,
        None => return, // 同步未运行，无需处理
    };
    let port = running.port;
    let key = running.api_key.clone();
    let device_id = running.device_id.clone();
    let folder_id = running.folder_id.clone();
    drop(guard);

    if let Err(e) = configure_vault_folder(port, &key, &device_id, new_vault_path, &folder_id) {
        log::warn!("更新同步文件夹路径失败：{e}");
    } else {
        log::info!("同步文件夹路径已更新为：{}", new_vault_path.display());
    }
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
                folder_state: String::new(),
                need_files: 0,
                need_bytes: 0,
                in_sync_files: 0,
            })
        }
    };

    let port = running.port;
    let key = &running.api_key;
    let my_id = running.device_id.clone();
    let folder_id = running.folder_id.clone();

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
                    completion: 0.0,
                    in_bps: 0.0,
                    out_bps: 0.0,
                })
                .collect()
        })
        .unwrap_or_default();

    // 查询连接状态与传输速率
    let mut devices = devices;
    if let Ok(conns) = api_get(port, key, "/rest/system/connections") {
        for dev in &mut devices {
            if let Some(conn) = conns.get("connections").and_then(|c| c.get(&dev.id)) {
                dev.connected = conn.get("connected").and_then(|c| c.as_bool()).unwrap_or(false);
                dev.in_bps = conn.get("inBitsPerSecond").and_then(|v| v.as_f64()).unwrap_or(0.0) / 8.0;
                dev.out_bps = conn.get("outBitsPerSecond").and_then(|v| v.as_f64()).unwrap_or(0.0) / 8.0;
            }
            // 查询对该设备的同步完成度
            if dev.connected {
                if let Ok(comp) = api_get(port, key, &format!("/rest/db/completion?folder={folder_id}&device={}", dev.id)) {
                    dev.completion = comp.get("completion").and_then(|v| v.as_f64()).unwrap_or(0.0);
                }
            }
        }
    }

    // 查询文件夹状态
    let (folder_ok, folder_state, need_files, need_bytes, in_sync_files) =
        api_get(port, key, &format!("/rest/db/status?folder={folder_id}"))
            .map(|s| {
                let state = s.get("state").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                let ok = state == "idle" || state == "scanning" || state == "syncing";
                (
                    ok,
                    state,
                    s.get("needFiles").and_then(|v| v.as_u64()).unwrap_or(0)
                        + s.get("needDirectories").and_then(|v| v.as_u64()).unwrap_or(0),
                    s.get("needBytes").and_then(|v| v.as_u64()).unwrap_or(0),
                    s.get("inSyncFiles").and_then(|v| v.as_u64()).unwrap_or(0),
                )
            })
            .unwrap_or((false, "unknown".to_string(), 0, 0, 0));

    Ok(SyncStatus {
        running: true,
        device_id: my_id,
        devices,
        folder_ok,
        folder_state,
        need_files,
        need_bytes,
        in_sync_files,
    })
}

#[tauri::command]
pub fn start_sync(
    app: tauri::AppHandle,
    state: tauri::State<SyncState>,
    vault_path: String,
) -> Result<String, String> {
    let path = Path::new(&vault_path);
    // 读取服务器配置的 folder_id，否则用默认值
    let folder_id = resolve_sync_folder_id(&app);
    start_syncthing(&app, &state, path, &folder_id)
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
    // 把新设备加入 Vault 文件夹（文件夹级 API）
    let folder_id = running.folder_id.clone();
    drop(guard);

    if device_id == my_id {
        return Err("不能添加自己为本机设备".to_string());
    }

    // 检查设备是否已存在（设备级 API）
    let device_url = format!("/rest/config/devices/{device_id}");
    let check = ureq::get(&format!("{}{device_url}", api_base(port)))
        .set("X-API-Key", &key)
        .timeout(Duration::from_secs(5))
        .call();
    if check.is_ok() {
        return Err("该设备已配对，无需重复添加".to_string());
    }

    // 添加设备（设备级 API，不影响其他配置）
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
        "autoAcceptFolders": true,
        "maxSendKbps": 0,
        "maxRecvKbps": 0,
        "maxRequestKiB": 0,
        "untrusted": false,
        "remoteGUIPort": 0
    });
    api_post(port, &key, "/rest/config/devices", &new_device)?;

    // 把新设备加入 Vault 文件夹（文件夹级 API）
    let folder_url = format!("/rest/config/folders/{folder_id}");
    if let Ok(folder_resp) = ureq::get(&format!("{}{folder_url}", api_base(port)))
        .set("X-API-Key", &key)
        .timeout(Duration::from_secs(5))
        .call()
    {
        if let Ok(text) = folder_resp.into_string() {
            if let Ok(mut folder) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(devs) = folder.get_mut("devices").and_then(|d| d.as_array_mut()) {
                    let already = devs.iter().any(|d| {
                        d.get("deviceID").and_then(|id| id.as_str()) == Some(device_id.as_str())
                    });
                    if !already {
                        devs.push(serde_json::json!({
                            "deviceID": device_id,
                            "introducedBy": "",
                            "encryptionPassword": ""
                        }));
                    }
                }
                let _ = api_put(port, &key, &folder_url, &folder);
            }
        }
    }

    Ok(format!("已添加设备「{name}」。请在对方设备上也输入本机设备码完成配对，之后数据将自动同步。"))
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
    let folder_id = running.folder_id.clone();
    drop(guard);

    // 删除设备（设备级 API）
    let device_url = format!("/rest/config/devices/{device_id}");
    api_delete(port, &key, &device_url)?;

    // 从 Vault 文件夹中移除该设备（文件夹级 API）
    let folder_url = format!("/rest/config/folders/{folder_id}");
    if let Ok(folder_resp) = ureq::get(&format!("{}{folder_url}", api_base(port)))
        .set("X-API-Key", &key)
        .timeout(Duration::from_secs(5))
        .call()
    {
        if let Ok(text) = folder_resp.into_string() {
            if let Ok(mut folder) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(devs) = folder.get_mut("devices").and_then(|d| d.as_array_mut()) {
                    devs.retain(|d| {
                        d.get("deviceID").and_then(|id| id.as_str()) != Some(device_id.as_str())
                    });
                }
                let _ = api_put(port, &key, &folder_url, &folder);
            }
        }
    }

    Ok("已移除该设备".to_string())
}

// ---------------------------------------------------------------------------
// 同步事件查询
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SyncEvent {
    /// 事件时间（ISO 格式）
    pub time: String,
    /// 事件类型：file_synced / device_connected / device_disconnected / state_changed / folder_error
    pub kind: String,
    /// 人类可读描述
    pub description: String,
}

/// 查询最近的同步事件（最多 50 条）。
#[tauri::command]
pub fn get_sync_events(state: tauri::State<SyncState>) -> Result<Vec<SyncEvent>, String> {
    let guard = state.inner.lock().map_err(|_| "同步状态锁异常".to_string())?;
    let running = match guard.as_ref() {
        Some(r) => r,
        None => return Ok(vec![]),
    };
    let port = running.port;
    let key = running.api_key.clone();
    drop(guard);

    // 拉取最近事件（limit 调大，避免设备连接事件把文件事件挤出窗口）
    let events = api_get(port, &key, "/rest/events?limit=500")?;
    let arr = match events.as_array() {
        Some(a) => a,
        None => return Ok(vec![]),
    };

    let mut result: Vec<SyncEvent> = Vec::new();
    // 记录上一条设备连接事件，用于去除频繁重连产生的刷屏
    let mut last_device_event: Option<(String, String)> = None;

    for ev in arr.iter().rev() {
        if result.len() >= 50 {
            break;
        }
        let ev_type = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let time = ev.get("time").and_then(|t| t.as_str()).unwrap_or("").to_string();
        let data = ev.get("data").cloned().unwrap_or(serde_json::Value::Null);

        match ev_type {
            // 本地文件变更并被索引 → 即将上传到云端（data.filenames 带文件名）
            "LocalIndexUpdated" => {
                let names: Vec<String> = data
                    .get("filenames")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|n| n.as_str())
                            .filter(|p| !p.ends_with(SYNC_MARKER_FILE) && !p.contains("~syncthing~"))
                            .map(|p| file_name_from_path(p))
                            .collect()
                    })
                    .unwrap_or_default();
                if names.is_empty() {
                    continue;
                }
                let desc = if names.len() == 1 {
                    format!("已上传：{}", names[0])
                } else {
                    let shown = names.iter().take(3).cloned().collect::<Vec<_>>().join("、");
                    format!("已上传：{shown} 等 {} 个文件", names.len())
                };
                result.push(SyncEvent { time, kind: "file_synced".to_string(), description: desc });
            }
            // 收到远端索引更新 → 云端有变更同步到本机（data 只有数量，无文件名）
            "RemoteIndexUpdated" => {
                let items = data.get("items").and_then(|v| v.as_u64()).unwrap_or(0);
                if items == 0 {
                    continue;
                }
                let desc = if items == 1 {
                    "从云端同步了 1 个文件".to_string()
                } else {
                    format!("从云端同步了 {items} 个文件")
                };
                result.push(SyncEvent { time, kind: "file_synced".to_string(), description: desc });
            }
            "DeviceConnected" => {
                let name = data.get("deviceName").and_then(|v| v.as_str()).unwrap_or("未知设备").to_string();
                // 去除连续重复的连接事件（频繁重连刷屏）
                if let Some((ref prev_kind, ref prev_name)) = last_device_event {
                    if prev_kind == "device_connected" && *prev_name == name {
                        continue;
                    }
                }
                last_device_event = Some(("device_connected".to_string(), name.clone()));
                result.push(SyncEvent {
                    time,
                    kind: "device_connected".to_string(),
                    description: format!("设备「{name}」已连接"),
                });
            }
            "DeviceDisconnected" => {
                let id = data.get("device").and_then(|v| v.as_str()).unwrap_or("");
                let short_id = &id[..id.len().min(7)];
                if let Some((ref prev_kind, ref prev_name)) = last_device_event {
                    if prev_kind == "device_disconnected" && *prev_name == short_id {
                        continue;
                    }
                }
                last_device_event = Some(("device_disconnected".to_string(), short_id.to_string()));
                result.push(SyncEvent {
                    time,
                    kind: "device_disconnected".to_string(),
                    description: format!("设备 {short_id}… 已断开"),
                });
            }
            "StateChanged" => {
                let to = data.get("to").and_then(|v| v.as_str()).unwrap_or("");
                if to == "error" {
                    let err = data.get("error").and_then(|v| v.as_str()).unwrap_or("未知错误");
                    result.push(SyncEvent {
                        time,
                        kind: "folder_error".to_string(),
                        description: format!("同步错误：{err}"),
                    });
                }
            }
            _ => {}
        }
    }

    Ok(result)
}

/// 从路径中提取文件/文件夹名。
fn file_name_from_path(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    if name.is_empty() { path.to_string() } else { name.to_string() }
}

// ---------------------------------------------------------------------------
// 服务器模式（注册/登录 + 自动配置）
// ---------------------------------------------------------------------------

/// 从 settings.json 读取服务器配置的 folder_id，否则返回默认值。
fn resolve_sync_folder_id(app: &tauri::AppHandle) -> String {
    if let Ok(dir) = app.path().app_config_dir() {
        let settings_file = dir.join("settings.json");
        if let Some(v) = fs::read_to_string(&settings_file)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|json| json.get("sync_folder_id").and_then(|v| v.as_str()).map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
        {
            return v;
        }
    }
    DEFAULT_FOLDER_ID.to_string()
}

/// 从 settings.json 读取服务器 API 配置。
fn read_sync_account(app: &tauri::AppHandle) -> Option<(String, String, String, String, String)> {
    let dir = app.path().app_config_dir().ok()?;
    let raw = fs::read_to_string(dir.join("settings.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let url = json.get("sync_server_url")?.as_str()?.to_string();
    let token = json.get("sync_token")?.as_str()?.to_string();
    let folder_id = json.get("sync_folder_id")?.as_str()?.to_string();
    let server_device_id = json.get("sync_server_device_id")?.as_str()?.to_string();
    let username = json.get("sync_username").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if url.is_empty() || token.is_empty() {
        return None;
    }
    Some((url, token, folder_id, server_device_id, username))
}

/// 将服务器配置写入 settings.json。
fn write_sync_account(
    app: &tauri::AppHandle,
    url: &str,
    token: &str,
    folder_id: &str,
    server_device_id: &str,
    username: &str,
) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("无法定位配置目录：{e}"))?;
    let path = dir.join("settings.json");
    let mut json: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    json["sync_server_url"] = serde_json::Value::String(url.to_string());
    json["sync_token"] = serde_json::Value::String(token.to_string());
    json["sync_folder_id"] = serde_json::Value::String(folder_id.to_string());
    json["sync_server_device_id"] = serde_json::Value::String(server_device_id.to_string());
    json["sync_username"] = serde_json::Value::String(username.to_string());
    let content = serde_json::to_string_pretty(&json).map_err(|e| format!("序列化配置失败：{e}"))?;
    fs::write(&path, content).map_err(|e| format!("保存配置失败：{e}"))
}

/// 清除 settings.json 中的服务器配置。
fn clear_sync_account(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("无法定位配置目录：{e}"))?;
    let path = dir.join("settings.json");
    let mut json: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    for key in ["sync_server_url", "sync_token", "sync_folder_id", "sync_server_device_id", "sync_username"] {
        if let Some(obj) = json.as_object_mut() {
            obj.remove(key);
        }
    }
    let content = serde_json::to_string_pretty(&json).map_err(|e| format!("序列化配置失败：{e}"))?;
    fs::write(&path, content).map_err(|e| format!("保存配置失败：{e}"))
}

#[derive(Serialize)]
pub struct SyncAccount {
    pub connected: bool,
    pub server_url: String,
    pub username: String,
    pub folder_id: String,
}

/// 查询当前服务器账号信息。
#[tauri::command]
pub fn get_sync_account(app: tauri::AppHandle) -> Result<SyncAccount, String> {
    match read_sync_account(&app) {
        Some((url, _token, folder_id, _sid, username)) => Ok(SyncAccount {
            connected: true,
            server_url: url,
            username,
            folder_id,
        }),
        None => Ok(SyncAccount {
            connected: false,
            server_url: String::new(),
            username: String::new(),
            folder_id: String::new(),
        }),
    }
}

/// 连接同步服务器：注册/登录 → 配置本地 Syncthing → 添加服务器设备 → 注册本机设备。
#[tauri::command]
pub fn connect_to_server(
    app: tauri::AppHandle,
    state: tauri::State<SyncState>,
    server_url: String,
    username: String,
    password: String,
    register: bool,
    vault_path: String,
) -> Result<String, String> {
    let server_url = server_url.trim().trim_end_matches('/').to_string();
    let username = username.trim().to_string();
    if server_url.is_empty() || username.is_empty() || password.is_empty() {
        return Err("请填写完整的服务器地址、用户名和密码".to_string());
    }

    // 1. 注册或登录
    let endpoint = if register { "/api/register" } else { "/api/login" };
    let body = serde_json::json!({ "username": username, "password": password });
    let resp = ureq::post(&format!("{server_url}{endpoint}"))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(10))
        .send_string(&body.to_string());

    let account_json: serde_json::Value = match resp {
        Ok(r) => {
            let text = r.into_string().map_err(|e| format!("读取服务器响应失败：{e}"))?;
            serde_json::from_str(&text).map_err(|e| format!("解析服务器响应失败：{e}"))?
        }
        Err(ureq::Error::Status(code, r)) => {
            let msg = r.into_string().ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|j| j.get("error").and_then(|e| e.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| format!("服务器返回错误 {code}"));
            return Err(msg);
        }
        Err(e) => return Err(format!("连接服务器失败：{e}")),
    };

    // 检查服务器返回的错误
    if let Some(err) = account_json.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }

    let token = account_json.get("token").and_then(|v| v.as_str()).ok_or("服务器未返回 token")?;
    let folder_id = account_json.get("folder_id").and_then(|v| v.as_str()).ok_or("服务器未返回 folder_id")?;
    let server_device_id = account_json.get("server_device_id").and_then(|v| v.as_str()).ok_or("服务器未返回设备 ID")?;

    // 2. 保存到 settings.json
    write_sync_account(&app, &server_url, token, folder_id, server_device_id, &username)?;

    // 3. 启动本地 Syncthing
    let vault = Path::new(&vault_path);
    let device_id = start_syncthing(&app, &state, vault, folder_id)?;

    // 4. 添加服务器为设备
    let guard = state.inner.lock().map_err(|_| "同步状态锁异常".to_string())?;
    let running = guard.as_ref().ok_or("Syncthing 未运行")?;
    let port = running.port;
    let key = running.api_key.clone();
    drop(guard);

    // 从 server_url 推导 Syncthing 同步地址（API 端口 8385 → 同步端口 22000）
    let sync_addr = server_url
        .replace(":8385", ":22000")
        .replace("http://", "tcp://")
        .replace("https://", "tcp://");
    let sync_addr = if sync_addr.contains("://") { sync_addr } else { format!("tcp://{sync_addr}") };

    let server_device = serde_json::json!({
        "deviceID": server_device_id,
        "name": "LifeOS Server",
        "addresses": [sync_addr],
        "compression": "metadata",
        "introducer": false,
        "autoAcceptFolders": false
    });
    // 忽略“已存在”错误
    let _ = api_post(port, &key, "/rest/config/devices", &server_device);

    // 把服务器加入本地文件夹
    let folder_url = format!("/rest/config/folders/{folder_id}");
    if let Ok(resp) = ureq::get(&format!("{}{folder_url}", api_base(port)))
        .set("X-API-Key", &key)
        .timeout(Duration::from_secs(5))
        .call()
    {
        if let Ok(text) = resp.into_string() {
            if let Ok(mut folder) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(devs) = folder.get_mut("devices").and_then(|d| d.as_array_mut()) {
                    let already = devs.iter().any(|d| {
                        d.get("deviceID").and_then(|id| id.as_str()) == Some(server_device_id)
                    });
                    if !already {
                        devs.push(serde_json::json!({
                            "deviceID": server_device_id,
                            "introducedBy": "",
                            "encryptionPassword": ""
                        }));
                    }
                }
                let _ = api_put(port, &key, &folder_url, &folder);
            }
        }
    }

    // 5. 向服务器注册本机设备
    let reg_device_body = serde_json::json!({
        "device_id": device_id,
        "device_name": hostname_or_default()
    });
    let _ = ureq::post(&format!("{server_url}/api/device"))
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(10))
        .send_string(&reg_device_body.to_string());

    Ok(format!("已连接服务器，账号「{username}」。数据将自动同步。"))
}

/// 断开服务器连接：移除服务器设备 + 清除配置。
#[tauri::command]
pub fn disconnect_server(
    app: tauri::AppHandle,
    state: tauri::State<SyncState>,
) -> Result<String, String> {
    // 读取服务器设备 ID
    let server_device_id = read_sync_account(&app).map(|(_, _, _, sid, _)| sid);

    // 从 Syncthing 移除服务器设备
    if let Some(sid) = &server_device_id {
        let guard = state.inner.lock().map_err(|_| "同步状态锁异常".to_string())?;
        if let Some(running) = guard.as_ref() {
            let port = running.port;
            let key = running.api_key.clone();
            let folder_id = running.folder_id.clone();
            drop(guard);
            let _ = api_delete(port, &key, &format!("/rest/config/devices/{sid}"));
            // 从文件夹移除
            let folder_url = format!("/rest/config/folders/{folder_id}");
            if let Ok(resp) = ureq::get(&format!("{}{folder_url}", api_base(port)))
                .set("X-API-Key", &key)
                .timeout(Duration::from_secs(5))
                .call()
            {
                if let Ok(text) = resp.into_string() {
                    if let Ok(mut folder) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(devs) = folder.get_mut("devices").and_then(|d| d.as_array_mut()) {
                            devs.retain(|d| d.get("deviceID").and_then(|id| id.as_str()) != Some(sid.as_str()));
                        }
                        let _ = api_put(port, &key, &folder_url, &folder);
                    }
                }
            }
        }
    }

    // 清除配置
    clear_sync_account(&app)?;
    Ok("已断开服务器连接".to_string())
}

/// 获取本机主机名（用作设备名称）。
fn hostname_or_default() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "我的设备".to_string())
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

/// 确保 Vault 目录存在并创建所有必需的标记文件：
/// - `.stfolder`：Syncthing 文件夹标记，缺失会导致 "folder marker missing" 错误
/// - `.lifeos-sync`：LifeOS 同步标记，其他设备同步到此文件后自动启动同步
fn ensure_vault_markers(vault_path: &Path) {
    let _ = fs::create_dir_all(vault_path);

    let stfolder = vault_path.join(".stfolder");
    if !stfolder.exists() {
        let _ = fs::create_dir_all(&stfolder);
    }

    let sync_marker = vault_path.join(SYNC_MARKER_FILE);
    if !sync_marker.exists() {
        let _ = fs::write(&sync_marker, "lifeos-sync-enabled\n");
    }
}

/// 确保 Vault 文件夹已注册为 Syncthing 共享文件夹。
/// 如果本地 Vault 是空的（新设备加入），设为 receiveonly 防止反向传播删除。
///
/// 使用文件夹级 API（/rest/config/folders/{id}）而非全量配置替换，
/// 避免在 Syncthing 重启过程中因配置未完全加载而丢失设备列表。
fn configure_vault_folder(
    port: u16,
    key: &str,
    my_device_id: &str,
    vault_path: &Path,
    folder_id: &str,
) -> Result<(), String> {
    // 确保 Vault 目录及所有标记文件存在
    ensure_vault_markers(vault_path);

    let vault_str = vault_path
        .to_str()
        .ok_or_else(|| "日记本路径包含无效字符".to_string())?;

    // 判断本地是否已有数据：有 CSV 文件则视为“已有数据设备”
    let has_data = vault_path.join("00-Databases").exists()
        && fs::read_dir(vault_path.join("00-Databases"))
            .map(|mut d| d.any(|e| {
                e.map(|e| {
                    e.path().extension().map(|ext| ext == "csv").unwrap_or(false)
                }).unwrap_or(false)
            }))
            .unwrap_or(false);

    // 新设备（空 Vault）用 receiveonly，防止空状态反向传播删除其他设备的数据
    let folder_type = if has_data { "sendreceive" } else { "receiveonly" };
    let folder_url = format!("/rest/config/folders/{folder_id}");

    // 用文件夹级 API 查询，避免 GET+POST 全量配置导致设备列表丢失
    let resp = ureq::get(&format!("{}{folder_url}", api_base(port)))
        .set("X-API-Key", key)
        .timeout(Duration::from_secs(5))
        .call();

    match resp {
        Ok(response) => {
            // 文件夹已存在 → 只更新路径和类型
            let text = response
                .into_string()
                .map_err(|e| format!("读取 Syncthing 响应失败：{e}"))?;
            let mut folder: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("解析 Syncthing 响应失败：{e}"))?;

            folder["path"] = serde_json::Value::String(vault_str.to_string());
            // 安全策略：已配置为 receiveonly 时绝不自动升级为 sendreceive。
            // 因为设备接收了部分文件后 has_data 会变 true，但其他目录仍可能为空，
            // 此时切换会把“缺失”当作“删除”反向传播到其它设备。
            let current_type = folder.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if current_type != "receiveonly" {
                folder["type"] = serde_json::Value::String(folder_type.to_string());
            }

            api_put(port, key, &folder_url, &folder)
        }
        Err(ureq::Error::Status(404, _)) => {
            // 文件夹不存在 → 新建（仅包含自身设备）
            let new_folder = serde_json::json!({
                "id": folder_id,
                "label": "LifeOS Vault",
                "path": vault_str,
                "type": folder_type,
                "devices": [{ "deviceID": my_device_id, "introducedBy": "", "encryptionPassword": "" }],
                "rescanIntervalS": 60,
                "fsWatcherEnabled": true,
                "fsWatcherDelayS": 1,
                "ignorePerms": false,
                "autoNormalize": true,
                "paused": false,
                "versioning": {
                    "type": "simple",
                    "params": { "keep": "5", "cleanoutDays": "30" },
                    "cleanupIntervalS": 3600
                }
            });
            api_post(port, key, "/rest/config/folders", &new_folder)
        }
        Err(e) => Err(format!("请求 Syncthing API 失败：{e}")),
    }
}
