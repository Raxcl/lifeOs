mod sync;

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FilePath};

const VAULT_ENV_VAR: &str = "LIFEOS_VAULT_DIR";
const DEFAULT_VISUAL_TEMPLATE_ID: &str = "template-1";
const APP_ICON: tauri::image::Image<'static> = tauri::include_image!("icons/icon.png");
const ICON_STAMP: &str = env!("LIFEOS_ICON_STAMP");

#[derive(Serialize, Deserialize, Clone)]
struct VisualTemplate {
    id: String,
    name: String,
    illustration: String,
}

#[derive(Serialize, Deserialize, Default)]
struct AppSettings {
    #[serde(default)]
    vault_dir: Option<String>,
    #[serde(default)]
    app_icon_source: Option<String>,
    #[serde(default)]
    visual_template_id: Option<String>,
    #[serde(default)]
    custom_templates: Vec<VisualTemplate>,
    #[serde(default)]
    journal_images_dir: Option<String>,
    #[serde(default)]
    wallpaper_dir: Option<String>,
}

#[derive(Serialize)]
struct VaultSettings {
    vault_dir: String,
    configured_vault_dir: Option<String>,
    source: String,
    env_override: bool,
    app_icon_source: Option<String>,
    visual_template_id: String,
    visual_templates: Vec<VisualTemplate>,
    journal_images_dir: String,
    configured_journal_images_dir: Option<String>,
    wallpaper_dir: Option<String>,
    configured_wallpaper_dir: Option<String>,
}

#[derive(Serialize)]
struct WallpaperImage {
    path: String,
    name: String,
}

#[derive(Serialize)]
struct JournalEntry {
    date: String,
    path: String,
    title: String,
    day_index: u32,
    updated_at: Option<u64>,
}

#[derive(Serialize)]
struct JournalMonth {
    vault_dir: String,
    entries: Vec<JournalEntry>,
    total_entries: usize,
    next_day_index: u32,
}

#[derive(Serialize)]
struct JournalFile {
    date: String,
    path: String,
    content: String,
    day_index: u32,
    created: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct FrogItem {
    slot: u8,
    text: String,
    done: bool,
    #[serde(default)]
    note: String,
    #[serde(default)]
    created_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct FrogDay {
    date: String,
    items: Vec<FrogItem>,
    updated_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct FrogBacklogItem {
    date: String,
    slot: u8,
    text: String,
    done: bool,
    updated_at: Option<u64>,
    #[serde(default)]
    note: String,
    #[serde(default)]
    created_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct FrogDatabase {
    schema_version: u8,
    days: Vec<FrogDay>,
}

#[derive(Serialize, Deserialize, Clone)]
struct HabitDefinition {
    id: String,
    label: String,
    #[serde(default)]
    created_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct HabitDay {
    date: String,
    checks: HashMap<String, bool>,
    updated_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct HabitDatabase {
    schema_version: u8,
    definitions: Vec<HabitDefinition>,
    days: Vec<HabitDay>,
}

#[derive(Serialize, Deserialize, Clone)]
struct MonthlyItem {
    id: String,
    text: String,
    done: bool,
    #[serde(default)]
    note: String,
    created_at: Option<u64>,
    updated_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct MonthlyRecord {
    month: String,
    items: Vec<MonthlyItem>,
    updated_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct MonthlyBacklogItem {
    month: String,
    id: String,
    text: String,
    done: bool,
    #[serde(default)]
    note: String,
    created_at: Option<u64>,
    updated_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct MonthlyDatabase {
    schema_version: u8,
    months: Vec<MonthlyRecord>,
}

#[derive(Serialize, Deserialize, Clone)]
struct AnnualGoalItem {
    id: String,
    text: String,
    done: bool,
    created_at: Option<u64>,
    updated_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct AnnualGoalRecord {
    year: String,
    items: Vec<AnnualGoalItem>,
    updated_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct AnnualGoalDatabase {
    schema_version: u8,
    years: Vec<AnnualGoalRecord>,
}

#[derive(Serialize)]
struct DatabasePaths {
    frogs: String,
    habits: String,
    monthly: String,
    annual_goals: String,
}

#[derive(Serialize)]
struct JournalDatabases {
    frogs: FrogDay,
    frog_backlog: Vec<FrogBacklogItem>,
    habits: HabitDay,
    habit_definitions: Vec<HabitDefinition>,
    monthly: MonthlyRecord,
    monthly_backlog: Vec<MonthlyBacklogItem>,
    annual_goals: AnnualGoalRecord,
    paths: DatabasePaths,
}

#[derive(Serialize)]
struct JournalDatabaseManager {
    frogs: FrogDatabase,
    habits: HabitDatabase,
    monthly: MonthlyDatabase,
    annual_goals: AnnualGoalDatabase,
    paths: DatabasePaths,
}

struct DailyFile {
    date: String,
    path: PathBuf,
    content: String,
    explicit_day_index: Option<u32>,
}

impl Default for FrogDatabase {
    fn default() -> Self {
        Self {
            schema_version: 1,
            days: Vec::new(),
        }
    }
}

impl Default for HabitDatabase {
    fn default() -> Self {
        Self {
            schema_version: 1,
            definitions: default_habit_definitions(),
            days: Vec::new(),
        }
    }
}

impl Default for MonthlyDatabase {
    fn default() -> Self {
        Self {
            schema_version: 1,
            months: Vec::new(),
        }
    }
}

impl Default for AnnualGoalDatabase {
    fn default() -> Self {
        Self {
            schema_version: 1,
            years: Vec::new(),
        }
    }
}

fn debug_workspace_vault() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir.parent()?.parent()?;
    Some(workspace_root.join("LifeOS-Vault"))
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|err| format!("无法定位应用配置目录：{err}"))?
        .join("settings.json"))
}

fn read_app_settings(app: &tauri::AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let raw = fs::read_to_string(&path).map_err(|err| format!("读取设置失败：{err}"))?;
    if raw.trim().is_empty() {
        return Ok(AppSettings::default());
    }

    serde_json::from_str(&raw).map_err(|err| format!("解析设置失败：{err}"))
}

fn write_app_settings(app: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let content =
        serde_json::to_string_pretty(settings).map_err(|err| format!("序列化设置失败：{err}"))?;
    write_text_file_atomic(&path, &content, "保存设置")
}

fn default_visual_templates() -> Vec<VisualTemplate> {
    vec![VisualTemplate {
        id: DEFAULT_VISUAL_TEMPLATE_ID.to_string(),
        name: "模板 1：晨间花园".to_string(),
        illustration: "assets/晨间日记/少女读书伙伴.png".to_string(),
    }]
}

fn normalize_visual_templates(custom_templates: &[VisualTemplate]) -> Vec<VisualTemplate> {
    let mut templates = default_visual_templates();
    let mut ids: HashSet<String> = templates.iter().map(|item| item.id.clone()).collect();

    for template in custom_templates {
        let id = template.id.trim();
        let name = template.name.trim();
        let illustration = template.illustration.trim();
        if id.is_empty() || name.is_empty() || illustration.is_empty() || ids.contains(id) {
            continue;
        }

        ids.insert(id.to_string());
        templates.push(VisualTemplate {
            id: id.to_string(),
            name: name.to_string(),
            illustration: illustration.to_string(),
        });
    }

    templates
}

fn selected_visual_template_id(settings: &AppSettings, templates: &[VisualTemplate]) -> String {
    let selected = settings
        .visual_template_id
        .as_deref()
        .unwrap_or(DEFAULT_VISUAL_TEMPLATE_ID)
        .trim();

    if templates.iter().any(|template| template.id == selected) {
        selected.to_string()
    } else {
        DEFAULT_VISUAL_TEMPLATE_ID.to_string()
    }
}

fn configured_vault_path(value: &str) -> Result<Option<PathBuf>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("请填写完整的绝对路径，例如 E:\\LifeOS-Vault".to_string());
    }

    Ok(Some(path))
}

fn configured_app_icon_source(value: &str) -> Result<Option<PathBuf>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("请使用完整的绝对路径选择应用图标源图。".to_string());
    }
    if !path.is_file() {
        return Err("没有找到这个应用图标源图文件。".to_string());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    let is_supported = matches!(
        extension.as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("ico")
    );
    if !is_supported {
        return Err("应用图标源图只支持 PNG、JPG、JPEG 或 ICO。".to_string());
    }

    Ok(Some(path))
}

fn dialog_path_to_string(path: FilePath) -> Result<String, String> {
    let path = path
        .into_path()
        .map_err(|err| format!("无法读取选择路径：{err}"))?;
    Ok(path.display().to_string())
}

fn existing_dialog_dir(path: &Path) -> Option<PathBuf> {
    if path.is_dir() {
        return Some(path.to_path_buf());
    }

    path.parent()
        .filter(|parent| parent.is_dir())
        .map(Path::to_path_buf)
}

fn settings_vault_root(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let settings = read_app_settings(app)?;
    match settings.vault_dir {
        Some(value) => configured_vault_path(&value),
        None => Ok(None),
    }
}

fn env_vault_root() -> Option<PathBuf> {
    if let Ok(value) = env::var(VAULT_ENV_VAR) {
        let value = value.trim();
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }

    None
}

fn default_vault_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        if let Some(path) = debug_workspace_vault() {
            return Ok(path);
        }
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("无法定位应用数据目录：{err}"))?;
    Ok(data_dir.join("LifeOS-Vault"))
}

fn vault_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = env_vault_root() {
        return Ok(path);
    }

    if let Some(path) = settings_vault_root(app)? {
        return Ok(path);
    }

    default_vault_root(app)
}

fn ensure_vault_dirs(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|err| format!("创建日记本目录失败：{err}"))?;
    fs::create_dir_all(path.join("00-Databases"))
        .map_err(|err| format!("创建数据库目录失败：{err}"))?;
    fs::create_dir_all(path.join("01-Daily")).map_err(|err| format!("创建日记目录失败：{err}"))?;
    Ok(())
}

fn configured_images_dir(settings: &AppSettings) -> Result<Option<PathBuf>, String> {
    match settings.journal_images_dir.as_deref() {
        Some(value) => configured_vault_path(value),
        None => Ok(None),
    }
}

fn configured_wallpaper_dir(settings: &AppSettings) -> Result<Option<PathBuf>, String> {
    match settings.wallpaper_dir.as_deref() {
        Some(value) => configured_vault_path(value),
        None => Ok(None),
    }
}

fn images_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let settings = read_app_settings(app)?;
    if let Some(path) = configured_images_dir(&settings)? {
        return Ok(path);
    }
    Ok(vault_root(app)?.join("02-Images"))
}

fn vault_settings(app: &tauri::AppHandle) -> Result<VaultSettings, String> {
    let settings = read_app_settings(app)?;
    let configured = settings
        .vault_dir
        .clone()
        .filter(|value| !value.trim().is_empty());
    let app_icon_source = settings
        .app_icon_source
        .clone()
        .filter(|value| !value.trim().is_empty());
    let visual_templates = normalize_visual_templates(&settings.custom_templates);
    let visual_template_id = selected_visual_template_id(&settings, &visual_templates);
    let journal_images_dir = images_root(app)?.display().to_string();
    let configured_journal_images_dir =
        configured_images_dir(&settings)?.map(|path| path.display().to_string());
    let configured_wallpaper_dir =
        configured_wallpaper_dir(&settings)?.map(|path| path.display().to_string());
    let wallpaper_dir = configured_wallpaper_dir.clone();

    if let Some(path) = env_vault_root() {
        return Ok(VaultSettings {
            vault_dir: path.display().to_string(),
            configured_vault_dir: configured,
            source: "环境变量".to_string(),
            env_override: true,
            app_icon_source: app_icon_source.clone(),
            visual_template_id,
            visual_templates,
            journal_images_dir,
            configured_journal_images_dir,
            wallpaper_dir,
            configured_wallpaper_dir,
        });
    }

    if let Some(path) = settings_vault_root(app)? {
        return Ok(VaultSettings {
            vault_dir: path.display().to_string(),
            configured_vault_dir: Some(path.display().to_string()),
            source: "自定义设置".to_string(),
            env_override: false,
            app_icon_source: app_icon_source.clone(),
            visual_template_id,
            visual_templates,
            journal_images_dir,
            configured_journal_images_dir,
            wallpaper_dir,
            configured_wallpaper_dir,
        });
    }

    let path = default_vault_root(app)?;
    Ok(VaultSettings {
        vault_dir: path.display().to_string(),
        configured_vault_dir: configured,
        source: if cfg!(debug_assertions) {
            "开发目录".to_string()
        } else {
            "应用数据目录".to_string()
        },
        env_override: false,
        app_icon_source,
        visual_template_id,
        visual_templates,
        journal_images_dir,
        configured_journal_images_dir,
        wallpaper_dir,
        configured_wallpaper_dir,
    })
}

fn databases_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(vault_root(app)?.join("00-Databases"))
}

fn database_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let dir = databases_dir(app)?;
    Ok((
        dir.join("frogs.csv"),
        dir.join("habits.csv"),
        dir.join("monthly-important.csv"),
        dir.join("annual-goals.csv"),
    ))
}

fn database_path_labels(frogs: &Path, habits: &Path, monthly: &Path, annual_goals: &Path) -> DatabasePaths {
    DatabasePaths {
        frogs: frogs.display().to_string(),
        habits: habits.display().to_string(),
        monthly: monthly.display().to_string(),
        annual_goals: annual_goals.display().to_string(),
    }
}

fn ensure_database_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "无法定位数据库目录".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("创建数据库目录失败：{err}"))
}

fn backup_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("lifeos-data");
    path.with_file_name(format!("{file_name}.bak"))
}

fn temp_write_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("lifeos-data");
    path.with_file_name(format!(".{file_name}.{}.tmp", write_nonce()))
}

fn replace_file_with_temp(path: &Path, temp_path: &Path, context: &str) -> Result<(), String> {
    match fs::rename(temp_path, path) {
        Ok(()) => Ok(()),
        Err(first_err) if path.exists() => {
            fs::remove_file(path).map_err(|err| {
                let _ = fs::remove_file(temp_path);
                format!("{context}失败：替换旧文件失败：{err}")
            })?;
            fs::rename(temp_path, path).map_err(|err| {
                let _ = fs::remove_file(temp_path);
                format!("{context}失败：{err}；初次替换失败：{first_err}")
            })
        }
        Err(err) => {
            let _ = fs::remove_file(temp_path);
            Err(format!("{context}失败：{err}"))
        }
    }
}

fn write_text_file_atomic(path: &Path, content: &str, context: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{context}失败：无法定位目标目录"))?;
    fs::create_dir_all(parent).map_err(|err| format!("{context}失败：创建目录失败：{err}"))?;

    let temp_path = temp_write_path(path);
    if temp_path.exists() {
        fs::remove_file(&temp_path)
            .map_err(|err| format!("{context}失败：清理临时文件失败：{err}"))?;
    }

    fs::write(&temp_path, content).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        format!("{context}失败：写入临时文件失败：{err}")
    })?;

    if path.exists() {
        fs::copy(path, backup_path(path)).map_err(|err| {
            let _ = fs::remove_file(&temp_path);
            format!("{context}失败：创建备份失败：{err}")
        })?;
    }

    replace_file_with_temp(path, &temp_path, context)
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn write_csv(path: &Path, headers: &[&str], rows: Vec<Vec<String>>) -> Result<(), String> {
    ensure_database_parent(path)?;
    let mut output = String::new();
    output.push_str(&headers.join(","));
    output.push('\n');
    for row in rows {
        let escaped = row
            .iter()
            .map(|value| csv_escape(value))
            .collect::<Vec<_>>()
            .join(",");
        output.push_str(&escaped);
        output.push('\n');
    }
    write_text_file_atomic(path, &output, "写入 CSV 数据库")
}

fn parse_csv_records(raw: &str) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut chars = raw.chars().peekable();
    let mut in_quotes = false;

    while let Some(char) = chars.next() {
        match char {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' => {
                in_quotes = !in_quotes;
            }
            ',' if !in_quotes => {
                record.push(field);
                field = String::new();
            }
            '\n' if !in_quotes => {
                record.push(field);
                field = String::new();
                records.push(record);
                record = Vec::new();
            }
            '\r' if !in_quotes => {}
            _ => field.push(char),
        }
    }

    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }

    records
}

fn read_csv(path: &Path, headers: &[&str]) -> Result<Vec<HashMap<String, String>>, String> {
    if !path.exists() {
        write_csv(path, headers, Vec::new())?;
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(path).map_err(|err| format!("读取 CSV 数据库失败：{err}"))?;
    if raw.trim().is_empty() {
        write_csv(path, headers, Vec::new())?;
        return Ok(Vec::new());
    }

    let records = parse_csv_records(&raw);
    let Some(header_record) = records.first() else {
        return Ok(Vec::new());
    };
    let header_names: Vec<String> = header_record
        .iter()
        .map(|header| header.trim().to_string())
        .collect();
    let mut rows = Vec::new();

    for record in records.into_iter().skip(1) {
        if record.iter().all(|value| value.trim().is_empty()) {
            continue;
        }

        let mut row = HashMap::new();
        for (index, header) in header_names.iter().enumerate() {
            row.insert(
                header.clone(),
                record.get(index).cloned().unwrap_or_default(),
            );
        }
        rows.push(row);
    }

    Ok(rows)
}

fn csv_cell(row: &HashMap<String, String>, key: &str) -> String {
    row.get(key)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn parse_csv_bool(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "yes" | "1" | "y" | "x" | "done"
    ) || matches!(value.trim(), "是" | "已完成" | "完成")
}

fn bool_csv(value: bool) -> String {
    if value {
        "Yes".to_string()
    } else {
        "No".to_string()
    }
}

fn parse_optional_u64(value: &str) -> Option<u64> {
    value.trim().parse::<u64>().ok()
}

fn timestamp_csv(value: Option<u64>) -> String {
    value
        .map(|timestamp| timestamp.to_string())
        .unwrap_or_default()
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn write_nonce() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

fn month_key(date: &str) -> Result<String, String> {
    let (year, month, _) = parse_date(date)?;
    Ok(format!("{year}-{month}"))
}

fn parse_month(month: &str) -> Result<(), String> {
    let parts: Vec<&str> = month.split('-').collect();
    if parts.len() != 2 {
        return Err("月份格式应为 YYYY-MM".to_string());
    }

    let year = parts[0];
    let month = parts[1];
    let valid = year.len() == 4
        && month.len() == 2
        && year.chars().all(|char| char.is_ascii_digit())
        && month.chars().all(|char| char.is_ascii_digit());

    if !valid {
        return Err("月份格式应为 YYYY-MM".to_string());
    }

    let month_num: u32 = month
        .parse()
        .map_err(|_| "月份格式应为 YYYY-MM".to_string())?;
    if !(1..=12).contains(&month_num) {
        return Err("月份应在 01 到 12 之间".to_string());
    }

    Ok(())
}

fn default_habit_definitions() -> Vec<HabitDefinition> {
    vec![
        HabitDefinition {
            id: "habit-journal".to_string(),
            label: "写了晨间日记".to_string(),
            created_at: None,
        },
        HabitDefinition {
            id: "habit-focus".to_string(),
            label: "推进了核心任务".to_string(),
            created_at: None,
        },
        HabitDefinition {
            id: "habit-review".to_string(),
            label: "晚上做了简短回看".to_string(),
            created_at: None,
        },
    ]
}

fn normalize_frog_items(items: Vec<FrogItem>) -> Vec<FrogItem> {
    let mut by_slot: HashMap<u8, FrogItem> = HashMap::new();
    for item in items {
        if (1..=3).contains(&item.slot) {
            by_slot.insert(
                item.slot,
                FrogItem {
                    slot: item.slot,
                    text: item.text.trim().to_string(),
                    done: item.done,
                    note: item.note.trim().to_string(),
                    created_at: item.created_at,
                },
            );
        }
    }

    (1..=3)
        .map(|slot| {
            by_slot.remove(&slot).unwrap_or(FrogItem {
                slot,
                text: String::new(),
                done: false,
                note: String::new(),
                created_at: None,
            })
        })
        .collect()
}

fn normalize_frog_days(days: Vec<FrogDay>, now: u64) -> Result<Vec<FrogDay>, String> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();

    for day in days {
        parse_date(&day.date)?;
        if !seen.insert(day.date.clone()) {
            continue;
        }

        normalized.push(FrogDay {
            date: day.date,
            items: normalize_frog_items(day.items),
            updated_at: Some(now),
        });
    }

    normalized.sort_by(|left, right| left.date.cmp(&right.date));
    Ok(normalized)
}

fn normalize_habit_definitions(
    definitions: Vec<HabitDefinition>,
    now: u64,
) -> Vec<HabitDefinition> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();

    for (index, definition) in definitions.into_iter().enumerate() {
        let label = definition.label.trim().to_string();
        if label.is_empty() {
            continue;
        }

        let mut id = definition.id.trim().to_string();
        if id.is_empty() {
            id = format!("habit-{}-{now}", index + 1);
        }
        if !seen.insert(id.clone()) {
            id = format!("{id}-{}", index + 1);
            seen.insert(id.clone());
        }

        normalized.push(HabitDefinition { id, label, created_at: definition.created_at.or(Some(now)) });
    }

    if normalized.is_empty() {
        default_habit_definitions()
    } else {
        normalized
    }
}

fn normalize_habit_days(
    days: Vec<HabitDay>,
    definitions: &[HabitDefinition],
    now: u64,
) -> Result<Vec<HabitDay>, String> {
    let definition_ids: HashSet<String> = definitions
        .iter()
        .map(|definition| definition.id.clone())
        .collect();
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();

    for day in days {
        parse_date(&day.date)?;
        if !seen.insert(day.date.clone()) {
            continue;
        }

        let checks = day
            .checks
            .into_iter()
            .filter(|(id, _)| definition_ids.contains(id))
            .collect();

        normalized.push(HabitDay {
            date: day.date,
            checks,
            updated_at: Some(now),
        });
    }

    normalized.sort_by(|left, right| left.date.cmp(&right.date));
    Ok(normalized)
}

fn normalize_monthly_records(
    records: Vec<MonthlyRecord>,
    now: u64,
) -> Result<Vec<MonthlyRecord>, String> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();

    for record in records {
        parse_month(&record.month)?;
        if !seen.insert(record.month.clone()) {
            continue;
        }

        let items = normalize_monthly_items(&record.month, record.items, now);
        if items.is_empty() {
            continue;
        }

        normalized.push(MonthlyRecord {
            month: record.month,
            items,
            updated_at: Some(now),
        });
    }

    normalized.sort_by(|left, right| left.month.cmp(&right.month));
    Ok(normalized)
}

fn normalize_monthly_items(month: &str, items: Vec<MonthlyItem>, now: u64) -> Vec<MonthlyItem> {
    items
        .into_iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let text = item.text.trim().to_string();
            if text.is_empty() {
                return None;
            }

            let id = if item.id.trim().is_empty() {
                format!("{month}-{}-{now}", index + 1)
            } else {
                item.id
            };

            Some(MonthlyItem {
                id,
                text,
                done: item.done,
                note: item.note,
                created_at: item.created_at.or(Some(now)),
                updated_at: Some(now),
            })
        })
        .collect()
}

fn collect_frog_backlog(days: &[FrogDay]) -> Vec<FrogBacklogItem> {
    let mut backlog = Vec::new();
    for day in days {
        for item in &day.items {
            let text = item.text.trim();
            if text.is_empty() || item.done {
                continue;
            }

            backlog.push(FrogBacklogItem {
                date: day.date.clone(),
                slot: item.slot,
                text: text.to_string(),
                done: false,
                updated_at: day.updated_at,
                note: item.note.clone(),
                created_at: item.created_at,
            });
        }
    }

    backlog.sort_by(|left, right| left.date.cmp(&right.date).then(left.slot.cmp(&right.slot)));
    backlog
}

fn apply_frog_backlog(
    days: &mut Vec<FrogDay>,
    backlog: Vec<FrogBacklogItem>,
    now: u64,
) -> Result<(), String> {
    for item in backlog {
        parse_date(&item.date)?;
        if !(1..=3).contains(&item.slot) {
            continue;
        }

        let text = item.text.trim().to_string();
        if text.is_empty() {
            continue;
        }

        if !days.iter().any(|day| day.date == item.date) {
            days.push(FrogDay {
                date: item.date.clone(),
                items: normalize_frog_items(Vec::new()),
                updated_at: Some(now),
            });
        }

        if let Some(day) = days.iter_mut().find(|day| day.date == item.date) {
            let note = item.note.trim().to_string();
            if let Some(frog) = day.items.iter_mut().find(|frog| frog.slot == item.slot) {
                let changed = frog.text != text || frog.done != item.done || frog.note != note;
                frog.text = text;
                frog.done = item.done;
                frog.note = note;
                if frog.created_at.is_none() {
                    frog.created_at = item.created_at;
                }
                if changed {
                    day.updated_at = Some(now);
                }
            } else {
                day.updated_at = Some(now);
            }
        }
    }

    days.sort_by(|left, right| left.date.cmp(&right.date));
    Ok(())
}

fn collect_monthly_backlog(records: &[MonthlyRecord]) -> Vec<MonthlyBacklogItem> {
    let mut backlog = Vec::new();
    for record in records {
        for item in &record.items {
            let text = item.text.trim();
            if text.is_empty() || item.done {
                continue;
            }

            backlog.push(MonthlyBacklogItem {
                month: record.month.clone(),
                id: item.id.clone(),
                text: text.to_string(),
                done: false,
                note: item.note.clone(),
                created_at: item.created_at,
                updated_at: item.updated_at.or(record.updated_at),
            });
        }
    }

    backlog.sort_by(|left, right| {
        left.month
            .cmp(&right.month)
            .then(left.text.cmp(&right.text))
    });
    backlog
}

fn apply_monthly_backlog(
    records: &mut Vec<MonthlyRecord>,
    backlog: Vec<MonthlyBacklogItem>,
    now: u64,
) -> Result<(), String> {
    for item in backlog {
        parse_month(&item.month)?;

        let text = item.text.trim().to_string();
        if text.is_empty() {
            continue;
        }

        if !records.iter().any(|record| record.month == item.month) {
            records.push(MonthlyRecord {
                month: item.month.clone(),
                items: Vec::new(),
                updated_at: Some(now),
            });
        }

        if let Some(record) = records.iter_mut().find(|record| record.month == item.month) {
            let id = if item.id.trim().is_empty() {
                format!("{}-{}-{now}", item.month, record.items.len() + 1)
            } else {
                item.id.clone()
            };

            let note = item.note.trim().to_string();
            if let Some(existing) = record.items.iter_mut().find(|existing| existing.id == id) {
                let changed = existing.text != text || existing.done != item.done || existing.note != note;
                existing.text = text;
                existing.done = item.done;
                existing.note = note;
                if changed {
                    existing.updated_at = Some(now);
                    record.updated_at = Some(now);
                }
            } else {
                record.items.push(MonthlyItem {
                    id,
                    text,
                    done: item.done,
                    note,
                    created_at: item.created_at.or(Some(now)),
                    updated_at: Some(now),
                });
                record.updated_at = Some(now);
            }
        }
    }

    records.sort_by(|left, right| left.month.cmp(&right.month));
    Ok(())
}

const FROG_CSV_HEADERS: &[&str] = &["date", "slot", "text", "done", "note", "created_at", "updated_at"];
const HABIT_CSV_HEADERS: &[&str] = &["date", "habit_id", "habit_name", "checked", "created_at", "updated_at"];
const MONTHLY_CSV_HEADERS: &[&str] = &[
    "month",
    "item_id",
    "text",
    "done",
    "note",
    "created_at",
    "updated_at",
];
const ANNUAL_GOAL_CSV_HEADERS: &[&str] = &[
    "year",
    "item_id",
    "text",
    "done",
    "created_at",
    "updated_at",
];

fn read_frog_database(path: &Path) -> Result<FrogDatabase, String> {
    let rows = read_csv(path, FROG_CSV_HEADERS)?;
    let mut by_date: HashMap<String, Vec<FrogItem>> = HashMap::new();
    let mut updated_at: HashMap<String, u64> = HashMap::new();

    for row in rows {
        let date = csv_cell(&row, "date");
        parse_date(&date)?;
        let slot = csv_cell(&row, "slot").parse::<u8>().unwrap_or(0);
        if !(1..=3).contains(&slot) {
            continue;
        }

        if let Some(timestamp) = parse_optional_u64(&csv_cell(&row, "updated_at")) {
            updated_at
                .entry(date.clone())
                .and_modify(|value| *value = (*value).max(timestamp))
                .or_insert(timestamp);
        }

        by_date.entry(date).or_default().push(FrogItem {
            slot,
            text: csv_cell(&row, "text"),
            done: parse_csv_bool(&csv_cell(&row, "done")),
            note: csv_cell(&row, "note"),
            created_at: parse_optional_u64(&csv_cell(&row, "created_at")),
        });
    }

    let mut days = by_date
        .into_iter()
        .map(|(date, items)| FrogDay {
            updated_at: updated_at.get(&date).copied(),
            date,
            items: normalize_frog_items(items),
        })
        .collect::<Vec<_>>();
    days.sort_by(|left, right| left.date.cmp(&right.date));

    Ok(FrogDatabase {
        schema_version: 1,
        days,
    })
}

fn write_frog_database(path: &Path, database: &FrogDatabase) -> Result<(), String> {
    let mut rows = Vec::new();
    for day in &database.days {
        for item in normalize_frog_items(day.items.clone()) {
            rows.push(vec![
                day.date.clone(),
                item.slot.to_string(),
                item.text,
                bool_csv(item.done),
                item.note,
                timestamp_csv(item.created_at),
                timestamp_csv(day.updated_at),
            ]);
        }
    }
    write_csv(path, FROG_CSV_HEADERS, rows)
}

fn read_habit_database(path: &Path) -> Result<HabitDatabase, String> {
    let rows = read_csv(path, HABIT_CSV_HEADERS)?;
    let mut definitions = Vec::new();
    let mut seen_definitions = HashSet::new();
    let mut day_map: HashMap<String, HashMap<String, bool>> = HashMap::new();
    let mut updated_at: HashMap<String, u64> = HashMap::new();

    for row in rows {
        let habit_id = csv_cell(&row, "habit_id");
        if habit_id.is_empty() {
            continue;
        }

        let habit_name = csv_cell(&row, "habit_name");
        if !habit_name.is_empty() && seen_definitions.insert(habit_id.clone()) {
            definitions.push(HabitDefinition {
                id: habit_id.clone(),
                label: habit_name,
                created_at: parse_optional_u64(&csv_cell(&row, "created_at")),
            });
        }

        let date = csv_cell(&row, "date");
        if date.is_empty() {
            continue;
        }

        parse_date(&date)?;
        day_map
            .entry(date.clone())
            .or_default()
            .insert(habit_id, parse_csv_bool(&csv_cell(&row, "checked")));

        if let Some(timestamp) = parse_optional_u64(&csv_cell(&row, "updated_at")) {
            updated_at
                .entry(date)
                .and_modify(|value| *value = (*value).max(timestamp))
                .or_insert(timestamp);
        }
    }

    let definitions = if definitions.is_empty() {
        default_habit_definitions()
    } else {
        definitions
    };

    let mut days = day_map
        .into_iter()
        .map(|(date, checks)| HabitDay {
            updated_at: updated_at.get(&date).copied(),
            date,
            checks,
        })
        .collect::<Vec<_>>();
    days.sort_by(|left, right| left.date.cmp(&right.date));

    Ok(HabitDatabase {
        schema_version: 1,
        definitions,
        days,
    })
}

fn write_habit_database(path: &Path, database: &HabitDatabase) -> Result<(), String> {
    let mut rows = Vec::new();
    for definition in &database.definitions {
        rows.push(vec![
            String::new(),
            definition.id.clone(),
            definition.label.clone(),
            String::new(),
            timestamp_csv(definition.created_at),
            String::new(),
        ]);
    }

    for day in &database.days {
        for definition in &database.definitions {
            rows.push(vec![
                day.date.clone(),
                definition.id.clone(),
                definition.label.clone(),
                bool_csv(day.checks.get(&definition.id).copied().unwrap_or(false)),
                timestamp_csv(definition.created_at),
                timestamp_csv(day.updated_at),
            ]);
        }
    }

    write_csv(path, HABIT_CSV_HEADERS, rows)
}

fn read_monthly_database(path: &Path) -> Result<MonthlyDatabase, String> {
    let rows = read_csv(path, MONTHLY_CSV_HEADERS)?;
    let now = now_seconds();
    let mut by_month: HashMap<String, Vec<MonthlyItem>> = HashMap::new();
    let mut updated_at: HashMap<String, u64> = HashMap::new();

    for (index, row) in rows.into_iter().enumerate() {
        let month = csv_cell(&row, "month");
        parse_month(&month)?;
        let text = csv_cell(&row, "text");
        if text.is_empty() {
            continue;
        }

        let updated = parse_optional_u64(&csv_cell(&row, "updated_at"));
        if let Some(timestamp) = updated {
            updated_at
                .entry(month.clone())
                .and_modify(|value| *value = (*value).max(timestamp))
                .or_insert(timestamp);
        }

        by_month
            .entry(month.clone())
            .or_default()
            .push(MonthlyItem {
                id: {
                    let id = csv_cell(&row, "item_id");
                    if id.is_empty() {
                        format!("{month}-{}-{now}", index + 1)
                    } else {
                        id
                    }
                },
                text,
                done: parse_csv_bool(&csv_cell(&row, "done")),
                note: csv_cell(&row, "note"),
                created_at: parse_optional_u64(&csv_cell(&row, "created_at")).or(Some(now)),
                updated_at: updated.or(Some(now)),
            });
    }

    let mut months = by_month
        .into_iter()
        .map(|(month, items)| MonthlyRecord {
            updated_at: updated_at.get(&month).copied(),
            month,
            items,
        })
        .collect::<Vec<_>>();
    months.sort_by(|left, right| left.month.cmp(&right.month));

    Ok(MonthlyDatabase {
        schema_version: 1,
        months,
    })
}

fn write_monthly_database(path: &Path, database: &MonthlyDatabase) -> Result<(), String> {
    let mut rows = Vec::new();
    for record in &database.months {
        for item in &record.items {
            rows.push(vec![
                record.month.clone(),
                item.id.clone(),
                item.text.clone(),
                bool_csv(item.done),
                item.note.clone(),
                timestamp_csv(item.created_at),
                timestamp_csv(item.updated_at.or(record.updated_at)),
            ]);
        }
    }
    write_csv(path, MONTHLY_CSV_HEADERS, rows)
}

fn year_key(date: &str) -> Result<String, String> {
    let (year, _, _) = parse_date(date)?;
    Ok(year)
}

fn parse_year(year: &str) -> Result<(), String> {
    if year.len() != 4 || !year.chars().all(|char| char.is_ascii_digit()) {
        return Err("年份格式应为 YYYY".to_string());
    }
    Ok(())
}

fn read_annual_goal_database(path: &Path) -> Result<AnnualGoalDatabase, String> {
    let rows = read_csv(path, ANNUAL_GOAL_CSV_HEADERS)?;
    let now = now_seconds();
    let mut by_year: HashMap<String, Vec<AnnualGoalItem>> = HashMap::new();
    let mut updated_at: HashMap<String, u64> = HashMap::new();

    for (index, row) in rows.into_iter().enumerate() {
        let year = csv_cell(&row, "year");
        parse_year(&year)?;
        let item_id = csv_cell(&row, "item_id");

        // Year metadata row — preserves updated_at for years with 0 items
        if item_id == "__YEAR__" {
            let updated = parse_optional_u64(&csv_cell(&row, "updated_at"));
            if let Some(timestamp) = updated {
                updated_at
                    .entry(year.clone())
                    .and_modify(|value| *value = (*value).max(timestamp))
                    .or_insert(timestamp);
            }
            by_year.entry(year.clone()).or_default();
            continue;
        }

        let text = csv_cell(&row, "text");
        if text.is_empty() {
            continue;
        }

        let updated = parse_optional_u64(&csv_cell(&row, "updated_at"));
        if let Some(timestamp) = updated {
            updated_at
                .entry(year.clone())
                .and_modify(|value| *value = (*value).max(timestamp))
                .or_insert(timestamp);
        }

        by_year
            .entry(year.clone())
            .or_default()
            .push(AnnualGoalItem {
                id: {
                    if item_id.is_empty() {
                        format!("{year}-{}-{now}", index + 1)
                    } else {
                        item_id
                    }
                },
                text,
                done: parse_csv_bool(&csv_cell(&row, "done")),
                created_at: parse_optional_u64(&csv_cell(&row, "created_at")).or(Some(now)),
                updated_at: updated.or(Some(now)),
            });
    }

    let mut years = by_year
        .into_iter()
        .map(|(year, items)| AnnualGoalRecord {
            updated_at: updated_at.get(&year).copied(),
            year,
            items,
        })
        .collect::<Vec<_>>();
    years.sort_by(|left, right| left.year.cmp(&right.year));

    Ok(AnnualGoalDatabase {
        schema_version: 1,
        years,
    })
}

fn write_annual_goal_database(path: &Path, database: &AnnualGoalDatabase) -> Result<(), String> {
    let mut rows = Vec::new();
    for record in &database.years {
        // Always write a year metadata row to preserve updated_at through CSV round-trips
        rows.push(vec![
            record.year.clone(),
            "__YEAR__".to_string(),
            String::new(),
            String::new(),
            String::new(),
            timestamp_csv(record.updated_at),
        ]);
        for item in &record.items {
            rows.push(vec![
                record.year.clone(),
                item.id.clone(),
                item.text.clone(),
                bool_csv(item.done),
                timestamp_csv(item.created_at),
                timestamp_csv(item.updated_at.or(record.updated_at)),
            ]);
        }
    }
    write_csv(path, ANNUAL_GOAL_CSV_HEADERS, rows)
}

fn parse_date(date: &str) -> Result<(String, String, String), String> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return Err("日期格式应为 YYYY-MM-DD".to_string());
    }

    let year = parts[0];
    let month = parts[1];
    let day = parts[2];

    let valid = year.len() == 4
        && month.len() == 2
        && day.len() == 2
        && year.chars().all(|char| char.is_ascii_digit())
        && month.chars().all(|char| char.is_ascii_digit())
        && day.chars().all(|char| char.is_ascii_digit());

    if !valid {
        return Err("日期格式应为 YYYY-MM-DD".to_string());
    }

    Ok((year.to_string(), month.to_string(), day.to_string()))
}

fn daily_path(app: &tauri::AppHandle, date: &str) -> Result<PathBuf, String> {
    let (year, month, _) = parse_date(date)?;
    Ok(vault_root(app)?
        .join("01-Daily")
        .join(year)
        .join(month)
        .join(format!("{date}.md")))
}

fn default_template(date: &str, day_index: u32) -> String {
    format!(
        r#"---
type: daily
date: {date}
day_index: {day_index}
tags:
  - daily
  - morning
---

# 第 {day_index} 天

## 今天是什么日子


## 今天最重要的三件事

1. 
2. 
3. 

## 我现在的状态


## 今天想成为怎样的人


## 今天要避免什么


## 今日待办

- [ ] 

## 晚间回看


"#
    )
}

fn day_title(day_index: u32) -> String {
    format!("第 {day_index} 天")
}

fn is_legacy_title(title: &str, date: &str) -> bool {
    title == format!("{date} 晨间日记") || title.ends_with("晨间日记")
}

fn modified_seconds(path: &PathBuf) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    if !content.starts_with("---") {
        return None;
    }

    let end = content.find("\n---")?;
    content[3..end].lines().find_map(|line| {
        let (left, right) = line.split_once(':')?;
        if left.trim() == key {
            Some(right.trim().to_string())
        } else {
            None
        }
    })
}

fn day_index_from_content(content: &str) -> Option<u32> {
    frontmatter_value(content, "day_index")
        .or_else(|| frontmatter_value(content, "day"))
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
}

fn collect_daily_files(root: &Path) -> Result<Vec<DailyFile>, String> {
    let daily_dir = root.join("01-Daily");
    if !daily_dir.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    for year_entry in fs::read_dir(&daily_dir).map_err(|err| format!("读取日记目录失败：{err}"))?
    {
        let year_entry = year_entry.map_err(|err| format!("读取日记目录失败：{err}"))?;
        let year_path = year_entry.path();
        if !year_path.is_dir() {
            continue;
        }

        for month_entry in
            fs::read_dir(&year_path).map_err(|err| format!("读取日记目录失败：{err}"))?
        {
            let month_entry = month_entry.map_err(|err| format!("读取日记目录失败：{err}"))?;
            let month_path = month_entry.path();
            if !month_path.is_dir() {
                continue;
            }

            for file_entry in
                fs::read_dir(&month_path).map_err(|err| format!("读取日记目录失败：{err}"))?
            {
                let file_entry = file_entry.map_err(|err| format!("读取日记文件失败：{err}"))?;
                let path = file_entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("md") {
                    continue;
                }

                let Some(date) = path.file_stem().and_then(|value| value.to_str()) else {
                    continue;
                };

                if parse_date(date).is_err() {
                    continue;
                }

                let content = fs::read_to_string(&path).unwrap_or_default();
                let explicit_day_index = day_index_from_content(&content);
                files.push(DailyFile {
                    date: date.to_string(),
                    path,
                    content,
                    explicit_day_index,
                });
            }
        }
    }

    files.sort_by(|left, right| left.date.cmp(&right.date));
    Ok(files)
}

fn assigned_day_indices(files: &[DailyFile]) -> HashMap<String, u32> {
    let mut result = HashMap::new();
    let mut used = HashSet::new();

    for file in files {
        if let Some(index) = file.explicit_day_index {
            result.insert(file.date.clone(), index);
            used.insert(index);
        }
    }

    let mut next = 1;
    for file in files {
        if result.contains_key(&file.date) {
            continue;
        }

        while used.contains(&next) {
            next += 1;
        }

        result.insert(file.date.clone(), next);
        used.insert(next);
    }

    result
}

fn inferred_day_index(files: &[DailyFile], date: &str) -> u32 {
    assigned_day_indices(files)
        .get(date)
        .copied()
        .unwrap_or_else(|| next_day_index(files))
}

fn next_day_index(files: &[DailyFile]) -> u32 {
    assigned_day_indices(files)
        .values()
        .copied()
        .max()
        .unwrap_or(0)
        + 1
}

fn title_from_content(content: &str, date: &str, day_index: u32) -> String {
    let title = content
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("# "))
        .map(|line| line.trim_start_matches("# ").to_string());

    match title {
        Some(title) if !is_legacy_title(&title, date) => title,
        _ => day_title(day_index),
    }
}

#[tauri::command]
fn get_vault_settings(app: tauri::AppHandle) -> Result<VaultSettings, String> {
    vault_settings(&app)
}

#[tauri::command]
async fn pick_vault_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title("选择日记本位置");
    if let Ok(path) = vault_root(&app) {
        if let Some(start_dir) = existing_dialog_dir(&path) {
            dialog = dialog.set_directory(start_dir);
        }
    }

    match dialog.blocking_pick_folder() {
        Some(path) => dialog_path_to_string(path).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
async fn pick_app_icon_source(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Select app icon source")
        .add_filter("Images and icons", &["png", "jpg", "jpeg", "ico"]);

    if let Ok(settings) = read_app_settings(&app) {
        if let Some(source) = settings.app_icon_source.as_deref() {
            let path = PathBuf::from(source.trim());
            if let Some(start_dir) = existing_dialog_dir(&path) {
                dialog = dialog.set_directory(start_dir);
            }
        }
    }

    match dialog.blocking_pick_file() {
        Some(path) => dialog_path_to_string(path).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
fn set_vault_dir(app: tauri::AppHandle, path: String) -> Result<VaultSettings, String> {
    let path =
        configured_vault_path(&path)?.ok_or_else(|| "请填写日记本目录的完整路径".to_string())?;
    ensure_vault_dirs(&path)?;
    let mut settings = read_app_settings(&app)?;
    settings.vault_dir = Some(path.display().to_string());
    write_app_settings(&app, &settings)?;
    // 通知正在运行的 Syncthing 更新同步文件夹路径
    if let Some(state) = app.try_state::<sync::SyncState>() {
        sync::notify_vault_path_changed(&state, &path);
    }
    vault_settings(&app)
}

#[tauri::command]
fn reset_vault_dir(app: tauri::AppHandle) -> Result<VaultSettings, String> {
    let mut settings = read_app_settings(&app)?;
    settings.vault_dir = None;
    write_app_settings(&app, &settings)?;
    // 通知正在运行的 Syncthing 更新为默认路径
    if let Some(state) = app.try_state::<sync::SyncState>() {
        if let Ok(default_path) = default_vault_root(&app) {
            sync::notify_vault_path_changed(&state, &default_path);
        }
    }
    vault_settings(&app)
}

#[tauri::command]
fn set_app_icon_source(app: tauri::AppHandle, path: String) -> Result<VaultSettings, String> {
    let path =
        configured_app_icon_source(&path)?.ok_or_else(|| "请选择应用图标源图。".to_string())?;
    let mut settings = read_app_settings(&app)?;
    settings.app_icon_source = Some(path.display().to_string());
    write_app_settings(&app, &settings)?;
    vault_settings(&app)
}

#[tauri::command]
fn reset_app_icon_source(app: tauri::AppHandle) -> Result<VaultSettings, String> {
    let mut settings = read_app_settings(&app)?;
    settings.app_icon_source = None;
    write_app_settings(&app, &settings)?;
    vault_settings(&app)
}

#[tauri::command]
async fn pick_journal_images_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title("选择日记图片目录");
    if let Ok(path) = images_root(&app) {
        if let Some(start_dir) = existing_dialog_dir(&path) {
            dialog = dialog.set_directory(start_dir);
        }
    }

    match dialog.blocking_pick_folder() {
        Some(path) => dialog_path_to_string(path).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
fn set_journal_images_dir(app: tauri::AppHandle, path: String) -> Result<VaultSettings, String> {
    let path =
        configured_vault_path(&path)?.ok_or_else(|| "请填写图片目录的完整路径".to_string())?;
    fs::create_dir_all(&path).map_err(|err| format!("创建图片目录失败：{err}"))?;
    let mut settings = read_app_settings(&app)?;
    settings.journal_images_dir = Some(path.display().to_string());
    write_app_settings(&app, &settings)?;
    vault_settings(&app)
}

#[tauri::command]
fn reset_journal_images_dir(app: tauri::AppHandle) -> Result<VaultSettings, String> {
    let mut settings = read_app_settings(&app)?;
    settings.journal_images_dir = None;
    write_app_settings(&app, &settings)?;
    vault_settings(&app)
}

fn is_wallpaper_image(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    matches!(
        extension.as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("webp") | Some("gif") | Some("bmp")
    )
}

fn collect_wallpaper_images(root: &Path) -> Result<Vec<WallpaperImage>, String> {
    if !root.is_dir() {
        return Err("没有找到这个应用背景目录。".to_string());
    }

    let mut folders = vec![root.to_path_buf()];
    let mut images = Vec::new();

    while let Some(folder) = folders.pop() {
        let entries =
            fs::read_dir(&folder).map_err(|err| format!("读取应用背景目录失败：{err}"))?;
        for entry in entries {
            let entry = entry.map_err(|err| format!("读取应用背景目录失败：{err}"))?;
            let path = entry.path();
            if path.is_dir() {
                folders.push(path);
            } else if path.is_file() && is_wallpaper_image(&path) {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("wallpaper")
                    .to_string();
                images.push(WallpaperImage {
                    path: path.display().to_string(),
                    name,
                });
            }
        }

        if images.len() >= 3000 {
            break;
        }
    }

    images.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(images)
}

#[tauri::command]
async fn pick_wallpaper_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title("选择应用背景目录");
    if let Ok(settings) = read_app_settings(&app) {
        if let Some(path) = configured_wallpaper_dir(&settings)? {
            if let Some(start_dir) = existing_dialog_dir(&path) {
                dialog = dialog.set_directory(start_dir);
            }
        }
    }

    match dialog.blocking_pick_folder() {
        Some(path) => dialog_path_to_string(path).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
async fn pick_wallpaper_image(app: tauri::AppHandle) -> Result<Option<WallpaperImage>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("选择应用背景图片")
        .add_filter("图片", &["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

    if let Ok(settings) = read_app_settings(&app) {
        if let Some(path) = configured_wallpaper_dir(&settings)? {
            if let Some(start_dir) = existing_dialog_dir(&path) {
                dialog = dialog.set_directory(start_dir);
            }
        }
    }

    let Some(picked) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|err| format!("无法读取选择路径：{err}"))?;
    if !path.is_file() || !is_wallpaper_image(&path) {
        return Err("请选择 PNG、JPG、JPEG、WEBP、GIF 或 BMP 图片。".to_string());
    }

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("wallpaper")
        .to_string();

    Ok(Some(WallpaperImage {
        path: path.display().to_string(),
        name,
    }))
}

#[tauri::command]
fn set_wallpaper_dir(app: tauri::AppHandle, path: String) -> Result<VaultSettings, String> {
    let path = configured_vault_path(&path)?
        .ok_or_else(|| "请填写应用背景目录的完整路径。".to_string())?;
    if !path.is_dir() {
        return Err("没有找到这个应用背景目录。".to_string());
    }

    let mut settings = read_app_settings(&app)?;
    settings.wallpaper_dir = Some(path.display().to_string());
    write_app_settings(&app, &settings)?;
    log::info!("application background directory set to {}", path.display());
    vault_settings(&app)
}

#[tauri::command]
fn reset_wallpaper_dir(app: tauri::AppHandle) -> Result<VaultSettings, String> {
    let mut settings = read_app_settings(&app)?;
    settings.wallpaper_dir = None;
    write_app_settings(&app, &settings)?;
    vault_settings(&app)
}

#[tauri::command]
fn list_wallpaper_images(app: tauri::AppHandle) -> Result<Vec<WallpaperImage>, String> {
    let settings = read_app_settings(&app)?;
    let Some(path) = configured_wallpaper_dir(&settings)? else {
        log::info!("application background directory is not configured");
        return Ok(Vec::new());
    };

    let images = collect_wallpaper_images(&path)?;
    log::info!(
        "application background scan found {} images in {}",
        images.len(),
        path.display()
    );
    Ok(images)
}

fn sanitize_image_file_name(name: &str) -> String {
    let trimmed = name.trim();
    let base = trimmed
        .rsplit(|character| character == '/' || character == '\\')
        .next()
        .unwrap_or(trimmed)
        .trim();
    let cleaned: String = base
        .chars()
        .filter(|&character| {
            !matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\u{0}')
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        "image.png".to_string()
    } else {
        cleaned.to_string()
    }
}

#[tauri::command]
async fn save_journal_image_bytes(
    app: tauri::AppHandle,
    date: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let (year, month, _) = parse_date(&date)?;
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }

    let target_dir = images_root(&app)?.join(year).join(month);
    fs::create_dir_all(&target_dir).map_err(|err| format!("创建图片目录失败：{err}"))?;

    let safe_name = sanitize_image_file_name(&file_name);
    let target = target_dir.join(format!("{date}-{}-{safe_name}", write_nonce()));
    fs::write(&target, &bytes).map_err(|err| format!("保存图片失败：{err}"))?;
    Ok(target.display().to_string())
}

#[tauri::command]
async fn pick_journal_image(app: tauri::AppHandle, date: String) -> Result<Option<String>, String> {
    let (year, month, _) = parse_date(&date)?;
    let dialog = app
        .dialog()
        .file()
        .set_title("选择要插入的图片")
        .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

    let Some(picked) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let source = picked
        .into_path()
        .map_err(|err| format!("无法读取选择路径：{err}"))?;

    let target_dir = images_root(&app)?.join(year).join(month);
    fs::create_dir_all(&target_dir).map_err(|err| format!("创建图片目录失败：{err}"))?;

    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image.png");
    let target = target_dir.join(format!("{date}-{}-{file_name}", write_nonce()));
    fs::copy(&source, &target).map_err(|err| format!("复制图片失败：{err}"))?;
    Ok(Some(target.display().to_string()))
}

#[tauri::command]
fn set_visual_template(
    app: tauri::AppHandle,
    template_id: String,
) -> Result<VaultSettings, String> {
    let mut settings = read_app_settings(&app)?;
    let templates = normalize_visual_templates(&settings.custom_templates);
    let template_id = template_id.trim();

    if !templates.iter().any(|template| template.id == template_id) {
        return Err("没有找到这个视觉模板。".to_string());
    }

    settings.visual_template_id = Some(template_id.to_string());
    write_app_settings(&app, &settings)?;
    vault_settings(&app)
}

#[tauri::command]
fn add_visual_template(
    app: tauri::AppHandle,
    name: String,
    illustration: String,
) -> Result<VaultSettings, String> {
    let name = name.trim();
    let illustration = illustration.trim();
    if name.is_empty() {
        return Err("请填写模板名称。".to_string());
    }
    if illustration.is_empty() {
        return Err("请填写插画图片路径。".to_string());
    }

    let mut settings = read_app_settings(&app)?;
    let id = format!(
        "custom-{}-{}",
        now_seconds(),
        settings.custom_templates.len() + 1
    );
    settings.custom_templates.push(VisualTemplate {
        id: id.clone(),
        name: name.to_string(),
        illustration: illustration.to_string(),
    });
    settings.visual_template_id = Some(id);
    write_app_settings(&app, &settings)?;
    vault_settings(&app)
}

#[tauri::command]
async fn get_database_manager(app: tauri::AppHandle) -> Result<JournalDatabaseManager, String> {
    let (frogs_path, habits_path, monthly_path, annual_goals_path) = database_paths(&app)?;
    let mut habits = read_habit_database(&habits_path)?;
    if habits.definitions.is_empty() {
        habits.definitions = default_habit_definitions();
        write_habit_database(&habits_path, &habits)?;
    }

    Ok(JournalDatabaseManager {
        frogs: read_frog_database(&frogs_path)?,
        habits,
        monthly: read_monthly_database(&monthly_path)?,
        annual_goals: read_annual_goal_database(&annual_goals_path)?,
        paths: database_path_labels(&frogs_path, &habits_path, &monthly_path, &annual_goals_path),
    })
}

#[tauri::command]
async fn save_frog_database(
    app: tauri::AppHandle,
    days: Vec<FrogDay>,
) -> Result<FrogDatabase, String> {
    let (frogs_path, _, _, _) = database_paths(&app)?;
    let database = FrogDatabase {
        schema_version: 1,
        days: normalize_frog_days(days, now_seconds())?,
    };
    write_frog_database(&frogs_path, &database)?;
    Ok(database)
}

#[tauri::command]
async fn save_habit_database(
    app: tauri::AppHandle,
    definitions: Vec<HabitDefinition>,
    days: Vec<HabitDay>,
) -> Result<HabitDatabase, String> {
    let (_, habits_path, _, _) = database_paths(&app)?;
    let now = now_seconds();
    let definitions = normalize_habit_definitions(definitions, now);
    let database = HabitDatabase {
        schema_version: 1,
        days: normalize_habit_days(days, &definitions, now)?,
        definitions,
    };
    write_habit_database(&habits_path, &database)?;
    Ok(database)
}

#[tauri::command]
async fn save_monthly_database(
    app: tauri::AppHandle,
    months: Vec<MonthlyRecord>,
) -> Result<MonthlyDatabase, String> {
    let (_, _, monthly_path, _) = database_paths(&app)?;
    let database = MonthlyDatabase {
        schema_version: 1,
        months: normalize_monthly_records(months, now_seconds())?,
    };
    write_monthly_database(&monthly_path, &database)?;
    Ok(database)
}

#[tauri::command]
async fn get_journal_databases(
    app: tauri::AppHandle,
    date: String,
) -> Result<JournalDatabases, String> {
    parse_date(&date)?;
    let month = month_key(&date)?;
    let year = year_key(&date)?;
    let (frogs_path, habits_path, monthly_path, annual_goals_path) = database_paths(&app)?;

    let frogs_db = read_frog_database(&frogs_path)?;
    let habits_db = read_habit_database(&habits_path)?;
    let monthly_db = read_monthly_database(&monthly_path)?;

    let frogs = frogs_db
        .days
        .iter()
        .find(|day| day.date == date)
        .cloned()
        .unwrap_or(FrogDay {
            date: date.clone(),
            items: Vec::new(),
            updated_at: None,
        });

    let habits = habits_db
        .days
        .iter()
        .find(|day| day.date == date)
        .cloned()
        .unwrap_or(HabitDay {
            date: date.clone(),
            checks: HashMap::new(),
            updated_at: None,
        });

    let monthly = monthly_db
        .months
        .iter()
        .find(|record| record.month == month)
        .cloned()
        .unwrap_or(MonthlyRecord {
            month,
            items: Vec::new(),
            updated_at: None,
        });

    let annual_goals_db = read_annual_goal_database(&annual_goals_path)?;
    let annual_goals = annual_goals_db
        .years
        .iter()
        .find(|record| record.year == year)
        .cloned()
        .unwrap_or(AnnualGoalRecord {
            year: year.clone(),
            items: Vec::new(),
            updated_at: None,
        });

    Ok(JournalDatabases {
        frogs,
        frog_backlog: collect_frog_backlog(&frogs_db.days),
        habits,
        habit_definitions: habits_db.definitions,
        monthly,
        monthly_backlog: collect_monthly_backlog(&monthly_db.months),
        annual_goals,
        paths: database_path_labels(&frogs_path, &habits_path, &monthly_path, &annual_goals_path),
    })
}

#[tauri::command]
async fn save_journal_databases(
    app: tauri::AppHandle,
    date: String,
    frogs: Vec<FrogItem>,
    habits: HashMap<String, bool>,
    monthly: Vec<MonthlyItem>,
    frog_backlog: Option<Vec<FrogBacklogItem>>,
    monthly_backlog: Option<Vec<MonthlyBacklogItem>>,
    annual_goals: Option<Vec<AnnualGoalItem>>,
) -> Result<JournalDatabases, String> {
    parse_date(&date)?;
    let month = month_key(&date)?;
    let now = now_seconds();
    let (frogs_path, habits_path, monthly_path, annual_goals_path) = database_paths(&app)?;

    let mut frogs_db = read_frog_database(&frogs_path)?;
    let frog_day = FrogDay {
        date: date.clone(),
        items: normalize_frog_items(frogs),
        updated_at: Some(now),
    };
    frogs_db.days.retain(|day| day.date != date);
    frogs_db.days.push(frog_day.clone());
    frogs_db
        .days
        .sort_by(|left, right| left.date.cmp(&right.date));
    apply_frog_backlog(&mut frogs_db.days, frog_backlog.unwrap_or_default(), now)?;
    write_frog_database(&frogs_path, &frogs_db)?;

    let mut habits_db = read_habit_database(&habits_path)?;
    if habits_db.definitions.is_empty() {
        habits_db.definitions = default_habit_definitions();
    }
    let habit_day = HabitDay {
        date: date.clone(),
        checks: habits,
        updated_at: Some(now),
    };
    habits_db.days.retain(|day| day.date != date);
    habits_db.days.push(habit_day.clone());
    habits_db
        .days
        .sort_by(|left, right| left.date.cmp(&right.date));
    write_habit_database(&habits_path, &habits_db)?;

    let mut monthly_db = read_monthly_database(&monthly_path)?;
    let monthly_record = MonthlyRecord {
        month: month.clone(),
        items: normalize_monthly_items(&month, monthly, now),
        updated_at: Some(now),
    };
    monthly_db.months.retain(|record| record.month != month);
    monthly_db.months.push(monthly_record.clone());
    monthly_db
        .months
        .sort_by(|left, right| left.month.cmp(&right.month));
    apply_monthly_backlog(
        &mut monthly_db.months,
        monthly_backlog.unwrap_or_default(),
        now,
    )?;
    write_monthly_database(&monthly_path, &monthly_db)?;

    let mut annual_goals_db = read_annual_goal_database(&annual_goals_path)?;
    let year = year_key(&date)?;
    log::info!("[save_journal_databases] annual_goals param: {:?} items", annual_goals.as_ref().map(|v| v.len()));
    if let Some(goal_items) = annual_goals {
        let normalized = normalize_annual_goal_items(&year, goal_items, now);
        log::info!("[save_journal_databases] normalized {} annual goal items for year {}", normalized.len(), year);
        let record = AnnualGoalRecord {
            year: year.clone(),
            items: normalized,
            updated_at: Some(now),
        };
        annual_goals_db.years.retain(|r| r.year != year);
        annual_goals_db.years.push(record);
        annual_goals_db
            .years
            .sort_by(|left, right| left.year.cmp(&right.year));
        write_annual_goal_database(&annual_goals_path, &annual_goals_db)?;
    }

    let saved_frogs = frogs_db
        .days
        .iter()
        .find(|day| day.date == date)
        .cloned()
        .unwrap_or(frog_day);
    let saved_monthly = monthly_db
        .months
        .iter()
        .find(|record| record.month == month)
        .cloned()
        .unwrap_or(monthly_record);

    let saved_annual_goals = annual_goals_db
        .years
        .iter()
        .find(|record| record.year == year)
        .cloned()
        .unwrap_or(AnnualGoalRecord {
            year: year.clone(),
            items: Vec::new(),
            updated_at: None,
        });

    Ok(JournalDatabases {
        frogs: saved_frogs,
        frog_backlog: collect_frog_backlog(&frogs_db.days),
        habits: habit_day,
        habit_definitions: habits_db.definitions,
        monthly: saved_monthly,
        monthly_backlog: collect_monthly_backlog(&monthly_db.months),
        annual_goals: saved_annual_goals,
        paths: database_path_labels(&frogs_path, &habits_path, &monthly_path, &annual_goals_path),
    })
}

#[tauri::command]
async fn save_annual_goal_database(
    app: tauri::AppHandle,
    years: Vec<AnnualGoalRecord>,
) -> Result<AnnualGoalDatabase, String> {
    let (_, _, _, annual_goals_path) = database_paths(&app)?;
    let now = now_seconds();
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for record in years {
        parse_year(&record.year)?;
        if !seen.insert(record.year.clone()) {
            continue;
        }
        let items = normalize_annual_goal_items(&record.year, record.items, now);
        normalized.push(AnnualGoalRecord {
            year: record.year,
            items,
            updated_at: Some(now),
        });
    }
    normalized.sort_by(|left, right| left.year.cmp(&right.year));
    let database = AnnualGoalDatabase {
        schema_version: 1,
        years: normalized,
    };
    write_annual_goal_database(&annual_goals_path, &database)?;
    Ok(database)
}

fn normalize_annual_goal_items(year: &str, items: Vec<AnnualGoalItem>, now: u64) -> Vec<AnnualGoalItem> {
    items
        .into_iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let text = item.text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            let id = if item.id.trim().is_empty() {
                format!("{year}-{}-{now}", index + 1)
            } else {
                item.id
            };
            Some(AnnualGoalItem {
                id,
                text,
                done: item.done,
                created_at: item.created_at.or(Some(now)),
                updated_at: Some(now),
            })
        })
        .collect()
}

#[tauri::command]
async fn get_journal_month(
    app: tauri::AppHandle,
    year: i32,
    month: u32,
) -> Result<JournalMonth, String> {
    if !(1..=12).contains(&month) {
        return Err("月份应在 1 到 12 之间".to_string());
    }

    let vault_dir = vault_root(&app)?;
    let month_dir = vault_dir
        .join("01-Daily")
        .join(format!("{year:04}"))
        .join(format!("{month:02}"));

    fs::create_dir_all(&month_dir).map_err(|err| format!("创建日记目录失败：{err}"))?;

    let daily_files = collect_daily_files(&vault_dir)?;
    let total_entries = daily_files.len();
    let next_day_index = next_day_index(&daily_files);
    let day_indices = assigned_day_indices(&daily_files);
    let entries = daily_files
        .iter()
        .filter(|file| file.path.starts_with(&month_dir))
        .map(|file| {
            let day_index = day_indices
                .get(&file.date)
                .copied()
                .unwrap_or(next_day_index);
            JournalEntry {
                date: file.date.clone(),
                path: file.path.display().to_string(),
                title: title_from_content(&file.content, &file.date, day_index),
                day_index,
                updated_at: modified_seconds(&file.path),
            }
        })
        .collect::<Vec<_>>();

    Ok(JournalMonth {
        vault_dir: vault_dir.display().to_string(),
        entries,
        total_entries,
        next_day_index,
    })
}

#[tauri::command]
async fn open_or_create_journal(
    app: tauri::AppHandle,
    date: String,
) -> Result<JournalFile, String> {
    let path = daily_path(&app, &date)?;
    let created = !path.exists();
    let vault_dir = vault_root(&app)?;

    if created {
        let day_index = next_day_index(&collect_daily_files(&vault_dir)?);
        let parent = path
            .parent()
            .ok_or_else(|| "无法定位日记文件夹".to_string())?;
        fs::create_dir_all(parent).map_err(|err| format!("创建日记文件夹失败：{err}"))?;
        write_text_file_atomic(&path, &default_template(&date, day_index), "创建日记")?;
    }

    let content = fs::read_to_string(&path).map_err(|err| format!("读取日记失败：{err}"))?;
    let daily_files = collect_daily_files(&vault_dir)?;
    let day_index = inferred_day_index(&daily_files, &date);

    Ok(JournalFile {
        date,
        path: path.display().to_string(),
        content,
        day_index,
        created,
    })
}

#[tauri::command]
async fn read_journal(app: tauri::AppHandle, date: String) -> Result<Option<JournalFile>, String> {
    let path = daily_path(&app, &date)?;
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path).map_err(|err| format!("读取日记失败：{err}"))?;
    let vault_dir = vault_root(&app)?;
    let daily_files = collect_daily_files(&vault_dir)?;
    let day_index = inferred_day_index(&daily_files, &date);

    Ok(Some(JournalFile {
        date,
        path: path.display().to_string(),
        content,
        day_index,
        created: false,
    }))
}

#[tauri::command]
async fn save_journal(
    app: tauri::AppHandle,
    date: String,
    content: String,
) -> Result<JournalFile, String> {
    let path = daily_path(&app, &date)?;
    let parent = path
        .parent()
        .ok_or_else(|| "无法定位日记文件夹".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("创建日记文件夹失败：{err}"))?;
    write_text_file_atomic(&path, &content, "保存日记")?;
    let vault_dir = vault_root(&app)?;
    let daily_files = collect_daily_files(&vault_dir)?;
    let day_index = inferred_day_index(&daily_files, &date);

    Ok(JournalFile {
        date,
        path: path.display().to_string(),
        content,
        day_index,
        created: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("lifeos-{name}-{}", write_nonce()));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    #[test]
    fn csv_round_trips_commas_quotes_and_newlines() {
        let dir = temp_dir("csv-round-trip");
        let path = dir.join("sample.csv");
        write_csv(
            &path,
            &["name", "note"],
            vec![vec![
                "三只青蛙, 第一只".to_string(),
                "跨行\n备注和\"引号\"".to_string(),
            ]],
        )
        .expect("write csv");

        let rows = read_csv(&path, &["name", "note"]).expect("read csv");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("name").unwrap(), "三只青蛙, 第一只");
        assert_eq!(rows[0].get("note").unwrap(), "跨行\n备注和\"引号\"");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_write_replaces_file_and_keeps_backup() {
        let dir = temp_dir("atomic-write");
        let path = dir.join("2026-06-08.md");

        write_text_file_atomic(&path, "first", "测试写入").expect("first write");
        write_text_file_atomic(&path, "second", "测试写入").expect("second write");

        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(fs::read_to_string(backup_path(&path)).unwrap(), "first");

        let temp_files = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .count();
        assert_eq!(temp_files, 0);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn configured_vault_path_requires_absolute_path() {
        assert!(configured_vault_path("LifeOS-Vault").is_err());
        assert!(configured_vault_path("   ").unwrap().is_none());

        let dir = temp_dir("vault-path");
        let parsed = configured_vault_path(&dir.display().to_string())
            .expect("parse path")
            .expect("path value");
        assert_eq!(parsed, dir);

        let _ = fs::remove_dir_all(parsed);
    }

    #[test]
    fn configured_app_icon_source_accepts_supported_absolute_file() {
        assert!(configured_app_icon_source("icon.png").is_err());
        assert!(configured_app_icon_source("   ").unwrap().is_none());

        let dir = temp_dir("app-icon-source");
        let png = dir.join("icon.PNG");
        let txt = dir.join("icon.txt");
        fs::write(&png, b"not-a-real-png").expect("write png source");
        fs::write(&txt, b"not an icon").expect("write txt source");

        let parsed = configured_app_icon_source(&png.display().to_string())
            .expect("parse icon source")
            .expect("icon source value");
        assert_eq!(parsed, png);
        assert!(configured_app_icon_source(&txt.display().to_string()).is_err());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn frog_backlog_updates_original_date_and_slot() {
        let mut days = vec![FrogDay {
            date: "2026-06-01".to_string(),
            items: normalize_frog_items(vec![FrogItem {
                slot: 2,
                text: "整理开源清单".to_string(),
                done: false,
                note: String::new(),
            }]),
            updated_at: Some(1),
        }];

        apply_frog_backlog(
            &mut days,
            vec![FrogBacklogItem {
                date: "2026-06-01".to_string(),
                slot: 2,
                text: "整理开源清单".to_string(),
                done: true,
                updated_at: Some(1),
                note: String::new(),
            }],
            2,
        )
        .expect("apply backlog");

        let day = days.iter().find(|day| day.date == "2026-06-01").unwrap();
        let frog = day.items.iter().find(|item| item.slot == 2).unwrap();
        assert!(frog.done);
        assert!(collect_frog_backlog(&days).is_empty());
    }

    #[test]
    fn monthly_backlog_updates_original_month_item() {
        let mut records = vec![MonthlyRecord {
            month: "2026-05".to_string(),
            items: vec![MonthlyItem {
                id: "may-open-source".to_string(),
                text: "准备开源发布".to_string(),
                done: false,
                created_at: Some(1),
                updated_at: Some(1),
            }],
            updated_at: Some(1),
        }];

        apply_monthly_backlog(
            &mut records,
            vec![MonthlyBacklogItem {
                month: "2026-05".to_string(),
                id: "may-open-source".to_string(),
                text: "准备开源发布".to_string(),
                done: true,
                created_at: Some(1),
                updated_at: Some(1),
            }],
            2,
        )
        .expect("apply monthly backlog");

        let record = records
            .iter()
            .find(|record| record.month == "2026-05")
            .unwrap();
        let item = record
            .items
            .iter()
            .find(|item| item.id == "may-open-source")
            .unwrap();
        assert!(item.done);
        assert!(collect_monthly_backlog(&records).is_empty());
    }

    #[test]
    fn markdown_frontmatter_drives_day_index_and_title() {
        let content = r#"---
type: daily
date: 2026-06-08
day_index: 42
---

# 第 42 天

## 三只青蛙
"#;

        assert_eq!(day_index_from_content(content), Some(42));
        assert_eq!(title_from_content(content, "2026-06-08", 42), "第 42 天");
        assert_eq!(
            title_from_content("# 2026-06-08 晨间日记\n", "2026-06-08", 42),
            "第 42 天"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(sync::SyncState::new())
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            let _ = ICON_STAMP;
            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = window.set_icon(APP_ICON) {
                    log::warn!("failed to set main window icon: {err}");
                }
                let _ = window.show();
            }

            // 自动恢复同步服务：如果之前配置过 Syncthing，应用启动时自动拉起
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                sync::auto_start_if_configured(&handle);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_vault_settings,
            pick_vault_dir,
            pick_app_icon_source,
            set_vault_dir,
            reset_vault_dir,
            set_app_icon_source,
            reset_app_icon_source,
            pick_journal_images_dir,
            set_journal_images_dir,
            reset_journal_images_dir,
            pick_wallpaper_dir,
            pick_wallpaper_image,
            set_wallpaper_dir,
            reset_wallpaper_dir,
            list_wallpaper_images,
            pick_journal_image,
            save_journal_image_bytes,
            set_visual_template,
            add_visual_template,
            get_database_manager,
            save_frog_database,
            save_habit_database,
            save_monthly_database,
            save_annual_goal_database,
            get_journal_databases,
            save_journal_databases,
            get_journal_month,
            open_or_create_journal,
            read_journal,
            save_journal,
            sync::get_sync_status,
            sync::start_sync,
            sync::stop_sync,
            sync::add_sync_device,
            sync::remove_sync_device,
            sync::get_sync_events,
            sync::get_sync_account,
            sync::connect_to_server,
            sync::disconnect_server
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                sync::cleanup(app_handle);
            }
        });
}
