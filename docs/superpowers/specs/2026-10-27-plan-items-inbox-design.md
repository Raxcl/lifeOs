# 计划事项一张表 + 收集箱 设计

日期：2026-10-27

## 1. 目标

把「以终为始」的链条在产品里补全：年 → 月 → 周 → 日。

- 日记页「看见未来」从 2 格变 3 格：本周推进 / 本月重要几件事 / 年度目标，全页凑成 9 格。
- 「本月重要几件事」回归严格的月计划，不再兼任收集箱。
- 新增收集箱页：所有未归属的事项 + 所有过期未完成的事项，在这里重新归属到周/月/年。
- 年度目标表本次不动。

## 2. 已拍板的三条规则

1. **过期未完成不自动顺延，回收集箱。** 不改数据，只改视图：收集箱 = `scope=inbox` ∪ `done=false 且 period < 当前期`。收集箱页显示原归属（如「2026-10 月计划」），重新归属时就是一次复盘。
2. **周 key 用周一日期** `YYYY-MM-DD`（周一到周日为一周）。与 `date` 同格式，不处理 ISO 周跨年。
3. **年度目标暂不并表。** `parent_id` 可以指向 `annual-goals.csv` 里的 `item_id`，先接受跨表引用。

## 3. 数据模型

### 3.1 `items.csv`（取代 `monthly-important.csv`）

| 列 | 说明 |
|---|---|
| `item_id` | 字符串主键，沿用现有生成规则 |
| `text` | 事项文本，空则跳过该行 |
| `done` | `true/false` |
| `note` | 备注 |
| `scope` | `inbox` / `week` / `month` / `year`。本次 `year` 只预留，不写入 |
| `period` | `scope=week` 为周一日期；`scope=month` 为 `YYYY-MM`；`scope=inbox` 为空 |
| `parent_id` | 上一级事项 id（周→月事项 id，月→年度目标 item_id），可空 |
| `created_at` / `updated_at` | 秒级时间戳 |

Rust 侧结构：

```rust
struct PlanItem {
    id: String,
    text: String,
    done: bool,
    note: String,
    scope: String,      // inbox | week | month | year
    period: String,     // 依 scope 校验格式；inbox 必须为空
    parent_id: String,
    created_at: Option<u64>,
    updated_at: Option<u64>,
}
struct PlanItemDatabase { schema_version: u8, items: Vec<PlanItem> }
```

校验：`scope=week` → `parse_date` 且必须是周一；`scope=month` → `parse_month`；`scope=inbox` → `period` 为空；其余报错。

### 3.2 迁移

读取时按以下顺序，只在第一次发生：

1. `items.csv` 不存在且 `monthly-important.csv` 存在 → 读老表，每行映射为 `scope=month, period=<month>, parent_id=""`，写入 `items.csv`。老文件原地保留、不再读取，用户想清理自己删。
2. 两者都不存在 → 建空 `items.csv`。

`read_csv` 对缺列返回空字符串，所以 `items.csv` 自己后续加列不需要再做迁移。

### 3.3 删除的结构

`MonthlyItem` / `MonthlyRecord` / `MonthlyBacklogItem` / `MonthlyDatabase` / `MONTHLY_CSV_HEADERS` / `collect_monthly_backlog` / `apply_monthly_backlog` / `normalize_monthly_items_preserve` 全部删除，不保留兼容层。

## 4. 后端命令

### 4.1 `get_journal_databases(date)`

返回体中 `monthly` + `monthly_backlog` 两个字段换成一个：

```
plan_items: Vec<PlanItem>   // scope=week&period=本周一  ∪  scope=month&period=本月，含已完成
```

`paths.monthly` 改名 `paths.items`。

### 4.2 `save_journal_databases(...)`

参数 `monthly: Vec<MonthlyItem>` + `monthly_backlog` 换成 `plan_items: Vec<PlanItem>`。语义是**按 id upsert**：

- 传入的每条按 id 找到则比较 text/done/note/scope/period/parent_id，有变化才更新 `updated_at`；
- 找不到则新增，`created_at = now`；
- 库里有、传入没有的**不动**（日记页不能删事项，删除只在收集箱页）。
- 任一变化才写文件，沿用现有「无变化不写」的约定。

### 4.3 `get_journal_database_manager` / `save_plan_item_database(items: Vec<PlanItem>)`

管理页用。`save_plan_item_database` 是**全量替换**（这是唯一能删事项的入口），替换前逐条校验 scope/period，写入前按 `scope, period, created_at` 排序。`save_monthly_database` 删除。

### 4.4 周一计算

`fn week_key(date: &str) -> Result<String, String>`：解析 `date`，回退到周一。前端对应 `weekKey(dateStr)`，两边都要有，因为 fallback 模式走 localStorage。

## 5. 日记页（`晨间日记页面.html` / `.js` / `.css`）

### 5.1 布局

`.future-content` 去掉 `duo`，三格顺序：**本周推进** → **本月重要几件事** → **年度目标**。年度目标卡不动。

### 5.2 本周推进（新卡，第 7 格）

- 标题「本周推进」，右上角 `WEEK · MM.DD–MM.DD`（本周一到周日）。
- 列表：`scope=week && period=本周一` 的全部事项，未完成在前，已完成划线在后；复选框切换 done。
- 底部一行输入 + 加号：新增 `scope=week, period=本周一, parent_id=""`。
- 不在这张卡上选 parent。关联在收集箱页做。

### 5.3 本月重要几件事（第 8 格，收窄）

- 数据源从 `monthly_backlog` 改成 `scope=month && period=本月`，**不再显示其他月份的未完成**。
- 列表规则与周卡一致：未完成在前，已完成划线在后。
- 新增走 `scope=month, period=本月`。
- 右上角 `done/total` 按本月事项算。
- 「未完成事项 / 表格 · 月度」小字改为「本月事项 / 表格 · 本月」。

### 5.4 表单状态

`state.form.todos` 拆成 `state.form.weekItems` / `state.form.monthItems`，元素形态都是 `PlanItem`。`databasePayloadFromForm` 输出 `planItems = [...weekItems, ...monthItems]`。

### 5.5 localStorage fallback

key `lifeos-db:monthly-important` 改 `lifeos-db:items`，形态 `{ schema_version: 1, items: [] }`。首次读取若发现老 key 存在而新 key 不存在，做同样的映射迁移后删除老 key。

### 5.6 Markdown 导出与解析

`buildMarkdown` 的 `## 看见未来` 改为两个二级标题：

```
## 本周推进
- [ ] 文本
## 本月重要几件事
- [x] 文本
```

`parseMarkdown`：优先读新标题；读不到则把旧 `## 看见未来` 下的行当作本月事项（兼容老日记）。Markdown 只是 DB 不可用时的兜底，DB 存在时 `mergeDatabasesToForm` 仍然覆盖。

## 6. 收集箱页（`本月重要几件事管理.html` → `收集箱.html`）

沿用 `database-manager.js` 的壳，`config.monthly` 改为 `config.items`：

```
mark: "收", title: "收集箱", subtitle: "未归属 + 过期未完成；在这里决定它属于哪一周、哪个月。"
pathKey: "items", saveCommand: "save_plan_item_database", fileName: "items.csv"
```

### 6.1 视图切换（顶部 tab）

| tab | 过滤规则 | 默认 |
|---|---|---|
| 收集箱 | `scope=inbox` ∪ (`done=false` 且 `period < 当前期`) | ✓ |
| 本周 | `scope=week && period=本周一` | |
| 本月 | `scope=month && period=本月` | |
| 全部 | 不过滤 | |

「当前期」按 scope 比：week 用本周一，month 用本月。

### 6.2 行内容

每行：复选框(done) · 文本(可编辑) · 归属控件 · 来源标签 · 备注 · 删除。

- **归属控件**：一个下拉 `收集箱 / 本周 / 本月 / 指定…`。选「本周」「本月」直接写 scope+period；选「指定…」展开一个 `<input type="date">`（week 自动回退到周一）或 `<input type="month">`。
- **来源标签**：仅在「收集箱」tab 且为过期项时显示，如 `2026-10 月 · 未完成` 或 `10.20 周 · 未完成`。
- **上级**：下拉列出可选父项——`scope=week` 的可选本月及之后的 month 事项；`scope=month` 的可选当年年度目标（从 `annual_goals` 快照读）。不做反向校验，父项被删只是 `parent_id` 悬空，显示为「—」。
- 新增一行默认 `scope=inbox`。

### 6.3 保存

点「保存」把当前内存里的全量 items 发 `save_plan_item_database`。fallback 写 `lifeos-db:items`。

## 7. 首页（`index.html`）

- 预览卡「本月重要几件事」改为「收集箱」：meta 显示 `N 项待归属`（按 6.1 的收集箱规则算），列表最多 5 条，「管理」链接到 `收集箱.html`。
- `databaseFallbackKeys.monthly` → `items`，vault 路径 → `items.csv`，`save_monthly_database` 分支 → `save_plan_item_database`。
- 首页行内编辑的 `kind === "monthly"` 分支（约 `index.html:3310` / `:3375`）改为 `kind === "items"`，形态按 PlanItem，保存走 `save_plan_item_database`。

## 8. 不做

- 拖拽连线、可视化树。
- 年度目标并表。
- 三只青蛙与周计划联动。
- 自动顺延、自动归档。
- `scope=year` 的写入。

## 9. 测试

Rust（`cargo test`，放 `lib.rs` 现有测试模块）：

- `week_key`：周一/周三/周日/跨月/跨年各一例。
- 读旧 `monthly-important.csv` → 迁移后 `items.csv` 行数一致、`scope=month`、`period` 正确、老文件已改名。
- `save_journal_databases` upsert：改 done 只更新该条 `updated_at`；传空数组不删任何行；传入非周一的 week period 报错。
- `save_plan_item_database`：全量替换能删行；`scope=inbox` 带 period 报错。

前端（手工，Tauri dev 跑起来）：

- 日记页三格出现、周区间文案正确；在周卡新增 → 刷新仍在；勾完成 → 月卡计数变化。
- 把一条本月事项的 period 改成上月 → 日记页月卡不再显示，收集箱页「收集箱」tab 出现且带来源标签。
- 收集箱页删除一条 → 日记页消失。
- 断开后端（浏览器直接打开）走 localStorage，同样流程跑一遍；老 key 自动迁移。
- 老日记 .md 的 `## 看见未来` 仍能被解析出来。
