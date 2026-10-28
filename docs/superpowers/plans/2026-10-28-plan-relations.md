# 周—月—年目标关系页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增当前周/月/年三列目标关系页，支持持久化拖拽排序、SVG 实时连线、手动连接和断开上级。

**Architecture:** 继续在 `items.csv` 与 `annual-goals.csv` 中保存领域数据，追加 `sort_order`，关系仍使用 `parent_id`。新页面用原生 HTML 卡片与一张 SVG 连线层，Pointer Events 区分排序手柄和连接点；保存复用现有全量数据库命令，失败时恢复操作前快照。

**Tech Stack:** Tauri 2、Rust、原生 HTML/CSS/JavaScript、SVG、Pointer Events、Node.js 内置模块、本机 Chrome DevTools Protocol；不增加 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-10-28-plan-relations-design.md`

## Global Constraints

- 第一版只展示当前周、当前月、今年，不做周期切换。
- 周卡只能连当前月卡，月卡只能连今年卡；每个子项只有一个 `parent_id`。
- 拖手柄只排序，拖连接点只改关系；两种手势不得互相触发。
- `sort_order` 在 `scope + period` 或年度分组内生效；`0` 表示新增时未指定。
- 年度目标继续独立存储，不并入 `items.csv`。
- 不引入前端框架、拖拽库、SVG 库或其他第三方依赖。
- 窄屏保持三列并横向滚动，不上下堆叠。
- 保存失败必须回滚本次操作；保存期间禁止新的排序或连线。
- 所有生产变更先写失败测试并确认失败原因，再写最小实现。
- 每个任务完成后运行该任务检查并独立提交，不合并或推送分支。

## File Structure

- `desktop/src-tauri/src/lib.rs`：两个 CSV 模型、排序、兼容读写、upsert 与 Rust 测试。
- `desktop/app/assets/晨间日记页面.js`：日记和 fallback 保存时保留排序。
- `desktop/app/assets/database-manager.js`：管理页行数据、收集和 fallback 保留排序。
- `desktop/app/index.html`：首页规范化与行内保存保留排序。
- `desktop/app/晨间日记页面.html`：目标关系页入口。
- `desktop/app/目标关系.html`：三列画布和 SVG 的静态结构。
- `desktop/app/assets/目标关系.css`：页面、卡片、拖拽、连线和横向滚动样式。
- `desktop/app/assets/目标关系.js`：数据筛选、渲染、SVG、操作状态与保存。
- `scripts/test-plan-relations.mjs`：无第三方依赖的真实 Chrome 回归测试；负责启动隔离 Chrome、注入 localStorage、驱动鼠标和读取断言。

---

### Task 1: PlanItem 持久化排序字段

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs:225-248`
- Modify: `desktop/src-tauri/src/lib.rs:1167-1169`
- Modify: `desktop/src-tauri/src/lib.rs:1353-1513`
- Test: `desktop/src-tauri/src/lib.rs:3078-3195`

**Interfaces:**
- Consumes: 现有 `PlanItem`、`read_csv`、`write_csv`、`upsert_plan_items`。
- Produces: `PlanItem { sort_order: u64 }`；同组排序键 `scope, period, sort_order, created_at, id`；新增事项自动补同组末尾顺序。

- [ ] **Step 1: 写旧 CSV 兼容、round-trip 和 upsert 失败测试**

在现有 `#[cfg(test)]` 模块新增：

```rust
#[test]
fn plan_item_sort_order_round_trip_and_legacy_default() {
    let dir = temp_dir("plan-item-sort-order");
    let path = dir.join("items.csv");
    write_csv(
        &path,
        &["item_id", "text", "done", "note", "scope", "period", "parent_id", "created_at", "updated_at"],
        vec![vec!["m1".into(), "月事项".into(), "No".into(), "".into(), "month".into(), "2026-10".into(), "".into(), "1".into(), "1".into()]],
    ).unwrap();
    let legacy = read_plan_item_database(&path).unwrap();
    assert_eq!(legacy.items[0].sort_order, 0);

    let mut database = legacy;
    database.items[0].sort_order = 7;
    write_plan_item_database(&path, &database).unwrap();
    assert_eq!(read_plan_item_database(&path).unwrap().items[0].sort_order, 7);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn upsert_sort_order_assigns_new_item_and_tracks_reorder() {
    let mut items = vec![sample_item("a", "month", "2026-10", false)];
    items[0].sort_order = 4;
    let mut incoming = sample_item("b", "month", "2026-10", false);
    incoming.sort_order = 0;
    assert!(upsert_plan_items(&mut items, vec![incoming], 10).unwrap());
    assert_eq!(items.iter().find(|item| item.id == "b").unwrap().sort_order, 5);

    let mut reordered = sample_item("a", "month", "2026-10", false);
    reordered.sort_order = 9;
    assert!(upsert_plan_items(&mut items, vec![reordered], 20).unwrap());
    let a = items.iter().find(|item| item.id == "a").unwrap();
    assert_eq!(a.sort_order, 9);
    assert_eq!(a.updated_at, Some(20));
}
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml sort_order`

Expected: 编译失败，明确指出 `PlanItem` 没有 `sort_order` 字段；该过滤器同时命中本任务两个新增测试。

- [ ] **Step 3: 实现最小 PlanItem 排序支持**

完成以下精确修改：

```rust
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
    #[serde(default)]
    sort_order: u64,
}

const PLAN_ITEM_CSV_HEADERS: &[&str] = &[
    "item_id", "text", "done", "note", "scope", "period", "parent_id", "created_at", "updated_at", "sort_order",
];
```

在 `sort_plan_items` 的 `period` 后插入 `.then(a.sort_order.cmp(&b.sort_order))`。所有 PlanItem 构造器显式补 `sort_order`；旧 CSV 和月度迁移用 `0`，CSV 读取用：

```rust
sort_order: csv_cell(&row, "sort_order").parse().unwrap_or(0),
```

CSV 写出在最后追加 `item.sort_order.to_string()`。upsert 的变更比较和更新包含 `sort_order`；新增时使用：

```rust
let sort_order = if item.sort_order == 0 {
    items.iter()
        .filter(|existing| existing.scope == scope && existing.period == period)
        .map(|existing| existing.sort_order)
        .max()
        .unwrap_or(0) + 1
} else {
    item.sort_order
};
```

把该值放入新 PlanItem。Rust 编译器指出的其余 PlanItem 初始化点只补字段，不改其他行为。

- [ ] **Step 4: 运行 Rust 全量测试**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml`

Expected: 所有测试通过，无编译警告。

- [ ] **Step 5: 提交**

```bash
git add desktop/src-tauri/src/lib.rs
git commit -m "feat(plan): 事项库增加持久化排序"
```

---

### Task 2: AnnualGoalItem 持久化排序字段

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs:251-270`
- Modify: `desktop/src-tauri/src/lib.rs:1158-1165`
- Modify: `desktop/src-tauri/src/lib.rs:1515-1610`
- Modify: `desktop/src-tauri/src/lib.rs:2670-2708`
- Test: `desktop/src-tauri/src/lib.rs` 现有测试模块

**Interfaces:**
- Consumes: Task 1 的排序字段模式。
- Produces: `AnnualGoalItem { sort_order: u64 }`；年度内排序 `sort_order, created_at, id`；新目标自动排所属年份末尾。

- [ ] **Step 1: 写年度目标失败测试**

```rust
#[test]
fn annual_goal_sort_order_defaults_and_round_trips() {
    let dir = temp_dir("annual-goal-sort-order");
    let path = dir.join("annual-goals.csv");
    write_csv(
        &path,
        &["year", "item_id", "text", "done", "created_at", "updated_at"],
        vec![vec!["2026".into(), "y1".into(), "旧目标".into(), "No".into(), "1".into(), "1".into()]],
    ).unwrap();
    let database = read_annual_goal_database(&path).unwrap();
    assert_eq!(database.years[0].items[0].sort_order, 0);

    let (items, changed) = normalize_annual_goal_items(
        "2026",
        vec![AnnualGoalItem {
            id: "y2".into(), text: "新目标".into(), done: false,
            created_at: Some(2), updated_at: Some(2), sort_order: 0,
        }],
        10,
        database.years.first(),
    );
    assert!(changed);
    assert_eq!(items[0].sort_order, 1);
}
```

再写一个 `annual_goal_reorder_updates_timestamp`：现有目标 `sort_order=1`，传入同文本同完成状态但 `sort_order=3`，断言 `changed=true`、`updated_at=Some(now)`。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml annual_goal_sort_order_defaults_and_round_trips`

Expected: 编译失败，明确指出 `AnnualGoalItem` 没有 `sort_order`。

- [ ] **Step 3: 实现年度目标排序**

为结构体增加 `#[serde(default)] sort_order: u64`，CSV headers 末尾追加 `"sort_order"`。普通行读取该列，普通行写出该值；`__YEAR__` 元数据行最后写 `"0"`。

读取每个年度记录后排序：

```rust
items.sort_by(|left, right| {
    left.sort_order.cmp(&right.sort_order)
        .then(left.created_at.cmp(&right.created_at))
        .then(left.id.cmp(&right.id))
});
```

把 `normalize_annual_goal_items` 改为可变 `next_order` 循环：初值是现有年度最大 `sort_order + 1`；只有新事项且传入 `0` 时取当前 `next_order` 并递增。`changed` 增加 `p.sort_order != item.sort_order`，输出保留计算后的 `sort_order`。其余初始化点补 `sort_order: 0`。

- [ ] **Step 4: 运行全量测试**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml`

Expected: 所有测试通过，无警告。

- [ ] **Step 5: 提交**

```bash
git add desktop/src-tauri/src/lib.rs
git commit -m "feat(plan): 年度目标增加持久化排序"
```

---

### Task 3: 既有前端保存不丢失排序，并建立浏览器回归入口

**Files:**
- Modify: `desktop/app/assets/晨间日记页面.js:641-689,880-912,1391-1418`
- Modify: `desktop/app/assets/database-manager.js:596-604,849-866,967-984,1227-1245,1347-1375`
- Modify: `desktop/app/index.html:3091-3128`
- Create: `scripts/test-plan-relations.mjs`

**Interfaces:**
- Consumes: Rust 返回的 `sort_order`。
- Produces: 所有前端 PlanItem/AnnualGoalItem 规范化结果含数值 `sort_order`；`node scripts/test-plan-relations.mjs` 可启动隔离 Chrome 并执行真实页面断言。

- [ ] **Step 1: 建立 Chrome 测试器并写排序保留失败用例**

测试器只用 `node:child_process`、`node:fs`、`node:os`、`node:path`、`node:url`、`node:assert/strict` 和 Node 24 全局 `WebSocket/fetch`。实现 `withChrome(run)`，向回调提供 `openPage(relativePath, width=1440, height=1000)`、`evaluate(expression)`、`mouse(type, x, y)` 和 `assert`。`openPage` 设置视口并加载文件，`evaluate` 使用 `Runtime.evaluate(returnByValue=true)`，`mouse` 使用 `Input.dispatchMouseEvent`。每个用例使用独立临时 profile，结束时等待 Chrome `exit` 后删除目录。

首个用例在 `晨间日记页面.html` 注入：

```js
localStorage.setItem("lifeos-db:items", JSON.stringify({schema_version:1,items:[{
  id:"m-sort",text:"保留月排序",done:false,note:"",scope:"month",period:"2026-10",
  parent_id:"",created_at:1,updated_at:1,sort_order:42
}]}));
localStorage.setItem("lifeos-db:annual-goals", JSON.stringify({schema_version:1,years:[{
  year:"2026",updated_at:1,items:[{id:"y-sort",text:"保留年排序",done:false,created_at:1,updated_at:1,sort_order:23}]
}]}));
location.reload();
```

在月输入框新增一条事项并等待保存，断言原 `m-sort.sort_order === 42`；修改年度目标并等待保存，断言 `y-sort.sort_order === 23`。核心断言直接读取真实 localStorage：

```js
const items = JSON.parse(localStorage.getItem("lifeos-db:items")).items;
const years = JSON.parse(localStorage.getItem("lifeos-db:annual-goals")).years;
assert.equal(items.find((item) => item.id === "m-sort").sort_order, 42);
assert.equal(years[0].items.find((item) => item.id === "y-sort").sort_order, 23);
```

另加入一条可见 inbox 事项 `i-sort.sort_order=17`，覆盖其余入口：

- `收集箱.html`：修改 `[data-item-id="i-sort"] [data-field="item-text"]` 并派发 `input`，等待文本写回后断言 `i-sort.sort_order === 17`。
- `年度目标管理.html`：修改 `[data-item-id="y-sort"] [data-field="goal-text"]` 并派发 `input`，等待文本写回后断言 `y-sort.sort_order === 23`。
- `index.html`：点击 `[data-preview-kind="item"][data-item-id="i-sort"]`，等待 done 写回后断言顺序仍为 17；点击 `[data-preview-kind="annual-goal"][data-item-id="y-sort"]`，断言顺序仍为 23。

- [ ] **Step 2: 运行并确认 RED**

Run: `node scripts/test-plan-relations.mjs`

Expected: 至少一个断言得到 `sort_order === 0` 或 `undefined`，明确指向现有前端规范化丢字段；测试器自身异常不算 RED，先修测试器。

- [ ] **Step 3: 保留所有前端排序字段**

三个文件的 PlanItem 与年度目标规范化结果统一增加：

```js
sort_order: Number(item.sort_order) || 0
```

`晨间日记页面.js` 额外修改：

- fallback upsert 的 `next` 和 `differs` 包含 `sort_order`；新增为 `0` 时按同组最大值补末尾。
- fallback 年度目标的 `changed` 比较与返回对象包含 `sort_order`；新目标按所属年份最大值补末尾。
- `normalisePlanItem` 和 `addPlanItem` 返回/创建该字段。
- `collectAnnualGoalsForDatabase` 从 `existing` 保留该字段，新目标返回 `sort_order: 0`。

`database-manager.js` 额外修改：

- PlanItem/年度目标行的 `<tr>` 增加 `data-sort-order="${Number(item.sort_order) || 0}"`。
- `collectItems` 和 `collectAnnualGoals` 从对应 `row.dataset.sortOrder` 读取数值。
- 两类新增行使用 `sort_order: 0`，行 DOM 同步该 dataset。

`index.html` 只需在两个规范化函数保留字段，现有保存会随之携带完整对象。

- [ ] **Step 4: 运行浏览器回归与语法检查**

Run:

```bash
node scripts/test-plan-relations.mjs
node --check desktop/app/assets/晨间日记页面.js
node --check desktop/app/assets/database-manager.js
node --check scripts/test-plan-relations.mjs
```

Expected: 所有排序保留断言通过，三个脚本均退出 0。

- [ ] **Step 5: 提交**

```bash
git add desktop/app/assets/晨间日记页面.js desktop/app/assets/database-manager.js desktop/app/index.html scripts/test-plan-relations.mjs
git commit -m "fix(plan): 既有页面保存保留事项顺序"
```

---

### Task 4: 三列关系页与 SVG 正式连线

**Files:**
- Modify: `desktop/app/晨间日记页面.html:280-285`
- Create: `desktop/app/目标关系.html`
- Create: `desktop/app/assets/目标关系.css`
- Create: `desktop/app/assets/目标关系.js`
- Modify: `scripts/test-plan-relations.mjs`

**Interfaces:**
- Consumes: `get_database_manager` 的完整 `items`、`annual_goals`；`LifeOSShared.weekKey/weekRangeLabel/formatDate`。
- Produces: `.relation-card[data-scope][data-item-id]`、`#weekCards/#monthCards/#yearCards`、`#relationSvg path[data-source][data-target]`、`[data-sort-handle]`、`[data-connect]`、`[data-disconnect]`。

- [ ] **Step 1: 写三列筛选与连线失败测试**

在浏览器测试器注入本周两条、本月两条、今年一条，设置 `w1.parent_id="m1"`、`m1.parent_id="y1"`、`w2.done=true`，并放入一条其他月份事项。打开 `目标关系.html`，定义并使用以下真实 DOM 断言：

```js
const cardIds = (scope) => Array.from(
  document.querySelectorAll(`.relation-card[data-scope="${scope}"]`),
  (card) => card.dataset.itemId
);
assert.deepEqual(cardIds("week"), ["w1", "w2"]);
assert.deepEqual(cardIds("month"), ["m1", "m2"]);
assert.deepEqual(cardIds("year"), ["y1"]);
assert.equal(document.querySelectorAll("#relationSvg path[data-source]").length, 2);
assert.equal(document.querySelector('#relationSvg path[data-source="w1"]').dataset.target, "m1");
assert.equal(document.querySelector('#relationSvg path[data-source="m1"]').dataset.target, "y1");
assert.ok(document.querySelector('[data-item-id="w2"]').classList.contains("is-done"));
```

另开 `晨间日记页面.html`，断言 `document.querySelector('.path-label a[href="目标关系.html"]')` 非空。给未关联卡、悬空 parent 和空年度列各加一条数据，断言未关联不画线，悬空显示“上级不可用”。

- [ ] **Step 2: 运行并确认 RED**

Run: `node scripts/test-plan-relations.mjs`

Expected: 新页面导航或文件加载失败，或找不到 `.relation-card`；不是断言脚本语法错误。

- [ ] **Step 3: 创建静态页面与样式**

`目标关系.html` 使用现有 window-frame 三个按钮、`wallpaperLayer`、返回晨间日记链接、周期标题、`#relationNotice`。画布结构固定为：

```html
<div class="relation-scroll" id="relationScroll">
  <div class="relation-board" id="relationBoard">
    <svg id="relationSvg" aria-hidden="true">
      <g id="relationLines"></g>
      <path id="temporaryLine" d="" />
    </svg>
    <div class="relation-columns">
      <section class="relation-column" data-column="week"><h2>本周</h2><div class="relation-cards" id="weekCards"></div></section>
      <section class="relation-column" data-column="month"><h2>本月</h2><div class="relation-cards" id="monthCards"></div></section>
      <section class="relation-column" data-column="year"><h2>今年</h2><div class="relation-cards" id="yearCards"></div></section>
    </div>
  </div>
</div>
```

脚本按顺序加载 `lifeos-shared.js`、`window-controls.js`、`app-background.js`、`目标关系.js`。新页面启动时调用 `window.LifeOSBackground.install({ layer: document.getElementById("wallpaperLayer") })`，不复制壁纸管理逻辑。

CSS 使用独立设计 token，不导入整份日记或管理页样式。关键规则：

```css
.relation-scroll { overflow: auto; }
.relation-board { position: relative; min-width: 960px; min-height: 420px; }
.relation-columns { display: grid; grid-template-columns: repeat(3, minmax(280px, 1fr)); gap: 64px; }
#relationSvg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.relation-cards { display: flex; flex-direction: column; gap: 14px; }
.relation-card { position: relative; z-index: 1; touch-action: none; }
.relation-card.is-done { opacity: .58; }
.relation-card.is-valid-target { outline: 2px solid var(--accent); }
#temporaryLine { display: none; }
@media (prefers-reduced-motion: reduce) { .relation-card { transition: none; } }
```

卡片包含文本、排序手柄、周/月连接点、断开按钮和不可用标记；按钮均有中文 `aria-label`。

- [ ] **Step 4: 实现读取、渲染和 SVG 曲线**

新 JS 使用 IIFE，状态定义为：

```js
const state = {
  snapshot: null,
  columns: { week: [], month: [], year: [] },
  saving: false,
  drag: null,
  connection: null,
  drawFrame: 0
};
```

`boot()` 通过 Tauri `get_database_manager` 或 localStorage 读取完整快照；按当前 `weekKey(formatDate(new Date()))`、`YYYY-MM`、`YYYY` 筛选，排序比较 `sort_order || 0`、`created_at || 0`、`id`。读取失败时在 `#relationNotice` 显示错误并禁用画布操作，不进入可编辑状态。

渲染时保留完整 `state.snapshot`，只把筛选结果放入 `state.columns`。卡片操作按钮先输出稳定 DOM 接口，事件在后续任务接入。

正式关系只从可见 Map 查找目标。每个关系创建一个 `<path>`，设置 `data-source`、`data-target`。重绘函数：

```js
function curvePath(source, target) {
  const bend = (target.x - source.x) / 2;
  return `M ${source.x} ${source.y} C ${source.x + bend} ${source.y}, ${target.x - bend} ${target.y}, ${target.x} ${target.y}`;
}

function boardPoint(rect, side) {
  const boardRect = document.getElementById("relationBoard").getBoundingClientRect();
  return {
    x: (side === "right" ? rect.right : rect.left) - boardRect.left,
    y: rect.top + rect.height / 2 - boardRect.top
  };
}
```

`drawLines()` 对每个关系取 source right 和 target left，调用 `curvePath`；`scheduleDraw()` 用单个 `requestAnimationFrame` 合并。`ResizeObserver` 观察 board 和三列，`document.fonts.ready.then(scheduleDraw)`，窗口 resize 同样调度。

日记入口放在 `.path-label` 内：

```html
<a class="relation-entry" href="目标关系.html">目标关系 →</a>
```

- [ ] **Step 5: 运行 GREEN 与语法检查**

Run:

```bash
node scripts/test-plan-relations.mjs
node --check desktop/app/assets/目标关系.js
```

Expected: Task 3 回归仍通过，三列筛选、空列、悬空标记、两条 SVG 关系和入口断言通过。

- [ ] **Step 6: 提交**

```bash
git add desktop/app/晨间日记页面.html desktop/app/目标关系.html desktop/app/assets/目标关系.css desktop/app/assets/目标关系.js scripts/test-plan-relations.mjs
git commit -m "feat(plan): 新增周月年目标关系图"
```

---

### Task 5: 拖拽排序、实时跟随与失败回滚

**Files:**
- Modify: `desktop/app/assets/目标关系.js`
- Modify: `desktop/app/assets/目标关系.css`
- Modify: `scripts/test-plan-relations.mjs`

**Interfaces:**
- Consumes: Task 4 的卡片、SVG、完整快照。
- Produces: `saveSnapshot(before, "items" | "annual")`；排序后当前列 `sort_order=1..N`；保存期间 `state.saving=true`。

- [ ] **Step 1: 写拖动、刷新保持和回滚失败测试**

用 CDP 鼠标从 `w1` 的 `[data-sort-handle]` 中心拖到同列另一卡片下方。`mouseMoved` 后、松开前读取 `path[data-source="w1"]` 的 `d`，断言与拖动前不同；松开后断言 DOM 顺序和 localStorage 顺序一致且为 `1,2`。刷新页面，断言顺序不变。

年度列执行同样拖动，断言只改变 `lifeos-db:annual-goals`，`lifeos-db:items` 字符串不变。

回滚用例在操作前执行：

```js
window.__originalSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function (key, value) {
  if (key === "lifeos-db:items") throw new Error("模拟保存失败");
  return window.__originalSetItem.call(this, key, value);
};
```

拖动后断言原 DOM/localStorage 顺序不变且提示失败，再恢复 `Storage.prototype.setItem`。

- [ ] **Step 2: 运行并确认 RED**

Run: `node scripts/test-plan-relations.mjs`

Expected: 拖动后 DOM 顺序不变，测试明确失败在排序未实现。

- [ ] **Step 3: 实现统一保存与回滚**

```js
async function saveSnapshot(before, target) {
  state.saving = true;
  setControlsDisabled(true);
  setNotice("正在保存…");
  try {
    if (target === "items") {
      const saved = await invoke("save_plan_item_database", { items: state.snapshot.items.items });
      state.snapshot.items = saved;
    } else {
      const saved = await invoke("save_annual_goal_database", { years: state.snapshot.annual_goals.years });
      state.snapshot.annual_goals = saved;
    }
    setNotice("已保存", "saved");
  } catch (error) {
    state.snapshot = before;
    render();
    setNotice(`保存失败，已撤销：${error.message || error}`, "error");
  } finally {
    state.saving = false;
    setControlsDisabled(false);
    scheduleDraw();
  }
}
```

fallback 保存规范化和 localStorage key 与 Task 3 一致。操作前统一使用 `const before = structuredClone(state.snapshot)`；保存期间事件入口直接返回。

- [ ] **Step 4: 实现 Pointer Events 排序**

在手柄 `pointerdown` 记录 `{card, list, pointerId, startY}` 并 `setPointerCapture`。`pointermove` 只做三件事：设置卡片 `transform: translateY(delta)`、根据兄弟卡片中点 `insertBefore` 调整同列 DOM、调用 `scheduleDraw()`。

`pointerup` 清除 transform 和 dragging 类，读取当前列 DOM id，修改完整快照中对应事项的 `sort_order=index+1`，再调用 `saveSnapshot(before, scope === "year" ? "annual" : "items")`。顺序未变化不保存。`pointercancel` 直接恢复 before 快照并 render。

增加 `.relation-card.is-dragging { z-index: 2; box-shadow: var(--drag-shadow); }`，手柄与连接点使用不同按钮和事件入口，事件不互相冒泡触发。

- [ ] **Step 5: 运行完整浏览器回归**

Run: `node scripts/test-plan-relations.mjs`

Expected: 拖动中曲线变化、落点顺序、刷新保持、年度独立保存和两种失败回滚全部通过；Task 3/4 不回归。

- [ ] **Step 6: 提交**

```bash
git add desktop/app/assets/目标关系.js desktop/app/assets/目标关系.css scripts/test-plan-relations.mjs
git commit -m "feat(plan): 关系卡片支持拖拽排序"
```

---

### Task 6: 手动连接、替换、断开与非法目标取消

**Files:**
- Modify: `desktop/app/assets/目标关系.js`
- Modify: `desktop/app/assets/目标关系.css`
- Modify: `scripts/test-plan-relations.mjs`

**Interfaces:**
- Consumes: Task 5 的 `saveSnapshot`、调度重绘和完整快照。
- Produces: 连接点拖拽更新 `parent_id`；`#temporaryLine` 跟随指针；断开按钮清空 `parent_id`。

- [ ] **Step 1: 写连线行为失败测试**

通过 CDP 鼠标覆盖：

1. 从 `[data-item-id="w2"] [data-connect]` 拖到 `m2` 卡中心，断言 `w2.parent_id="m2"` 且新增对应 path。
2. 再把 `w2` 连到 `m1`，断言旧 path 消失、新 path 出现，数据库只有一个 `parent_id`。
3. 从 `w1` 拖到 `y1`，断言数据不变；拖到空白同样不变。
4. 月卡 `m2` 连接 `y1`，断言保存成功。
5. 点击 `w2` 的 `[data-disconnect]`，断言 path 消失且 `parent_id=""`。
6. 对连接和断开分别注入一次 setItem 失败，断言原 parent 和原 path 恢复。

- [ ] **Step 2: 运行并确认 RED**

Run: `node scripts/test-plan-relations.mjs`

Expected: 第一条连接后 parent 仍为空，明确失败在手动连线未实现。

- [ ] **Step 3: 实现连接手势**

`pointerdown` 只从 `[data-connect]` 启动，记录源 id/scope/pointerId，显示 `#temporaryLine`，给合法目标列添加 `.is-valid-target`。合法映射固定：

```js
const TARGET_SCOPE = { week: "month", month: "year" };
```

`pointermove` 把 client 坐标转换为 board 坐标，以源卡片 right 中点和当前指针调用 `curvePath`，更新临时 path。`pointerup` 使用 `document.elementFromPoint(event.clientX, event.clientY)?.closest(".relation-card")` 找目标，检查 `target.dataset.scope === TARGET_SCOPE[sourceScope]`。

合法且 parent 有变化时，保存 before、修改完整快照中源事项的 `parent_id`、render、调用 `saveSnapshot(before, "items")`；其他情况只清理临时状态。无论成功或取消，都移除高亮、清空临时 path、释放 pointer capture。

- [ ] **Step 4: 实现断开与不可用引用清理**

事件代理监听 `[data-disconnect]`：找到完整快照中的源事项，保存 before 后设 `parent_id=""`，render 并保存 items。`parent_id` 已为空不保存。该入口同时用于正常上级和“上级不可用”。

- [ ] **Step 5: 运行完整浏览器回归**

Run: `node scripts/test-plan-relations.mjs`

Expected: 连接、替换、非法取消、断开、两种回滚均通过，既有排序和渲染测试不回归。

- [ ] **Step 6: 提交**

```bash
git add desktop/app/assets/目标关系.js desktop/app/assets/目标关系.css scripts/test-plan-relations.mjs
git commit -m "feat(plan): 支持手动连接和断开目标"
```

---

### Task 7: 生命周期、窄屏与真实 Tauri 全链路验收

**Files:**
- Modify: `desktop/app/assets/目标关系.js`
- Modify: `desktop/app/assets/目标关系.css`
- Modify: `scripts/test-plan-relations.mjs`

**Interfaces:**
- Consumes: Task 4–6 完整页面。
- Produces: 可交付关系页；保存中离开警告；真实 Tauri 与 fallback 一致性证据。

- [ ] **Step 1: 写窄屏和生命周期失败测试**

浏览器测试在 440×843 视口打开页面，断言：

```js
assert.ok(relationScroll.scrollWidth > relationScroll.clientWidth);
assert.equal(new Set([...document.querySelectorAll('.relation-column')].map(el => Math.round(el.getBoundingClientRect().top))).size, 1);
```

横向滚动后检查每条 path 的端点仍与对应卡片 side 中点一致。保存中触发 `beforeunload`，断言事件被阻止；保存结束后不再阻止。检查页面无永久 `requestAnimationFrame` 循环、控制台无未处理错误。

- [ ] **Step 2: 运行并确认 RED**

Run: `node scripts/test-plan-relations.mjs`

Expected: 至少生命周期断言失败；若窄屏已因 Task 4 样式通过，不修改其样式，只保留回归证据。

- [ ] **Step 3: 最小实现生命周期处理**

```js
window.addEventListener("beforeunload", (event) => {
  if (!state.saving) return;
  event.preventDefault();
  event.returnValue = "";
});
```

`setControlsDisabled` 必须同时禁用排序手柄、连接点和断开按钮，但不禁用横向滚动。窄屏只调整外边距，不改变三列 grid 或 SVG 坐标系。

- [ ] **Step 4: 运行全部自动检查**

Run:

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml
node --check desktop/app/assets/晨间日记页面.js
node --check desktop/app/assets/database-manager.js
node --check desktop/app/assets/目标关系.js
node --check scripts/test-plan-relations.mjs
node scripts/test-plan-relations.mjs
git diff --check
```

Expected: Rust 全量通过；所有 JS 语法检查通过；真实 Chrome 用例全部通过；diff 无空白错误。

- [ ] **Step 5: 用隔离 vault 验收真实 Tauri**

使用独立 identifier `com.lifeos.morning-journal.relation-acceptance` 和临时 vault，避免接管正在运行的正式应用。向 `00-Databases/items.csv` 与 `annual-goals.csv` 写入不带 `sort_order` 的两条周事项、两条月事项、一条年事项，启动：

```bash
npm --prefix desktop run tauri:dev -- --no-dev-server --config '{"identifier":"com.lifeos.morning-journal.relation-acceptance"}'
```

在真实页面逐项执行并读取 CSV 验证：旧文件可打开；周排序写入 `1,2`；月排序和年排序互不影响；周→月、月→年连接和替换写回 parent；断开后为空；其他月份与 inbox 原样保留；重启顺序不变；日记和收集箱再次保存后 sort_order 不丢。临时验收文件和 vault 在成功后删除，不关闭用户已有应用。

- [ ] **Step 6: 提交最终验收改动**

```bash
git add desktop/app/assets/目标关系.js desktop/app/assets/目标关系.css scripts/test-plan-relations.mjs
git commit -m "test(plan): 覆盖关系图生命周期与窄屏"
git status --short
```

Expected: 提交成功，工作区干净；若 Step 3/5 没有产生源码改动，不创建空提交，只运行 `git status --short`。
