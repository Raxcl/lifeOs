# 计划事项一张表 + 收集箱 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `monthly-important.csv` 升级成带 `scope/period/parent_id` 的 `items.csv`，日记页「看见未来」变成 周/月/年 三格，新增收集箱页承接未归属与过期未完成事项。

**Architecture:** 后端 Rust（Tauri 2）一张 `PlanItem` 表替代 `MonthlyItem/MonthlyRecord/MonthlyBacklogItem`；日记页按 `scope+period` 过滤出周卡、月卡两个视图，保存走按 id upsert；收集箱页复用 `database-manager.js` 壳做全量替换。前端是无构建的原生 JS，三处（日记页 / 管理页 / 首页）各有一套 localStorage fallback 需同步改。

**Tech Stack:** Rust (Tauri 2, serde, 无 chrono)、原生 HTML/CSS/JS、CSV 文件存储。

**Spec:** `docs/superpowers/specs/2026-10-27-plan-items-inbox-design.md`

## Global Constraints

- 周 key = 该周周一的 `YYYY-MM-DD`（周一到周日为一周）。
- `scope ∈ {inbox, week, month, year}`；`inbox` 的 `period` 必须为空；`year` 只预留不写入。
- 旧 `monthly-important.csv` 原地保留，不再读取，不删除。
- 不保留任何 Monthly* 兼容结构。
- 日记页不能删除事项，删除只在收集箱页。
- Rust 无 chrono 依赖，日期算术手写。
- 所有 Rust 测试用 `cd desktop/src-tauri && cargo test` 跑；前端无测试框架，共享工具函数用 `node -e` 断言。
- 所有命令在仓库根目录 `/Users/raxcl/code/self/lifeOs` 执行。

---

## 文件结构

| 文件 | 职责 | 操作 |
|---|---|---|
| `desktop/app/assets/lifeos-shared.js` | 跨页面纯工具；新增 `weekKey` / `weekRangeLabel` | 修改 |
| `desktop/src-tauri/src/lib.rs` | 数据模型、CSV 读写、Tauri 命令、测试 | 修改（删 Monthly*，加 PlanItem） |
| `desktop/app/晨间日记页面.html` | 日记页 DOM；看见未来三格 | 修改 |
| `desktop/app/assets/晨间日记页面.css` | 删 `.nine-grid.duo` | 修改 |
| `desktop/app/assets/晨间日记页面.js` | 周卡/月卡状态、渲染、保存、fallback、Markdown | 修改 |
| `desktop/app/收集箱.html` | 收集箱页壳（由 `本月重要几件事管理.html` 改名） | git mv + 修改 |
| `desktop/app/assets/database-manager.js` | 管理页逻辑；`monthly` 分支换 `items` | 修改 |
| `desktop/app/index.html` | 首页预览卡；monthly 换 items | 修改 |

---

### Task 1: 共享 `weekKey` / `weekRangeLabel`

**Files:**
- Modify: `desktop/app/assets/lifeos-shared.js:21-30`, `:77-89`

**Interfaces:**
- Produces: `window.LifeOSShared.weekKey(dateKey: "YYYY-MM-DD") => "YYYY-MM-DD"`（该周周一）；`window.LifeOSShared.weekRangeLabel(mondayKey) => "MM.DD–MM.DD"`。

- [ ] **Step 1: 写失败的 node 断言**

```bash
node -e '
globalThis.window = {};
require("./desktop/app/assets/lifeos-shared.js");
const s = window.LifeOSShared;
const eq = (a, b) => { if (a !== b) { console.error("FAIL", a, "!==", b); process.exit(1); } };
eq(s.weekKey("2026-10-26"), "2026-10-26");
eq(s.weekKey("2026-10-27"), "2026-10-26");
eq(s.weekKey("2026-11-01"), "2026-10-26");
eq(s.weekKey("2027-01-01"), "2026-12-28");
eq(s.weekRangeLabel("2026-10-26"), "10.26–11.01");
console.log("OK");
'
```

- [ ] **Step 2: 运行确认失败**

Expected: `TypeError: s.weekKey is not a function`

- [ ] **Step 3: 实现**

在 `isMonthKey` 之后插入：

```js
  function weekKey(value) {
    const date = parseDateKey(value);
    const offsetFromMonday = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - offsetFromMonday);
    return formatDate(date);
  }

  function weekRangeLabel(mondayKey) {
    const start = parseDateKey(mondayKey);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const short = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
    return `${short(start)}–${short(end)}`;
  }
```

在 `window.LifeOSShared = { ... }` 里 `isMonthKey,` 之后加 `weekKey,` 和 `weekRangeLabel,`。

- [ ] **Step 4: 重跑 Step 1 命令**

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add desktop/app/assets/lifeos-shared.js
git commit -m "feat(shared): 新增 weekKey / weekRangeLabel 周一日期工具"
```

---

### Task 2: Rust 数据模型、`week_key`、items.csv 读写与迁移

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`
  - 结构体区 `:224-258`（替换 Monthly* 四个结构）
  - `:1253-1263`（CSV headers）
  - `:1436-1510`（替换 read/write monthly）
  - `:2896+`（tests 模块追加）

**Interfaces:**
- Produces:
  - `struct PlanItem { id, text, done, note, scope, period, parent_id, created_at: Option<u64>, updated_at: Option<u64> }`（全部 `String`/`bool` 字段带 `#[serde(default)]`，前端可少传）
  - `struct PlanItemDatabase { schema_version: u8, items: Vec<PlanItem> }`
  - `const PLAN_ITEM_CSV_HEADERS`
  - `fn week_key(date: &str) -> Result<String, String>`
  - `fn validate_plan_item_scope(scope: &str, period: &str) -> Result<(), String>`
  - `fn read_plan_item_database(path: &Path) -> Result<PlanItemDatabase, String>`（自动迁移同目录 `monthly-important.csv`）
  - `fn write_plan_item_database(path: &Path, db: &PlanItemDatabase) -> Result<(), String>`
  - `fn sort_plan_items(items: &mut Vec<PlanItem>)`

本任务只**新增**；删除 Monthly* 在 Task 3 和命令一起做，保证每步都能编译。

- [ ] **Step 1: 写失败测试**

在 `mod tests` 末尾（`}` 之前）追加：

```rust
    #[test]
    fn week_key_snaps_to_monday() {
        assert_eq!(week_key("2026-10-26").unwrap(), "2026-10-26");
        assert_eq!(week_key("2026-10-27").unwrap(), "2026-10-26");
        assert_eq!(week_key("2026-11-01").unwrap(), "2026-10-26");
        assert_eq!(week_key("2027-01-01").unwrap(), "2026-12-28");
        assert!(week_key("2026-13-01").is_err());
    }

    #[test]
    fn plan_item_scope_validation() {
        assert!(validate_plan_item_scope("inbox", "").is_ok());
        assert!(validate_plan_item_scope("inbox", "2026-10").is_err());
        assert!(validate_plan_item_scope("week", "2026-10-26").is_ok());
        assert!(validate_plan_item_scope("week", "2026-10-27").is_err());
        assert!(validate_plan_item_scope("month", "2026-10").is_ok());
        assert!(validate_plan_item_scope("month", "2026-10-26").is_err());
        assert!(validate_plan_item_scope("year", "2026").is_ok());
        assert!(validate_plan_item_scope("quarter", "2026-Q4").is_err());
    }

    #[test]
    fn plan_item_database_round_trip() {
        let dir = temp_dir("plan-items-rt");
        let path = dir.join("items.csv");
        let db = PlanItemDatabase {
            schema_version: 1,
            items: vec![
                PlanItem {
                    id: "a".into(), text: "周事".into(), done: false, note: "".into(),
                    scope: "week".into(), period: "2026-10-26".into(), parent_id: "m1".into(),
                    created_at: Some(10), updated_at: Some(20),
                },
                PlanItem {
                    id: "b".into(), text: "收集箱".into(), done: true, note: "备注, 带逗号".into(),
                    scope: "inbox".into(), period: "".into(), parent_id: "".into(),
                    created_at: Some(1), updated_at: Some(2),
                },
            ],
        };
        write_plan_item_database(&path, &db).unwrap();
        let read = read_plan_item_database(&path).unwrap();
        assert_eq!(read.items.len(), 2);
        let a = read.items.iter().find(|i| i.id == "a").unwrap();
        assert_eq!(a.scope, "week");
        assert_eq!(a.period, "2026-10-26");
        assert_eq!(a.parent_id, "m1");
        assert_eq!(a.updated_at, Some(20));
        let b = read.items.iter().find(|i| i.id == "b").unwrap();
        assert_eq!(b.note, "备注, 带逗号");
        assert!(b.done);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn plan_item_database_migrates_legacy_monthly() {
        let dir = temp_dir("plan-items-migrate");
        let legacy = dir.join("monthly-important.csv");
        write_csv(
            &legacy,
            &["month", "item_id", "text", "done", "note", "created_at", "updated_at"],
            vec![
                vec!["2026-09".into(), "m-1".into(), "九月事".into(), "false".into(), "".into(), "100".into(), "200".into()],
                vec!["2026-10".into(), "m-2".into(), "十月事".into(), "true".into(), "n".into(), "300".into(), "400".into()],
                vec!["2026-10".into(), "m-3".into(), "".into(), "false".into(), "".into(), "".into(), "".into()],
            ],
        ).unwrap();
        let items_path = dir.join("items.csv");
        let db = read_plan_item_database(&items_path).unwrap();
        assert_eq!(db.items.len(), 2);
        assert!(db.items.iter().all(|i| i.scope == "month"));
        let m1 = db.items.iter().find(|i| i.id == "m-1").unwrap();
        assert_eq!(m1.period, "2026-09");
        assert_eq!(m1.created_at, Some(100));
        assert!(items_path.exists());
        assert!(legacy.exists(), "老文件应原地保留");
        // 第二次读取不再触发迁移、结果一致
        let again = read_plan_item_database(&items_path).unwrap();
        assert_eq!(again.items.len(), 2);
        let _ = fs::remove_dir_all(dir);
    }
```

- [ ] **Step 2: 运行确认编译失败**

Run: `cd desktop/src-tauri && cargo test week_key plan_item 2>&1 | tail -20`
Expected: `cannot find function week_key` 等编译错误。

- [ ] **Step 3: 新增结构体**

在 `struct AnnualGoalItem`（`:260`）**之前**插入：

```rust
#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct PlanItem {
    id: String,
    text: String,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    note: String,
    #[serde(default)]
    scope: String,
    #[serde(default)]
    period: String,
    #[serde(default)]
    parent_id: String,
    #[serde(default)]
    created_at: Option<u64>,
    #[serde(default)]
    updated_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct PlanItemDatabase {
    schema_version: u8,
    items: Vec<PlanItem>,
}
```

- [ ] **Step 4: 新增 `week_key` 与校验**

在 `fn month_key`（`:922`）之前插入：

```rust
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp as i64 + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

fn week_key(date: &str) -> Result<String, String> {
    let (year, month, day) = parse_date(date)?;
    let invalid = || "日期格式应为 YYYY-MM-DD".to_string();
    let year: i64 = year.parse().map_err(|_| invalid())?;
    let month: u32 = month.parse().map_err(|_| invalid())?;
    let day: u32 = day.parse().map_err(|_| invalid())?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(invalid());
    }
    let days = days_from_civil(year, month, day);
    // 1970-01-01 是周四，+3 后对 7 取模使周一为 0
    let offset_from_monday = (days + 3).rem_euclid(7);
    let (y, m, d) = civil_from_days(days - offset_from_monday);
    Ok(format!("{y:04}-{m:02}-{d:02}"))
}

fn validate_plan_item_scope(scope: &str, period: &str) -> Result<(), String> {
    match scope {
        "inbox" => {
            if period.is_empty() { Ok(()) } else { Err("收集箱事项不能带归属期".to_string()) }
        }
        "week" => {
            if week_key(period)? == period { Ok(()) } else { Err("周归属必须是周一日期".to_string()) }
        }
        "month" => parse_month(period),
        "year" => parse_year(period),
        other => Err(format!("未知的事项范围：{other}")),
    }
}
```

> `parse_year` 已存在（年度目标在用）。

- [ ] **Step 5: 新增 headers、读写、迁移、排序**

在 `const ANNUAL_GOAL_CSV_HEADERS`（`:1264`）之后插入：

```rust
const PLAN_ITEM_CSV_HEADERS: &[&str] = &[
    "item_id", "text", "done", "note", "scope", "period", "parent_id", "created_at", "updated_at",
];
const LEGACY_MONTHLY_CSV_HEADERS: &[&str] = &[
    "month", "item_id", "text", "done", "note", "created_at", "updated_at",
];
```

在 `fn read_annual_goal_database`（`:1524`）之前插入：

```rust
fn scope_rank(scope: &str) -> u8 {
    match scope { "year" => 0, "month" => 1, "week" => 2, _ => 3 }
}

fn sort_plan_items(items: &mut Vec<PlanItem>) {
    items.sort_by(|a, b| {
        scope_rank(&a.scope)
            .cmp(&scope_rank(&b.scope))
            .then(a.period.cmp(&b.period))
            .then(a.created_at.cmp(&b.created_at))
            .then(a.id.cmp(&b.id))
    });
}

fn migrate_monthly_to_items(legacy: &Path, target: &Path) -> Result<(), String> {
    let rows = read_csv(legacy, LEGACY_MONTHLY_CSV_HEADERS)?;
    let now = now_seconds();
    let mut items = Vec::new();
    for (index, row) in rows.into_iter().enumerate() {
        let text = csv_cell(&row, "text");
        let month = csv_cell(&row, "month");
        if text.is_empty() || parse_month(&month).is_err() {
            continue;
        }
        let id = csv_cell(&row, "item_id");
        items.push(PlanItem {
            id: if id.is_empty() { format!("{month}-{}-{now}", index + 1) } else { id },
            text,
            done: parse_csv_bool(&csv_cell(&row, "done")),
            note: csv_cell(&row, "note"),
            scope: "month".to_string(),
            period: month,
            parent_id: String::new(),
            created_at: parse_optional_u64(&csv_cell(&row, "created_at")).or(Some(now)),
            updated_at: parse_optional_u64(&csv_cell(&row, "updated_at")).or(Some(now)),
        });
    }
    sort_plan_items(&mut items);
    write_plan_item_database(target, &PlanItemDatabase { schema_version: 1, items })
}

fn read_plan_item_database(path: &Path) -> Result<PlanItemDatabase, String> {
    let legacy = path.with_file_name("monthly-important.csv");
    if !path.exists() && legacy.exists() {
        migrate_monthly_to_items(&legacy, path)?;
    }
    let rows = read_csv(path, PLAN_ITEM_CSV_HEADERS)?;
    let now = now_seconds();
    let mut items = Vec::new();
    for (index, row) in rows.into_iter().enumerate() {
        let text = csv_cell(&row, "text");
        if text.is_empty() {
            continue;
        }
        let scope = {
            let s = csv_cell(&row, "scope");
            if s.is_empty() { "inbox".to_string() } else { s }
        };
        let period = csv_cell(&row, "period");
        validate_plan_item_scope(&scope, &period)?;
        let id = csv_cell(&row, "item_id");
        items.push(PlanItem {
            id: if id.is_empty() { format!("item-{}-{now}", index + 1) } else { id },
            text,
            done: parse_csv_bool(&csv_cell(&row, "done")),
            note: csv_cell(&row, "note"),
            scope,
            period,
            parent_id: csv_cell(&row, "parent_id"),
            created_at: parse_optional_u64(&csv_cell(&row, "created_at")).or(Some(now)),
            updated_at: parse_optional_u64(&csv_cell(&row, "updated_at")).or(Some(now)),
        });
    }
    sort_plan_items(&mut items);
    Ok(PlanItemDatabase { schema_version: 1, items })
}

fn write_plan_item_database(path: &Path, database: &PlanItemDatabase) -> Result<(), String> {
    let rows = database
        .items
        .iter()
        .map(|item| vec![
            item.id.clone(),
            item.text.clone(),
            bool_csv(item.done),
            item.note.clone(),
            item.scope.clone(),
            item.period.clone(),
            item.parent_id.clone(),
            timestamp_csv(item.created_at),
            timestamp_csv(item.updated_at),
        ])
        .collect();
    write_csv(path, PLAN_ITEM_CSV_HEADERS, rows)
}
```

- [ ] **Step 6: 跑测试**

Run: `cd desktop/src-tauri && cargo test week_key plan_item 2>&1 | tail -20`
Expected: 4 个测试 `ok`。会有 `dead_code` warning（命令尚未接入），忽略。

- [ ] **Step 7: Commit**

```bash
git add desktop/src-tauri/src/lib.rs
git commit -m "feat(db): 新增 PlanItem 模型、items.csv 读写与 monthly 迁移"
```

---

### Task 3: Rust 命令切换到 PlanItem，删除 Monthly*

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`
  - `:224-258` 删 `MonthlyItem/MonthlyRecord/MonthlyBacklogItem/MonthlyDatabase`
  - `:282-309` `DatabasePaths` / `JournalDatabases` / `JournalDatabaseManager`
  - `:645-662` `database_paths` / `database_path_labels`
  - `:1046-1084` 删 `normalize_monthly_items_preserve`
  - `:1163-1251` 删 `collect_monthly_backlog` / `apply_monthly_backlog`
  - `:1255-1263` 删 `MONTHLY_CSV_HEADERS`
  - `:1436-1510` 删 `read_monthly_database` / `write_monthly_database`
  - `:2237-2253` `get_database_manager`
  - `:2380-2416` 删 `save_monthly_database`，新增 `save_plan_item_database`
  - `:2418-2487` `get_journal_databases`
  - `:2489-2670` `save_journal_databases`
  - `:3271` `invoke_handler`

**Interfaces:**
- Consumes: Task 2 全部。
- Produces（前端依赖）:
  - `get_journal_databases(date)` 返回 `{ frogs, frog_backlog, habits, habit_definitions, plan_items: PlanItem[], annual_goals, paths: { frogs, habits, items, annual_goals } }`
  - `save_journal_databases({ date, frogs, habits, planItems: PlanItem[], frogBacklog?, annualGoals? })` 同返回体
  - `get_database_manager()` 返回 `{ frogs, habits, items: PlanItemDatabase, annual_goals, paths }`
  - `save_plan_item_database({ items: PlanItem[] }) -> PlanItemDatabase`
  - `fn upsert_plan_items(items: &mut Vec<PlanItem>, incoming: Vec<PlanItem>, now: u64) -> Result<bool, String>`
  - `fn select_journal_plan_items(items: &[PlanItem], week: &str, month: &str) -> Vec<PlanItem>`

- [ ] **Step 1: 写失败测试**

追加到 `mod tests`：

```rust
    fn sample_item(id: &str, scope: &str, period: &str, done: bool) -> PlanItem {
        PlanItem {
            id: id.into(), text: format!("事项 {id}"), done, note: String::new(),
            scope: scope.into(), period: period.into(), parent_id: String::new(),
            created_at: Some(1), updated_at: Some(1),
        }
    }

    #[test]
    fn upsert_only_touches_changed_items() {
        let mut items = vec![
            sample_item("a", "month", "2026-10", false),
            sample_item("b", "month", "2026-10", false),
        ];
        let mut incoming = sample_item("a", "month", "2026-10", true);
        incoming.created_at = None;
        let changed = upsert_plan_items(&mut items, vec![incoming], 999).unwrap();
        assert!(changed);
        let a = items.iter().find(|i| i.id == "a").unwrap();
        assert!(a.done);
        assert_eq!(a.updated_at, Some(999));
        assert_eq!(a.created_at, Some(1), "created_at 保留原值");
        let b = items.iter().find(|i| i.id == "b").unwrap();
        assert_eq!(b.updated_at, Some(1), "未传入的不动");
    }

    #[test]
    fn upsert_with_empty_payload_deletes_nothing() {
        let mut items = vec![sample_item("a", "week", "2026-10-26", false)];
        let changed = upsert_plan_items(&mut items, vec![], 5).unwrap();
        assert!(!changed);
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn upsert_adds_new_and_rejects_bad_period() {
        let mut items = vec![];
        let changed = upsert_plan_items(&mut items, vec![sample_item("n", "week", "2026-10-26", false)], 7).unwrap();
        assert!(changed);
        assert_eq!(items[0].created_at, Some(1));
        assert_eq!(items[0].updated_at, Some(7));
        assert!(upsert_plan_items(&mut items, vec![sample_item("x", "week", "2026-10-27", false)], 8).is_err());
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn select_journal_plan_items_filters_by_current_week_and_month() {
        let items = vec![
            sample_item("w1", "week", "2026-10-26", false),
            sample_item("w0", "week", "2026-10-19", false),
            sample_item("m1", "month", "2026-10", true),
            sample_item("m0", "month", "2026-09", false),
            sample_item("i", "inbox", "", false),
        ];
        let picked = select_journal_plan_items(&items, "2026-10-26", "2026-10");
        let ids: Vec<&str> = picked.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["m1", "w1"]);
    }
```

- [ ] **Step 2: 运行确认编译失败**

Run: `cd desktop/src-tauri && cargo test upsert select_journal 2>&1 | tail -10`
Expected: `cannot find function upsert_plan_items`。

- [ ] **Step 3: 新增 upsert / select**

在 `fn read_plan_item_database` 之前插入：

```rust
fn upsert_plan_items(items: &mut Vec<PlanItem>, incoming: Vec<PlanItem>, now: u64) -> Result<bool, String> {
    let mut changed = false;
    for item in incoming {
        let text = item.text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        let note = item.note.trim().to_string();
        let scope = {
            let s = item.scope.trim();
            if s.is_empty() { "inbox".to_string() } else { s.to_string() }
        };
        let period = item.period.trim().to_string();
        validate_plan_item_scope(&scope, &period)?;
        let parent_id = item.parent_id.trim().to_string();
        let id = {
            let raw = item.id.trim();
            if raw.is_empty() { format!("item-{now}-{}", items.len() + 1) } else { raw.to_string() }
        };

        if let Some(existing) = items.iter_mut().find(|e| e.id == id) {
            let differs = existing.text != text
                || existing.done != item.done
                || existing.note != note
                || existing.scope != scope
                || existing.period != period
                || existing.parent_id != parent_id;
            if differs {
                existing.text = text;
                existing.done = item.done;
                existing.note = note;
                existing.scope = scope;
                existing.period = period;
                existing.parent_id = parent_id;
                existing.updated_at = Some(now);
                changed = true;
            }
        } else {
            items.push(PlanItem {
                id,
                text,
                done: item.done,
                note,
                scope,
                period,
                parent_id,
                created_at: item.created_at.or(Some(now)),
                updated_at: Some(now),
            });
            changed = true;
        }
    }
    if changed {
        sort_plan_items(items);
    }
    Ok(changed)
}

fn select_journal_plan_items(items: &[PlanItem], week: &str, month: &str) -> Vec<PlanItem> {
    let mut picked: Vec<PlanItem> = items
        .iter()
        .filter(|item| {
            (item.scope == "week" && item.period == week) || (item.scope == "month" && item.period == month)
        })
        .cloned()
        .collect();
    sort_plan_items(&mut picked);
    picked
}
```

- [ ] **Step 4: 跑新测试**

Run: `cd desktop/src-tauri && cargo test upsert select_journal 2>&1 | tail -10`
Expected: 4 个 `ok`。

- [ ] **Step 5: 替换结构体与路径**

`:282-309` 改为：

```rust
#[derive(Serialize)]
struct DatabasePaths {
    frogs: String,
    habits: String,
    items: String,
    annual_goals: String,
}

#[derive(Serialize)]
struct JournalDatabases {
    frogs: FrogDay,
    frog_backlog: Vec<FrogBacklogItem>,
    habits: HabitDay,
    habit_definitions: Vec<HabitDefinition>,
    plan_items: Vec<PlanItem>,
    annual_goals: AnnualGoalRecord,
    paths: DatabasePaths,
}

#[derive(Serialize)]
struct JournalDatabaseManager {
    frogs: FrogDatabase,
    habits: HabitDatabase,
    items: PlanItemDatabase,
    annual_goals: AnnualGoalDatabase,
    paths: DatabasePaths,
}
```

`database_paths` 第三项改 `dir.join("items.csv")`；`database_path_labels` 参数名 `monthly` → `items`，字段 `items: items.display().to_string()`。

- [ ] **Step 6: 删除 Monthly* 全部**

删除以下定义（整段）：`MonthlyItem`、`MonthlyRecord`、`MonthlyBacklogItem`、`MonthlyDatabase`、`normalize_monthly_items_preserve`、`collect_monthly_backlog`、`apply_monthly_backlog`、`MONTHLY_CSV_HEADERS`、`read_monthly_database`、`write_monthly_database`、`save_monthly_database`。`invoke_handler` 里 `save_monthly_database,` 改为 `save_plan_item_database,`。

- [ ] **Step 7: 改 `get_database_manager`**

```rust
#[tauri::command]
async fn get_database_manager(app: tauri::AppHandle) -> Result<JournalDatabaseManager, String> {
    let (frogs_path, habits_path, items_path, annual_goals_path) = database_paths(&app)?;
    let mut habits = read_habit_database(&habits_path)?;
    if habits.definitions.is_empty() {
        habits.definitions = default_habit_definitions();
        write_habit_database(&habits_path, &habits)?;
    }

    Ok(JournalDatabaseManager {
        frogs: read_frog_database(&frogs_path)?,
        habits,
        items: read_plan_item_database(&items_path)?,
        annual_goals: read_annual_goal_database(&annual_goals_path)?,
        paths: database_path_labels(&frogs_path, &habits_path, &items_path, &annual_goals_path),
    })
}
```

- [ ] **Step 8: 新增 `save_plan_item_database`（全量替换）**

放在原 `save_monthly_database` 位置：

```rust
#[tauri::command]
async fn save_plan_item_database(
    app: tauri::AppHandle,
    items: Vec<PlanItem>,
) -> Result<PlanItemDatabase, String> {
    let (_, _, items_path, _) = database_paths(&app)?;
    let now = now_seconds();
    let existing = read_plan_item_database(&items_path)?;
    let mut normalized: Vec<PlanItem> = Vec::new();
    let mut seen = HashSet::new();

    for item in items {
        let text = item.text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        let scope = {
            let s = item.scope.trim();
            if s.is_empty() { "inbox".to_string() } else { s.to_string() }
        };
        let period = item.period.trim().to_string();
        validate_plan_item_scope(&scope, &period)?;
        let id = {
            let raw = item.id.trim();
            if raw.is_empty() { format!("item-{now}-{}", normalized.len() + 1) } else { raw.to_string() }
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let note = item.note.trim().to_string();
        let parent_id = item.parent_id.trim().to_string();
        let prev = existing.items.iter().find(|p| p.id == id);
        let differs = match prev {
            Some(p) => p.text != text || p.done != item.done || p.note != note
                || p.scope != scope || p.period != period || p.parent_id != parent_id,
            None => true,
        };
        normalized.push(PlanItem {
            id,
            text,
            done: item.done,
            note,
            scope,
            period,
            parent_id,
            created_at: prev.and_then(|p| p.created_at).or(item.created_at).or(Some(now)),
            updated_at: if differs { Some(now) } else { prev.and_then(|p| p.updated_at) },
        });
    }

    sort_plan_items(&mut normalized);
    let database = PlanItemDatabase { schema_version: 1, items: normalized };
    write_plan_item_database(&items_path, &database)?;
    Ok(database)
}
```

- [ ] **Step 9: 改 `get_journal_databases`**

把 `monthly_db` / `monthly` / `monthly_backlog` 相关行替换为：

```rust
    let week = week_key(&date)?;
    let items_db = read_plan_item_database(&items_path)?;
```

返回体：

```rust
    Ok(JournalDatabases {
        frogs,
        frog_backlog: collect_frog_backlog(&frogs_db.days),
        habits,
        habit_definitions: habits_db.definitions,
        plan_items: select_journal_plan_items(&items_db.items, &week, &month),
        annual_goals,
        paths: database_path_labels(&frogs_path, &habits_path, &items_path, &annual_goals_path),
    })
```

变量名 `monthly_path` 全部改 `items_path`。

- [ ] **Step 10: 改 `save_journal_databases`**

签名：

```rust
async fn save_journal_databases(
    app: tauri::AppHandle,
    date: String,
    frogs: Vec<FrogItem>,
    habits: HashMap<String, bool>,
    plan_items: Vec<PlanItem>,
    frog_backlog: Option<Vec<FrogBacklogItem>>,
    annual_goals: Option<Vec<AnnualGoalItem>>,
) -> Result<JournalDatabases, String> {
```

`:2568-2592` 的 monthly 段替换为：

```rust
    let week = week_key(&date)?;
    let mut items_db = read_plan_item_database(&items_path)?;
    if upsert_plan_items(&mut items_db.items, plan_items, now)? {
        write_plan_item_database(&items_path, &items_db)?;
    }
```

删除 `saved_monthly` 块；返回体与 Step 9 一致，`plan_items: select_journal_plan_items(&items_db.items, &week, &month)`。

- [ ] **Step 11: 编译 + 全量测试**

Run: `cd desktop/src-tauri && cargo build 2>&1 | grep -E "^(warning: unused|error)" ; cargo test 2>&1 | tail -5`
Expected: 无 `error`；无指向 Monthly/monthly 的残留 warning；`test result: ok`。

- [ ] **Step 12: Commit**

```bash
git add desktop/src-tauri/src/lib.rs
git commit -m "feat(db): 日记/管理命令切换到 PlanItem，移除 Monthly 结构"
```

---

### Task 4: 日记页 DOM/CSS：看见未来三格

**Files:**
- Modify: `desktop/app/晨间日记页面.html:285-322`
- Modify: `desktop/app/assets/晨间日记页面.css:867-869`

**Interfaces:**
- Produces DOM ids：`#weekRange`、`#weekList`、`#weekInput`、`#addWeekItem`（新）；`#todoList`、`#todoInput`、`#addTodo`、`#todoCount`（沿用）。

- [ ] **Step 1: 替换 `.future-content` 区块**

把 `:285` 的 `<div class="future-content nine-grid duo">` 改为 `<div class="future-content nine-grid">`，并在 `month-important` 卡**之前**插入：

```html
            <article class="journal-panel path-card soft-rose" data-od-id="week-plan">
              <div class="panel-title">
                <h2><span class="flower-dot" aria-hidden="true"></span>本周推进</h2>
                <span class="panel-action" id="weekRange">WEEK</span>
              </div>
              <div class="todo-database">
                <div class="database-heading">
                  <span>本周事项</span>
                  <span class="database-view">表格 · 本周</span>
                </div>
                <ul class="todo-list" id="weekList"></ul>
                <div class="todo-entry">
                  <input class="mini-input" id="weekInput" autocomplete="off" placeholder="添加本周要推进的事" />
                  <button class="btn btn-icon" id="addWeekItem" type="button" aria-label="添加本周事项">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                </div>
              </div>
            </article>
```

月卡内 `<span>未完成事项</span>` 改 `<span>本月事项</span>`，`表格 · 月度` 改 `表格 · 本月`。

- [ ] **Step 2: 删 CSS**

删除 `.nine-grid.duo { grid-template-columns: repeat(2, minmax(0, 1fr)); }` 整条规则。

- [ ] **Step 3: 浏览器直接打开核对**

Run: `open desktop/app/晨间日记页面.html`
Expected: 看见未来一行出现三张卡（周卡此时为空列表，JS 还未接入，控制台可能有报错，忽略）。

- [ ] **Step 4: Commit**

```bash
git add desktop/app/晨间日记页面.html desktop/app/assets/晨间日记页面.css
git commit -m "feat(journal): 看见未来改为 周/月/年 三格"
```

---

### Task 5: 日记页 JS：周卡/月卡状态、保存、fallback、Markdown

**Files:**
- Modify: `desktop/app/assets/晨间日记页面.js`
  - `:1-10` 解构 `weekKey, weekRangeLabel`
  - `:36-38` DOM 引用
  - `:294-338` 事件
  - `:495-507` fallback `save_journal_databases`
  - `:509-619` `getFallbackDatabases` / `saveFallbackDatabases`
  - `:658-696` 删 `collectMonthlyBacklog` / `applyMonthlyBacklog`
  - `:787-814` `mergeDatabasesToForm`
  - `:823-832` `databasePayloadFromForm`
  - `:863-899` 删 `collectCurrentMonthlyForDatabase` / `collectMonthlyBacklogForDatabase`，新增 `collectPlanItemsForDatabase`
  - `:934`、`:949-956` apply/read
  - `:1346-1406` `renderTodos` / `addMonthlyItem` → `renderPlanList` / `addPlanItem`
  - `:1481-1485` `updateTodoCount`
  - `:1575-1587` `buildMarkdown`
  - `:1634` `parseMarkdown`
  - `:1657` `defaultForm`
  - `:1702-1710` 删 `normaliseMonthlyForDatabase`
  - `:1760-1766` `parseTodoLines`

**Interfaces:**
- Consumes: Task 1 `weekKey/weekRangeLabel`；Task 3 的 `plan_items` / `planItems` / `paths.items`。
- Produces: `state.form.weekItems: PlanItem[]`、`state.form.monthItems: PlanItem[]`。

- [ ] **Step 1: 解构与 DOM 引用**

`:4-9` 解构里加 `weekKey, weekRangeLabel`。`:36-38` 之后加：

```js
      const weekList = document.getElementById("weekList");
      const weekInput = document.getElementById("weekInput");
      const addWeekItem = document.getElementById("addWeekItem");
      const weekRange = document.getElementById("weekRange");
```

- [ ] **Step 2: 事件**

`:294-299` 的 `addTodo` 监听改为调用 `addPlanItem("month", todoInput?.value || "")`。紧随其后新增：

```js
      addWeekItem?.addEventListener("click", (event) => {
        event.preventDefault();
        if (!addPlanItem("week", weekInput?.value || "")) return;
        weekInput.value = "";
        weekInput.focus();
        scheduleSave("本周事项已更新，正在保存…");
      });

      weekInput?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addWeekItem?.click();
        }
      });

      weekList?.addEventListener("change", () => {
        scheduleSave("本周事项已更新，正在保存…");
      });
```

删除 `:331-338` 的 `todoList click delete-todo` 监听（日记页不再删除）。`:424` 的禁用列表加 `addWeekItem, weekInput`。

- [ ] **Step 3: fallback 读写**

`:495-507`：

```js
        if (command === "save_journal_databases") {
          return saveFallbackDatabases(
            args.date,
            args.frogs || [],
            args.habits || {},
            args.planItems || [],
            args.frogBacklog || [],
            args.annualGoals || []
          );
        }
```

在 `getFallbackDatabases` 之前新增：

```js
      function readFallbackItemsDatabase() {
        const current = readFallbackDatabase("lifeos-db:items", null);
        if (current) return current;
        const legacy = readFallbackDatabase("lifeos-db:monthly-important", null);
        const items = (legacy?.months || []).flatMap((record) => (record.items || [])
          .filter((item) => String(item.text || "").trim())
          .map((item) => ({
            id: item.id || createClientId("item"),
            text: String(item.text).trim(),
            done: Boolean(item.done),
            note: item.note || "",
            scope: "month",
            period: record.month,
            parent_id: "",
            created_at: item.created_at || null,
            updated_at: item.updated_at || record.updated_at || null
          })));
        const db = { schema_version: 1, items };
        localStorage.setItem("lifeos-db:items", JSON.stringify(db));
        if (legacy) localStorage.removeItem("lifeos-db:monthly-important");
        return db;
      }

      function selectJournalPlanItems(items, valueDate) {
        const week = weekKey(valueDate);
        const month = valueDate.slice(0, 7);
        return (items || []).filter((item) =>
          (item.scope === "week" && item.period === week) || (item.scope === "month" && item.period === month));
      }
```

`getFallbackDatabases`：删除 `monthlyDb` 行，加 `const itemsDb = readFallbackItemsDatabase();`；返回体中 `monthly` / `monthly_backlog` 两行换成 `plan_items: selectJournalPlanItems(itemsDb.items, valueDate),`；`paths.monthly` 改 `items: "本机预览 / LifeOS-Vault / 00-Databases / items.csv"`。

`saveFallbackDatabases(valueDate, frogs, habits, planItems, frogBacklog, annualGoals)`：删 `monthlyDb` 相关 4 行（读、normalise、filter/push、setItem、applyMonthlyBacklog），改为：

```js
        const itemsDb = readFallbackItemsDatabase();
        (planItems || []).forEach((incoming) => {
          const text = String(incoming.text || "").trim();
          if (!text) return;
          const id = incoming.id || createClientId("item");
          const existing = itemsDb.items.find((item) => item.id === id);
          const next = {
            id,
            text,
            done: Boolean(incoming.done),
            note: String(incoming.note || "").trim(),
            scope: incoming.scope || "inbox",
            period: incoming.period || "",
            parent_id: incoming.parent_id || "",
            created_at: existing?.created_at || incoming.created_at || now,
            updated_at: now
          };
          if (!existing) { itemsDb.items.push(next); return; }
          const differs = ["text", "done", "note", "scope", "period", "parent_id"].some((key) => existing[key] !== next[key]);
          if (differs) Object.assign(existing, next);
        });
        localStorage.setItem("lifeos-db:items", JSON.stringify(itemsDb));
```

删除 `collectMonthlyBacklog`、`applyMonthlyBacklog`、`normaliseMonthlyForDatabase` 三个函数。

- [ ] **Step 4: merge / payload / collect**

`mergeDatabasesToForm` 中 `:787` 与 `:796-814` 替换为：

```js
        if (Array.isArray(databases?.plan_items)) {
          const normalised = databases.plan_items.map(normalisePlanItem).filter((item) => item.text);
          state.form.weekItems = normalised.filter((item) => item.scope === "week");
          state.form.monthItems = normalised.filter((item) => item.scope === "month");
        }
```

`databasePayloadFromForm`：

```js
      function databasePayloadFromForm(form) {
        return {
          frogs: collectFrogsForDatabase(form),
          habits: collectHabitsForDatabase(form),
          planItems: collectPlanItemsForDatabase(form),
          frogBacklog: collectFrogBacklogForDatabase(form),
          annualGoals: collectAnnualGoalsForDatabase(form)
        };
      }
```

删 `collectCurrentMonthlyForDatabase` / `collectMonthlyBacklogForDatabase`，新增：

```js
      function normalisePlanItem(item) {
        return {
          id: item.id || createClientId("item"),
          text: String(item.text || "").trim(),
          done: Boolean(item.done),
          note: String(item.note || ""),
          scope: item.scope || "inbox",
          period: item.period || "",
          parent_id: item.parent_id || "",
          created_at: item.created_at || null,
          updated_at: item.updated_at || null
        };
      }

      function collectPlanItemsForDatabase(form) {
        return [...(form.weekItems || []), ...(form.monthItems || [])].map(normalisePlanItem).filter((item) => item.text);
      }
```

- [ ] **Step 5: apply / read / render / add / count**

`applyFormToPage` `:934` 改为：

```js
        renderPlanList(weekList, state.form.weekItems || []);
        renderPlanList(todoList, state.form.monthItems || []);
        if (weekRange) weekRange.textContent = `WEEK · ${weekRangeLabel(weekKey(state.form.date))}`;
```

`readPageToForm` `:949-956` 改为：

```js
        state.form.weekItems = readPlanListFromDom(weekList);
        state.form.monthItems = readPlanListFromDom(todoList);
```

`renderTodos` / `addMonthlyItem`（`:1346-1406`）整体替换为：

```js
      function readPlanListFromDom(listEl) {
        if (!listEl) return [];
        return Array.from(listEl.querySelectorAll(".todo-item")).map((item) => ({
          id: item.dataset.id,
          text: item.querySelector(".todo-text")?.textContent.trim() || "",
          done: Boolean(item.querySelector("input")?.checked),
          note: item.dataset.note || "",
          scope: item.dataset.scope,
          period: item.dataset.period,
          parent_id: item.dataset.parentId || "",
          created_at: item.dataset.createdAt ? Number(item.dataset.createdAt) : null,
          updated_at: item.dataset.updatedAt ? Number(item.dataset.updatedAt) : null
        })).filter((entry) => entry.text);
      }

      function renderPlanList(listEl, items) {
        if (!listEl) return;
        listEl.innerHTML = "";
        const visible = (items || []).filter((item) => item.text)
          .sort((a, b) => Number(a.done) - Number(b.done) || (a.created_at || 0) - (b.created_at || 0));
        if (!visible.length) {
          const empty = document.createElement("li");
          empty.className = "empty-row";
          empty.textContent = listEl === weekList ? "本周还没有事项" : "本月还没有事项";
          listEl.append(empty);
          updateTodoCount();
          return;
        }
        visible.forEach((entry) => {
          const item = document.createElement("li");
          item.className = `todo-item${entry.done ? " is-done" : ""}`;
          item.dataset.id = entry.id || createClientId("item");
          item.dataset.scope = entry.scope;
          item.dataset.period = entry.period;
          if (entry.note) item.dataset.note = entry.note;
          if (entry.parent_id) item.dataset.parentId = entry.parent_id;
          if (entry.created_at) item.dataset.createdAt = String(entry.created_at);
          if (entry.updated_at) item.dataset.updatedAt = String(entry.updated_at);
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = Boolean(entry.done);
          checkbox.setAttribute("aria-label", entry.scope === "week" ? "完成本周事项" : "完成本月事项");
          const text = document.createElement("span");
          text.className = "todo-text";
          text.textContent = entry.text;
          checkbox.addEventListener("change", () => item.classList.toggle("is-done", checkbox.checked));
          item.append(checkbox, text);
          listEl.append(item);
        });
        updateTodoCount();
      }

      function addPlanItem(scope, text) {
        const cleanText = String(text || "").trim();
        if (!cleanText) return false;
        const now = Math.floor(Date.now() / 1000);
        readPageToForm();
        const item = {
          id: createClientId("item"),
          text: cleanText,
          done: false,
          note: "",
          scope,
          period: scope === "week" ? weekKey(state.form.date) : state.form.date.slice(0, 7),
          parent_id: "",
          created_at: now,
          updated_at: now
        };
        if (scope === "week") {
          renderPlanList(weekList, [...(state.form.weekItems || []), item]);
        } else {
          renderPlanList(todoList, [...(state.form.monthItems || []), item]);
        }
        readPageToForm();
        return true;
      }
```

`updateTodoCount`：

```js
      function updateTodoCount() {
        if (!todoCount || !todoList) return;
        const items = Array.from(todoList.querySelectorAll(".todo-item"));
        const done = items.filter((item) => item.querySelector("input")?.checked).length;
        todoCount.textContent = `${done}/${items.length}`;
      }
```

- [ ] **Step 6: Markdown 导出/解析**

`buildMarkdown` `:1519` 改为：

```js
        const weekItems = (form.weekItems || []).filter((item) => String(item.text || "").trim());
        const monthItems = (form.monthItems || []).filter((item) => String(item.text || "").trim());
```

`:1575-1582` 改为：

```js
        const todoLines = (items) => items.length
          ? items.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`).join("\n")
          : "——";
        parts.push("", "## 本周推进", todoLines(weekItems));
        parts.push("", "## 本月重要几件事", todoLines(monthItems));
```

`parseMarkdown` `:1634` 改为：

```js
        form.weekItems = parseTodoLines(findSection(sections, ["本周推进"]), "week", weekKey(valueDate));
        form.monthItems = parseTodoLines(findSection(sections, ["本月重要几件事", "看见未来"]), "month", valueDate.slice(0, 7));
```

`defaultForm`（`:1657` 附近）里 `todos: [],` 改为 `weekItems: [], monthItems: [],`。

`parseTodoLines`：

```js
      function parseTodoLines(text, scope, period) {
        return splitLines(text).map((line) => {
          const done = /^-\s+\[[xX]\]\s*/.test(line);
          const clean = line.replace(/^-\s+\[[ xX]\]\s*/, "").replace(/^\d{4}-\d{2}\s*·\s*/, "").trim();
          return clean ? {
            id: createClientId("item"), text: clean, done, note: "", scope, period, parent_id: "",
            created_at: null, updated_at: null
          } : null;
        }).filter(Boolean);
      }
```

- [ ] **Step 7: grep 残留**

Run: `grep -n "todos\|monthly\|Monthly\|addMonthlyItem\|renderTodos" desktop/app/assets/晨间日记页面.js`
Expected: 无输出。

- [ ] **Step 8: 浏览器 fallback 冒烟**

Run: `open desktop/app/晨间日记页面.html`
检查：周卡右上角显示 `WEEK · 10.26–11.01`（按当天）；周卡输入回车 → 出现条目；刷新后仍在；月卡新增、勾选 → 右上角 `1/1`；DevTools Application → localStorage 有 `lifeos-db:items` 且条目 `scope` 正确。

- [ ] **Step 9: Tauri 冒烟**

Run: `cd desktop && npm run tauri dev`（或项目现有脚本）
检查同 Step 8；另在 vault `00-Databases/` 看到 `items.csv` 生成且 `monthly-important.csv` 原样保留。

- [ ] **Step 10: Commit**

```bash
git add desktop/app/assets/晨间日记页面.js
git commit -m "feat(journal): 周卡/月卡接入 PlanItem，保存改为 upsert"
```

---

### Task 6: 收集箱页（管理页改造）

**Files:**
- Rename: `desktop/app/本月重要几件事管理.html` → `desktop/app/收集箱.html`
- Modify: `desktop/app/assets/database-manager.js`
  - `:1-25` 解构加 `weekKey`，`fallbackKeys.monthly` → `items`
  - `:43-50` `config.monthly` → `config.items`
  - `:108-118` fallback manager
  - `:139-143` fallback save
  - `:158-159` render 分派
  - `:400-465` `renderMonthly` → `renderItems`
  - `:549-560` `renderMonthItemRow` → `renderPlanItemRow`
  - `:796-816` add row action
  - `:833-836` saveNow 分支
  - `:893-912` `collectMonthly` → `collectItems`
  - `:932-938` `updateRowMeta`
  - `:942-963` `applyCurrentFilters` 加视图过滤
  - `:1035-1060` `ensureMonthlyTbody` → `ensureItemsTbody`
  - `:1168-1182` 删 flatten/sortMonth
  - `:1209-1212` `normalizeSnapshot`
  - `:1229-1231` `defaultMonthly` → `defaultItems`
  - `:1284-1297` `normalizeMonths` → `normalizeItems`

**Interfaces:**
- Consumes: Task 3 `get_database_manager().items`、`save_plan_item_database({ items })`；Task 1 `weekKey`。
- Produces: `data-kind="plan-item"` 行；字段 `item-done / item-text / item-note / item-scope / item-period / item-parent`。

- [ ] **Step 1: 改名并改壳**

```bash
git mv desktop/app/本月重要几件事管理.html desktop/app/收集箱.html
```

文件内：`<title>收集箱 | LifeOS</title>`、`window-title` 文本 `收集箱 | LifeOS`、`<body data-manager="items">`、`#managerTitle` 文本 `收集箱`、`#databasePath` 文本 `items.csv`、`#workspaceTitle` 文本 `收集箱`。

- [ ] **Step 2: 配置、常量、fallback**

`:10` 后加 `const weekKeyOf = window.LifeOSShared.weekKey;`；`:16` 后加 `const currentWeek = weekKeyOf(currentDate);`。
`fallbackKeys`：`monthly: "lifeos-db:monthly-important"` → `items: "lifeos-db:items"`。
`config.monthly` 整段替换为：

```js
    items: {
      mark: "收",
      title: "收集箱",
      subtitle: "未归属 + 过期未完成；在这里决定它属于哪一周、哪个月。",
      pathKey: "items",
      saveCommand: "save_plan_item_database",
      fileName: "items.csv"
    },
```

fallback `get_database_manager`：`monthly: readFallback(fallbackKeys.monthly, defaultMonthly())` → `items: readFallback(fallbackKeys.items, defaultItems())`；`paths.monthly` → `items: \`本机预览 / LifeOS-Vault / 00-Databases / ${config.items.fileName}\``。
fallback save：

```js
    if (command === "save_plan_item_database") {
      const database = { schema_version: 1, items: normalizeItems(args.items || []) };
      localStorage.setItem(fallbackKeys.items, JSON.stringify(database));
      return database;
    }
```

`render()`：`managerType === "monthly"` → `"items"`，`renderMonthly()` → `renderItems()`。

- [ ] **Step 3: 视图辅助函数**

在 `renderItems` 之前新增：

```js
  const SCOPE_LABEL = { inbox: "收集箱", week: "周", month: "月", year: "年" };

  function isOverdue(scope, period) {
    if (scope === "week") return period < currentWeek;
    if (scope === "month") return period < currentMonth;
    if (scope === "year") return period < currentYear;
    return false;
  }

  function matchesView(view, scope, period, done) {
    if (!view || view === "all") return true;
    if (view === "inbox") return scope === "inbox" || (!done && isOverdue(scope, period));
    if (view === "week") return scope === "week" && period === currentWeek;
    if (view === "month") return scope === "month" && period === currentMonth;
    return true;
  }

  function periodLabel(scope, period) {
    if (scope === "week") return `${period.slice(5).replace("-", ".")} 周`;
    if (scope === "month") return `${period} 月`;
    if (scope === "year") return `${period} 年`;
    return "";
  }

  function originBadge(item) {
    if (item.scope === "inbox" || item.done || !isOverdue(item.scope, item.period)) return '<span class="muted">—</span>';
    return `<span class="status-pill" data-done="false">${escapeHtml(periodLabel(item.scope, item.period))} · 未完成</span>`;
  }

  function parentOptionsFor(scope, selected) {
    let candidates = [];
    if (scope === "week") {
      candidates = state.snapshot.items.items
        .filter((item) => item.scope === "month" && item.period >= currentMonth)
        .map((item) => ({ id: item.id, label: `${item.period} · ${item.text}` }));
    } else if (scope === "month") {
      const record = state.snapshot.annual_goals.years.find((year) => year.year === currentYear);
      candidates = (record?.items || []).map((item) => ({ id: item.id, label: `${currentYear} · ${item.text}` }));
    }
    const known = candidates.some((c) => c.id === selected);
    const options = [`<option value="">—</option>`]
      .concat(candidates.map((c) => `<option value="${escapeAttr(c.id)}" ${c.id === selected ? "selected" : ""}>${escapeHtml(c.label)}</option>`));
    if (selected && !known) options.push(`<option value="${escapeAttr(selected)}" selected>（已删除的上级）</option>`);
    return options.join("");
  }

  function periodInputHtml(scope, period) {
    if (scope === "week") return `<input type="date" data-field="item-period" value="${escapeAttr(period)}" aria-label="归属周（任意一天，自动回退到周一）">`;
    if (scope === "month") return `<input type="month" data-field="item-period" value="${escapeAttr(period)}" aria-label="归属月份">`;
    return `<input type="text" data-field="item-period" value="" disabled aria-label="收集箱无归属期">`;
  }
```

- [ ] **Step 4: `renderItems` 与行渲染**

`renderMonthly` 整体替换：

```js
  function renderItems() {
    const items = [...state.snapshot.items.items];
    const inboxCount = items.filter((item) => matchesView("inbox", item.scope, item.period, item.done)).length;
    const weekCount = items.filter((item) => matchesView("week", item.scope, item.period, item.done) && !item.done).length;
    const monthCount = items.filter((item) => matchesView("month", item.scope, item.period, item.done) && !item.done).length;
    setSummary([
      ["待归属", `${inboxCount} 件`],
      ["本周未完成", `${weekCount} 件`],
      ["本月未完成", `${monthCount} 件`]
    ]);
    el.toolbar.innerHTML = `
      <div class="toolbar-group filter-group" aria-label="筛选条件">
        <label class="toolbar-field">
          <span>视图</span>
          <select id="viewFilter" data-filter="view" aria-label="视图">
            <option value="inbox" selected>收集箱</option>
            <option value="week">本周</option>
            <option value="month">本月</option>
            <option value="all">全部</option>
          </select>
        </label>
        <label class="toolbar-field search-field">
          <span>搜索</span>
          <input type="search" id="searchQuery" data-filter="search" placeholder="事项关键词" aria-label="搜索事项">
        </label>
        <label class="toolbar-field">
          <span>状态</span>
          <select id="statusFilter" data-filter="status" aria-label="状态筛选">
            <option value="open" selected>未完成</option>
            <option value="all">全部</option>
            <option value="done">已完成</option>
          </select>
        </label>
      </div>
      <div class="toolbar-group create-group" aria-label="新增记录">
        <button class="btn secondary" type="button" data-action="add-plan-item-row">新增事项</button>
      </div>
    `;
    el.list.innerHTML = items.length ? `
      <div class="table-area">
        <div class="table-scroll">
          <table class="data-table" aria-label="事项表">
            <thead>
              <tr>
                <th>完成</th>
                <th>事项</th>
                <th>归属</th>
                <th>期</th>
                <th>上级</th>
                <th>来源</th>
                <th>备注</th>
                <th>创建时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(renderPlanItemRow).join("")}
            </tbody>
          </table>
        </div>
        <div class="action-sidebar">
          <div class="action-sidebar-head">操作</div>
          <div class="action-sidebar-list"></div>
        </div>
      </div>
      <p class="table-note">「收集箱」视图 = 未归属 + 过期未完成。给它选一个周或月，就是一次重新决定。</p>
    ` : emptyState("收集箱是空的。先新增一件事项，再决定它属于哪一周、哪个月。");
    applyCurrentFilters();
    if (items.length) initActionSidebar(items.length);
    applyCurrentFilters();
  }

  function renderPlanItemRow(item) {
    const scope = item.scope || "inbox";
    return `
      <tr class="data-row" data-kind="plan-item" data-row data-done="${item.done ? "true" : "false"}" data-scope="${escapeAttr(scope)}" data-period="${escapeAttr(item.period || "")}" data-search="${escapeAttr(item.text)}" data-item-id="${escapeAttr(item.id)}" data-created-at="${item.created_at || ""}">
        <td><input type="checkbox" data-field="item-done" ${item.done ? "checked" : ""} aria-label="完成状态"></td>
        <td><input type="text" data-field="item-text" value="${escapeAttr(item.text)}" placeholder="事项"></td>
        <td>
          <select data-field="item-scope" aria-label="归属">
            ${["inbox", "week", "month"].map((s) => `<option value="${s}" ${s === scope ? "selected" : ""}>${SCOPE_LABEL[s]}</option>`).join("")}
          </select>
        </td>
        <td data-cell="period">${periodInputHtml(scope, item.period || "")}</td>
        <td><select data-field="item-parent" aria-label="上级" ${scope === "inbox" ? "disabled" : ""}>${parentOptionsFor(scope, item.parent_id || "")}</select></td>
        <td data-cell="origin">${originBadge(item)}</td>
        <td><input type="text" data-field="item-note" value="${escapeAttr(item.note || "")}"></td>
        <td class="readonly-cell">${formatTimestamp(item.created_at) || '<span class="muted">—</span>'}</td>
        <td>${statusPill(item.done)}</td>
      </tr>
    `;
  }
```

`ensureMonthlyTbody` 改名 `ensureItemsTbody`，表头与上面 9 列一致。

- [ ] **Step 5: 新增行动作、归属联动、收集、过滤**

`add-month-item-row` 分支替换为：

```js
    if (action === "add-plan-item-row") {
      resetObjectFilters();
      const viewSelect = document.getElementById("viewFilter");
      if (viewSelect) viewSelect.value = "all";
      const tbody = ensureItemsTbody();
      if (tbody) {
        tbody.insertAdjacentHTML("afterbegin", renderPlanItemRow({
          id: uid("item"), text: "", done: false, note: "", scope: "inbox", period: "", parent_id: "",
          created_at: nowSeconds(), updated_at: null
        }));
        tbody.querySelector('[data-field="item-text"]')?.focus();
        applyCurrentFilters();
        const sidebarList = el.list.querySelector(".action-sidebar-list");
        if (sidebarList) sidebarList.insertAdjacentHTML("afterbegin", '<div class="action-sidebar-item"><button class="btn danger compact" type="button" data-action="delete-row">删除</button></div>');
        initColumnCopy();
      }
    }
```

找到 `el.list` 上现有的 `change` 事件委托（调用 `updateRowMeta(row)` 并 `requestSave()` 的那段），在调用 `updateRowMeta` **之前**插入：

```js
      if (event.target.matches('[data-field="item-scope"]')) {
        const row = event.target.closest("[data-row]");
        const scope = event.target.value;
        const period = scope === "week" ? currentWeek : scope === "month" ? currentMonth : "";
        row.querySelector('[data-cell="period"]').innerHTML = periodInputHtml(scope, period);
        const parent = row.querySelector('[data-field="item-parent"]');
        parent.disabled = scope === "inbox";
        parent.innerHTML = parentOptionsFor(scope, "");
      }
      if (event.target.matches('[data-field="item-period"]') && event.target.type === "date" && isDate(event.target.value)) {
        event.target.value = weekKeyOf(event.target.value);
      }
```

`saveNow` 分支：

```js
      } else if (managerType === "items") {
        const saved = await invoke(view.saveCommand, { items: collectItems() });
        state.snapshot.items = { schema_version: 1, items: normalizeItems(saved.items || []) };
```

`collectMonthly` 替换为：

```js
  function collectItems() {
    return [...el.list.querySelectorAll('[data-kind="plan-item"]')].map((row) => {
      const scope = row.querySelector('[data-field="item-scope"]')?.value || "inbox";
      const rawPeriod = row.querySelector('[data-field="item-period"]')?.value || "";
      const period = scope === "week" && isDate(rawPeriod) ? weekKeyOf(rawPeriod) : scope === "inbox" ? "" : rawPeriod;
      return {
        id: row.dataset.itemId || uid("item"),
        text: row.querySelector('[data-field="item-text"]')?.value || "",
        done: Boolean(row.querySelector('[data-field="item-done"]')?.checked),
        note: row.querySelector('[data-field="item-note"]')?.value || "",
        scope,
        period,
        parent_id: scope === "inbox" ? "" : (row.querySelector('[data-field="item-parent"]')?.value || ""),
        created_at: Number(row.dataset.createdAt) || nowSeconds(),
        updated_at: null
      };
    }).filter((item) => item.text.trim());
  }
```

`updateRowMeta` 的 `month-item` 分支替换为：

```js
    if (row.dataset.kind === "plan-item") {
      row.dataset.done = row.querySelector('[data-field="item-done"]')?.checked ? "true" : "false";
      row.dataset.scope = row.querySelector('[data-field="item-scope"]')?.value || "inbox";
      row.dataset.period = row.querySelector('[data-field="item-period"]')?.value || "";
      row.dataset.search = row.querySelector('[data-field="item-text"]')?.value || "";
      const status = row.querySelector(".status-pill");
      if (status) status.outerHTML = statusPill(row.dataset.done === "true");
      const origin = row.querySelector('[data-cell="origin"]');
      if (origin) origin.innerHTML = originBadge({ scope: row.dataset.scope, period: row.dataset.period, done: row.dataset.done === "true" });
    }
```

`applyCurrentFilters`：开头加 `const viewValue = document.getElementById("viewFilter")?.value || "";`；循环里加 `const viewMatch = matchesView(viewValue, row.dataset.scope, row.dataset.period, done);`，`hidden` 表达式末尾追加 `|| !viewMatch`。`resetObjectFilters` 不动（视图在新增分支里单独置为 all）。

- [ ] **Step 6: normalize / default / snapshot，删旧函数**

删除 `flattenMonthItems`、`sortMonthItems`、`normalizeMonths`、`defaultMonthly`。新增：

```js
  function defaultItems() {
    return { schema_version: 1, items: [] };
  }

  function normalizeItems(items) {
    return [...dedupeBy(items, "id")]
      .filter((item) => String(item.text || "").trim())
      .map((item) => ({
        id: item.id || uid("item"),
        text: String(item.text).trim(),
        done: Boolean(item.done),
        note: String(item.note || ""),
        scope: ["inbox", "week", "month", "year"].includes(item.scope) ? item.scope : "inbox",
        period: item.scope === "inbox" ? "" : String(item.period || ""),
        parent_id: String(item.parent_id || ""),
        created_at: item.created_at || nowSeconds(),
        updated_at: item.updated_at || null
      }));
  }
```

`normalizeSnapshot` 中 `monthly: {...}` 换 `items: { schema_version: 1, items: normalizeItems(snapshot?.items?.items || []) }`。

- [ ] **Step 7: grep 残留**

Run: `grep -n "monthly\|Monthly\|month-item\|MonthItem" desktop/app/assets/database-manager.js`
Expected: 无输出。

- [ ] **Step 8: 浏览器冒烟**

Run: `open desktop/app/收集箱.html`
检查：默认「收集箱」tab；新增事项默认收集箱；把归属改「本周」→ 期自动填本周一、上级下拉出现月事项；改「指定」日期为周三 → 失焦后变周一；刷新后保存结果一致；切「全部」tab 能看到全部。把一条月事项期改成上月 → 回到「收集箱」tab 带 `2026-09 月 · 未完成` 来源标签。

- [ ] **Step 9: Commit**

```bash
git add -A desktop/app/收集箱.html desktop/app/assets/database-manager.js
git commit -m "feat(inbox): 本月重要几件事管理页改造为收集箱页"
```

---

### Task 7: 首页预览卡

**Files:**
- Modify: `desktop/app/index.html`
  - `:2326-2335` 预览卡
  - `:2567` fallback key
  - `:2877` path
  - `:2899-2903` fallback save
  - `:2969`、`:2983` default
  - `:2995` read fallback
  - `:3020-3023` normalize snapshot
  - `:3092` `normalizeMonthlyRecords` → `normalizeItems`
  - `:3147`、`:3150`、`:3158`、`:3173-3177` 预览渲染
  - `:3203` `flattenMonthlyPreview` → `flattenInboxPreview`
  - `:3238-3246` row
  - `:3310-3311`、`:3338-3345`、`:3375-3378` 勾选保存

- [ ] **Step 1: DOM**

```html
            <article class="database-preview-card" data-preview-card="items">
              <div class="preview-head">
                <div class="preview-title">
                  <h3>收集箱</h3>
                  <span id="itemsPreviewMeta">待归属</span>
                </div>
                <a class="preview-manage" href="收集箱.html">管理</a>
              </div>
              <div class="preview-list" id="itemsPreviewList"></div>
            </article>
```

`el` 对象里 `monthlyPreviewList/monthlyPreviewMeta` → `itemsPreviewList/itemsPreviewMeta`。

- [ ] **Step 2: 常量与 fallback**

`databaseFallbackKeys.monthly` → `items: "lifeos-db:items"`。`paths.monthly` → `items: \`${vaultDir}/00-Databases/items.csv\``。fallback save：

```js
      if (command === "save_plan_item_database") {
        const database = { schema_version: 1, items: normalizeItems(args.items || []) };
        localStorage.setItem(databaseFallbackKeys.items, JSON.stringify(database));
        return database;
      }
```

`emptyDatabaseSnapshot` / `readFallbackDatabases` / `normalizeDatabaseSnapshot` 中 `monthly` → `items`，`defaultMonthlyDatabase()` → `defaultItemsDatabase()`（`{ schema_version: 1, items: [] }`），`normalizeMonthlyRecords(...months)` → `normalizeItems(snapshot?.items?.items || [])`。`normalizeItems` 实现与 Task 6 Step 6 相同（首页没有 `dedupeBy` 的话用 `Map` 按 id 去重）。

- [ ] **Step 3: 预览渲染**

在 `renderDatabasePreview` 顶部定义 `const currentWeek = window.LifeOSShared.weekKey(formatDate(today));` `const currentMonth = formatDate(today).slice(0, 7);`。

```js
    function flattenInboxPreview(items, currentWeek, currentMonth) {
      const overdue = (item) => (item.scope === "week" && item.period < currentWeek) || (item.scope === "month" && item.period < currentMonth);
      return (items || []).filter((item) => item.scope === "inbox" || (!item.done && overdue(item)));
    }

    function renderItemPreviewRow(item) {
      const meta = item.scope === "inbox" ? "待归属" : `${item.period} · 过期未完成`;
      return renderPreviewRow({
        kind: "item",
        checked: item.done,
        text: item.text,
        meta,
        attrs: `data-item-id="${escapeHtml(item.id)}"`
      });
    }
```

`renderDatabasePreview` 中：`const monthItems = flattenMonthlyPreview(...)` → `const inboxItems = flattenInboxPreview(snapshot.items.items, currentWeek, currentMonth);`；meta：`el.itemsPreviewMeta.textContent = inboxItems.length ? \`${inboxItems.length} 项待归属\` : "收集箱是空的"`；列表：`inboxItems.slice(0, 5).map(renderItemPreviewRow)`、`renderMorePreview(inboxItems.length, "收集箱.html")`、空态 `renderPreviewEmpty("收集箱是空的。")`。删除 `monthOpen` 行。

- [ ] **Step 4: 勾选与保存**

`applyDatabasePreviewChange`：`kind === "monthly"` 分支 → `else if (kind === "item") { setItemPreviewDone(field.dataset.itemId, field.checked); }`。

```js
    function setItemPreviewDone(itemId, done) {
      const item = state.databases.items.items.find((entry) => entry.id === itemId);
      if (!item) throw new Error("没有找到这条事项。");
      item.done = done;
      item.updated_at = nowSeconds();
    }
```

`saveDatabasePreviewKind`：

```js
      if (kind === "item") {
        const saved = await invoke("save_plan_item_database", { items: state.databases.items.items });
        state.databases.items = { schema_version: 1, items: normalizeItems(saved.items || []) };
        return;
      }
```

删除 `setMonthlyPreviewDone`、`flattenMonthlyPreview`、`renderMonthlyPreviewRow`、`normalizeMonthlyRecords`、`defaultMonthlyDatabase`。

- [ ] **Step 5: grep 残留**

Run: `grep -n "monthly\|Monthly\|本月重要几件事管理" desktop/app/index.html`
Expected: 无输出。

- [ ] **Step 6: 冒烟**

Run: `open desktop/app/index.html`
检查：收集箱卡显示 `N 项待归属`，勾选一条后刷新保持；「管理」跳到收集箱页。

- [ ] **Step 7: Commit**

```bash
git add desktop/app/index.html
git commit -m "feat(home): 首页预览卡改为收集箱"
```

---

### Task 8: 全链路验收

**Files:** 无代码改动（发现问题则回到对应 Task 修）。

- [ ] **Step 1: Rust 全量**

Run: `cd desktop/src-tauri && cargo test 2>&1 | tail -5 && cargo build 2>&1 | grep -c warning`
Expected: `test result: ok`；warning 数不高于改动前（改动前先记一次基线）。

- [ ] **Step 2: 全仓残留**

Run: `grep -rn "monthly-important\|save_monthly_database\|monthly_backlog\|MonthlyItem" desktop/app desktop/src-tauri/src --include=*.js --include=*.html --include=*.rs | grep -v "LEGACY_MONTHLY\|migrate_monthly_to_items\|with_file_name\|readFallbackItemsDatabase"`
Expected: 无输出。

- [ ] **Step 3: Tauri 实机走查**

Run: `cd desktop && npm run tauri dev`

1. 首次启动：vault `00-Databases/` 出现 `items.csv`，行数 = 旧 `monthly-important.csv` 非空行数，老文件原样。
2. 日记页三格；周卡 `WEEK · MM.DD–MM.DD` 正确；周卡新增 → 刷新仍在 → `items.csv` 多一行 `scope=week`。
3. 月卡勾完成 → 计数变 `1/N`；只显示本月事项。
4. 收集箱页：把一条本月事项的期改到上月、保存 → 日记页月卡不再显示；收集箱 tab 出现并带来源标签。
5. 收集箱页删一条 → 日记页消失。
6. 首页收集箱卡数字与收集箱 tab 条数一致。
7. 打开一篇旧日记 `.md`（含 `## 看见未来`），断开后端（浏览器直开）能解析出月事项。
8. 浏览器直开三页，localStorage 老 key `lifeos-db:monthly-important` 被迁移为 `lifeos-db:items`。

- [ ] **Step 4: 收尾 Commit（如有修补）**

```bash
git status
git add <修补的文件>
git commit -m "fix: 收集箱全链路验收修补"
```
