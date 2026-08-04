(() => {
  const {
    formatDate,
    nowSeconds,
    escapeHtml,
    toErrorMessage,
    formatTimestamp,
    defaultHabitDefinitions
  } = window.LifeOSShared;
  const isDate = window.LifeOSShared.isDateKey;
  const isMonth = window.LifeOSShared.isMonthKey;
  const isYear = (value) => /^\d{4}$/.test(String(value || ""));
  const managerType = document.body.dataset.manager;
  const today = new Date();
  const currentDate = formatDate(today);
  const currentMonth = currentDate.slice(0, 7);
  const currentYear = currentDate.slice(0, 4);
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const fallbackKeys = {
    frogs: "lifeos-db:frogs",
    habits: "lifeos-db:habits",
    monthly: "lifeos-db:monthly-important",
    annualGoals: "lifeos-db:annual-goals"
  };

  const config = {
    frogs: {
      mark: "青",
      title: "三只青蛙管理",
      subtitle: "按任务管理所有青蛙；未完成优先，日期只是关联日记。",
      pathKey: "frogs",
      saveCommand: "save_frog_database",
      fileName: "frogs.csv"
    },
    habits: {
      mark: "习",
      title: "习惯坚持管理",
      subtitle: "维护习惯定义，并通过统计图查看坚持情况。",
      pathKey: "habits",
      saveCommand: "save_habit_database",
      fileName: "habits.csv"
    },
    monthly: {
      mark: "月",
      title: "本月重要几件事管理",
      subtitle: "按事项管理月度目标；未完成优先，月份只是归属字段。",
      pathKey: "monthly",
      saveCommand: "save_monthly_database",
      fileName: "monthly-important.csv"
    },
    "annual-goals": {
      mark: "年",
      title: "年度目标管理",
      subtitle: "按年度管理目标；未完成优先，年份只是归属字段。",
      pathKey: "annual_goals",
      saveCommand: "save_annual_goal_database",
      fileName: "annual-goals.csv"
    }
  };

  const view = config[managerType] || config.frogs;
  const el = {
    mark: document.getElementById("managerMark"),
    title: document.getElementById("managerTitle"),
    subtitle: document.getElementById("managerSubtitle"),
    path: document.getElementById("databasePath"),
    summary: document.getElementById("summaryGrid"),
    workspaceTitle: document.getElementById("workspaceTitle"),
    workspaceSubtitle: document.getElementById("workspaceSubtitle"),
    toolbar: document.getElementById("toolbar"),
    list: document.getElementById("recordList"),
    notice: document.getElementById("notice")
  };

  const state = {
    snapshot: null,
    saveTimer: null,
    booted: false
  };

  boot();

  async function boot() {
    el.mark.textContent = view.mark;
    el.title.textContent = view.title;
    el.subtitle.textContent = view.subtitle;
    el.workspaceTitle.textContent = view.title.replace("管理", "");
    el.workspaceSubtitle.textContent = "这里按对象管理数据，修改会写回独立 CSV，并同步影响晨间日记。";
    setNotice("正在读取数据库...");

    try {
      state.snapshot = normalizeSnapshot(await invoke("get_database_manager", {}));
      state.booted = true;
      render();
      setNotice(tauriInvoke ? "已连接本地数据库。" : "当前是浏览器预览，数据会临时保存在本地缓存。", "saved");
    } catch (error) {
      setNotice(toErrorMessage(error), "error");
    }
  }

  async function invoke(command, args) {
    if (tauriInvoke) return tauriInvoke(command, args);
    return fallbackInvoke(command, args);
  }

  async function fallbackInvoke(command, args) {
    if (command === "get_database_manager") {
      return {
        frogs: readFallback(fallbackKeys.frogs, defaultFrogs()),
        habits: readFallback(fallbackKeys.habits, defaultHabits()),
        monthly: readFallback(fallbackKeys.monthly, defaultMonthly()),
        annual_goals: readFallback(fallbackKeys.annualGoals, defaultAnnualGoals()),
        paths: {
          frogs: `本机预览 / LifeOS-Vault / 00-Databases / ${config.frogs.fileName}`,
          habits: `本机预览 / LifeOS-Vault / 00-Databases / ${config.habits.fileName}`,
          monthly: `本机预览 / LifeOS-Vault / 00-Databases / ${config.monthly.fileName}`,
          annual_goals: `本机预览 / LifeOS-Vault / 00-Databases / ${config["annual-goals"].fileName}`
        }
      };
    }

    if (command === "save_frog_database") {
      const database = { schema_version: 1, days: normalizeFrogDays(args.days || []) };
      localStorage.setItem(fallbackKeys.frogs, JSON.stringify(database));
      return database;
    }

    if (command === "save_habit_database") {
      const definitions = normalizeDefinitions(args.definitions || []);
      const database = {
        schema_version: 1,
        definitions,
        days: normalizeHabitDays(args.days || [], definitions)
      };
      localStorage.setItem(fallbackKeys.habits, JSON.stringify(database));
      return database;
    }

    if (command === "save_monthly_database") {
      const database = { schema_version: 1, months: normalizeMonths(args.months || []) };
      localStorage.setItem(fallbackKeys.monthly, JSON.stringify(database));
      return database;
    }

    if (command === "save_annual_goal_database") {
      const database = { schema_version: 1, years: normalizeAnnualGoalYears(args.years || []) };
      localStorage.setItem(fallbackKeys.annualGoals, JSON.stringify(database));
      return database;
    }

    throw new Error(`未支持的命令：${command}`);
  }

  function render() {
    el.path.textContent = state.snapshot.paths?.[view.pathKey] || view.fileName;
    if (managerType === "habits") {
      renderHabits();
    } else if (managerType === "monthly") {
      renderMonthly();
    } else if (managerType === "annual-goals") {
      renderAnnualGoals();
    } else {
      renderFrogs();
    }
    initColumnCopy();
    initColumnResize();
  }

  function renderFrogs() {
    const tasks = sortFrogTasks(flattenFrogTasks(state.snapshot.frogs.days));
    const doneItems = tasks.filter((item) => item.done).length;
    const openItems = tasks.length - doneItems;
    const dateCount = new Set(tasks.map((item) => item.date)).size;
    setSummary([
      ["待处理", `${openItems} 只`],
      ["青蛙总数", `${tasks.length} 只`],
      ["已完成", `${doneItems} 只`]
    ]);
    el.toolbar.innerHTML = `
      <div class="toolbar-group filter-group" aria-label="筛选条件">
        <label class="toolbar-field search-field">
          <span>搜索</span>
          <input type="search" id="searchQuery" data-filter="search" placeholder="任务关键词" aria-label="搜索青蛙任务">
        </label>
        <label class="toolbar-field">
          <span>状态</span>
          <select id="statusFilter" data-filter="status" aria-label="状态筛选">
            <option value="open" selected>未完成</option>
            <option value="all">全部</option>
            <option value="done">已完成</option>
          </select>
        </label>
        <label class="toolbar-field">
          <span>日期</span>
          <input type="date" id="dateFilter" data-filter="date" aria-label="关联日期筛选">
        </label>
      </div>
      <div class="toolbar-group create-group" aria-label="新增记录">
        <label class="toolbar-field">
          <span>新增日期</span>
          <input type="date" id="newDate" aria-label="新增青蛙关联日期">
        </label>
        <button class="btn secondary" type="button" data-action="add-frog-item">新增青蛙</button>
      </div>
    `;
    el.list.innerHTML = tasks.length ? `
      <div class="table-area">
        <div class="table-scroll">
          <table class="data-table" aria-label="三只青蛙任务表">
            <thead>
              <tr>
                <th>完成</th>
                <th>青蛙任务</th>
                <th>描述</th>
                <th>关联日期</th>
                <th>序号</th>
                <th>创建时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              ${tasks.map(renderFrogTask).join("")}
            </tbody>
          </table>
        </div>
        <div class="action-sidebar">
          <div class="action-sidebar-head">操作</div>
          <div class="action-sidebar-list"></div>
        </div>
      </div>
      <p class="table-note">共关联 ${dateCount} 个日记日期；筛选只影响显示，不会删掉隐藏记录。</p>
    ` : emptyState("还没有三只青蛙记录。可以先新增一只青蛙，再选择关联日期。");
    applyCurrentFilters();
    if (tasks.length) initActionSidebar(tasks.length);
    applyCurrentFilters();
  }

  function renderFrogTask(task) {
    return `
      <tr class="data-row" data-kind="frog-item" data-row data-done="${task.done ? "true" : "false"}" data-date="${escapeAttr(task.date)}" data-slot="${escapeAttr(task.slot)}" data-search="${escapeAttr(task.text)}" data-created-at="${task.created_at || ""}">
        <td><input type="checkbox" data-field="frog-done" ${task.done ? "checked" : ""} aria-label="完成状态"></td>
        <td><input type="text" data-field="frog-text" value="${escapeAttr(task.text)}" placeholder="青蛙任务"></td>
        <td><input type="text" data-field="frog-note" value="${escapeAttr(task.note)}"></td>
        <td><input type="date" data-field="frog-date" value="${escapeAttr(task.date)}" aria-label="关联日期"></td>
        <td class="readonly-cell">
          <input type="hidden" data-field="frog-slot" value="${escapeAttr(task.slot)}">
          <span class="readonly-token" data-slot-display>#${escapeHtml(task.slot)}</span>
        </td>
        <td class="readonly-cell">${formatTimestamp(task.created_at) || '<span class="muted">—</span>'}</td>
        <td>${statusPill(task.done)}</td>
      </tr>
    `;
  }

  function renderHabits() {
    const definitions = state.snapshot.habits.definitions.length
      ? state.snapshot.habits.definitions
      : defaultHabitDefinitions();
    const days = [...state.snapshot.habits.days].sort((a, b) => a.date.localeCompare(b.date));
    const selectedMonth = getMatrixMonth();
    const monthDates = getMonthDates(selectedMonth);
    const monthDateSet = new Set(monthDates);
    const checkedCount = days.reduce((sum, day) => sum + Object.values(day.checks || {}).filter(Boolean).length, 0);
    const monthCheckedCount = days
      .filter((day) => monthDateSet.has(day.date))
      .reduce((sum, day) => sum + Object.values(day.checks || {}).filter(Boolean).length, 0);
    setSummary([
      ["习惯数量", `${definitions.length} 个`],
      ["本月打卡", `${monthCheckedCount} 次`],
      ["历史完成", `${checkedCount} 次`]
    ]);
    el.toolbar.innerHTML = `
      <div class="toolbar-group filter-group" aria-label="统计月份">
        <label class="toolbar-field">
          <span>统计月份</span>
          <input type="month" id="matrixMonth" value="${escapeAttr(selectedMonth)}" aria-label="统计月份">
        </label>
        <button class="btn secondary" type="button" data-action="show-habit-month">查看统计</button>
      </div>
      <div class="toolbar-group create-group" aria-label="新增记录">
        <button class="btn secondary" type="button" data-action="add-habit-definition">新增习惯</button>
      </div>
    `;
    el.list.innerHTML = `
      <section class="record" data-kind="habit-definitions">
        <div class="record-head">
          <div class="record-title">
            <strong>习惯定义</strong>
            <span class="muted">晨间日记会按这里的定义动态显示打卡项</span>
          </div>
        </div>
        <div class="table-area">
          <div class="table-scroll">
            <table class="data-table compact-table habit-definition-table" aria-label="习惯定义表">
              <thead>
                <tr>
                  <th>习惯名称</th>
                  <th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                ${definitions.map((definition) => `
                  <tr class="definition-row" data-created-at="${definition.created_at || ""}">
                    <td>
                      <input type="hidden" data-field="habit-id" value="${escapeAttr(definition.id)}">
                      <input type="text" data-field="habit-label" value="${escapeAttr(definition.label)}" aria-label="习惯名称">
                    </td>
                    <td class="readonly-cell">${formatTimestamp(definition.created_at) || '<span class="muted">—</span>'}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
          <div class="action-sidebar">
            <div class="action-sidebar-head">操作</div>
            <div class="action-sidebar-list"></div>
          </div>
        </div>
      </section>
      ${renderHabitStats(definitions, days, monthDates)}
    `;
    if (definitions.length) initActionSidebar(definitions.length, "delete-definition");
  }

  function renderHabitStats(definitions, days, monthDates) {
    const month = getMatrixMonth();
    const byDate = new Map(days.map((day) => [day.date, day.checks || {}]));
    const recentMonths = lastMonths(month, 6);
    const cards = definitions.map((definition) => {
      const monthDone = monthDates.filter((date) => byDate.get(date)?.[definition.id]).length;
      const totalDone = days.filter((day) => day.checks?.[definition.id]).length;
      const streak = currentStreak(byDate, definition.id);
      const monthRate = monthDates.length ? Math.round((monthDone / monthDates.length) * 100) : 0;
      const monthCounts = recentMonths.map((value) => ({
        month: value,
        count: days.filter((day) => day.date.startsWith(value) && day.checks?.[definition.id]).length
      }));
      const maxCount = Math.max(1, ...monthCounts.map((item) => item.count));
      return `
        <article class="habit-stat-card">
          <div class="habit-stat-head">
            <strong>${escapeHtml(definition.label)}</strong>
            <span class="muted">连续 ${streak} 天 · 累计 ${totalDone} 次</span>
          </div>
          <div class="stat-progress" role="img" aria-label="${escapeAttr(month)} 完成率 ${monthRate}%">
            <div class="stat-progress-fill" style="width: ${monthRate}%"></div>
          </div>
          <p class="stat-progress-label">${escapeHtml(month)} 完成 ${monthDone}/${monthDates.length} 天（${monthRate}%）</p>
          <div class="stat-bars" aria-label="最近 6 个月打卡次数">
            ${monthCounts.map((item) => `
              <div class="stat-bar" title="${escapeAttr(item.month)}：${item.count} 次">
                <em>${item.count}</em>
                <div class="stat-bar-track"><div class="stat-bar-fill" style="height: ${Math.max(4, Math.round((item.count / maxCount) * 100))}%"></div></div>
                <span>${Number(item.month.slice(5))}月</span>
              </div>
            `).join("")}
          </div>
        </article>
      `;
    }).join("");

    return `
      <section class="record" data-kind="habit-stats" data-month="${escapeAttr(month)}">
        <div class="record-head">
          <div class="record-title">
            <strong>坚持统计</strong>
            <span class="muted">打卡在日历首页或晨间日记里完成，这里看趋势</span>
          </div>
        </div>
        <div class="habit-stat-grid">
          ${cards || emptyState("还没有习惯定义。")}
        </div>
      </section>
    `;
  }

  function lastMonths(endMonth, count) {
    const [year, monthNumber] = (isMonth(endMonth) ? endMonth : currentMonth).split("-").map(Number);
    const months = [];
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const date = new Date(year, monthNumber - 1 - offset, 1);
      months.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
    }
    return months;
  }

  function currentStreak(byDate, habitId) {
    let streak = 0;
    const cursor = new Date(today);
    if (!byDate.get(formatDate(cursor))?.[habitId]) {
      cursor.setDate(cursor.getDate() - 1);
    }
    while (byDate.get(formatDate(cursor))?.[habitId]) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function renderMonthly() {
    const months = [...state.snapshot.monthly.months].sort((a, b) => b.month.localeCompare(a.month));
    const items = sortMonthItems(flattenMonthItems(months));
    const doneItems = items.filter((item) => item.done).length;
    const openItems = items.length - doneItems;
    setSummary([
      ["记录月份", `${months.length} 个`],
      ["待推进", `${openItems} 件`],
      ["已完成", `${doneItems} 件`]
    ]);
    const monthOptions = ["", ...months.map((record) => record.month)];
    el.toolbar.innerHTML = `
      <div class="toolbar-group filter-group" aria-label="筛选条件">
        <label class="toolbar-field search-field">
          <span>搜索</span>
          <input type="search" id="searchQuery" data-filter="search" placeholder="事项关键词" aria-label="搜索月度事项">
        </label>
        <label class="toolbar-field">
          <span>状态</span>
          <select id="statusFilter" data-filter="status" aria-label="状态筛选">
            <option value="open" selected>未完成</option>
            <option value="all">全部</option>
            <option value="done">已完成</option>
          </select>
        </label>
        <label class="toolbar-field">
          <span>月份</span>
          <select id="monthFilter" data-filter="month" aria-label="月份筛选">
            ${monthOptions.map((month) => `<option value="${escapeAttr(month)}">${month ? escapeHtml(month) : "不限月份"}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="toolbar-group create-group" aria-label="新增记录">
        <button class="btn secondary" type="button" data-action="add-month-item-row">新增事项</button>
      </div>
    `;
    el.list.innerHTML = items.length ? `
      <div class="table-area">
        <div class="table-scroll">
          <table class="data-table" aria-label="月度事项表">
            <thead>
              <tr>
                <th>完成</th>
                <th>事项</th>
                <th>描述</th>
                <th>月份</th>
                <th>创建时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(renderMonthItemRow).join("")}
            </tbody>
          </table>
        </div>
        <div class="action-sidebar">
          <div class="action-sidebar-head">操作</div>
          <div class="action-sidebar-list"></div>
        </div>
      </div>
      <p class="table-note">事项按对象维护；月份只是归属字段，历史未完成项会排在前面。</p>
    ` : emptyState("还没有月度事项。可以先新增一件事项，再选择归属月份。");
    applyCurrentFilters();
    if (items.length) initActionSidebar(items.length);
    applyCurrentFilters();
  }

  function renderAnnualGoals() {
    const years = [...state.snapshot.annual_goals.years].sort((a, b) => b.year.localeCompare(a.year));
    const items = sortAnnualGoalItems(flattenAnnualGoalItems(years));
    const doneItems = items.filter((item) => item.done).length;
    const openItems = items.length - doneItems;
    setSummary([
      ["记录年份", `${years.length} 个`],
      ["待推进", `${openItems} 件`],
      ["已完成", `${doneItems} 件`]
    ]);
    const yearOptions = ["", ...years.map((record) => record.year)];
    el.toolbar.innerHTML = `
      <div class="toolbar-group filter-group" aria-label="筛选条件">
        <label class="toolbar-field search-field">
          <span>搜索</span>
          <input type="search" id="searchQuery" data-filter="search" placeholder="目标关键词" aria-label="搜索年度目标">
        </label>
        <label class="toolbar-field">
          <span>状态</span>
          <select id="statusFilter" data-filter="status" aria-label="状态筛选">
            <option value="open" selected>未完成</option>
            <option value="all">全部</option>
            <option value="done">已完成</option>
          </select>
        </label>
        <label class="toolbar-field">
          <span>年份</span>
          <select id="yearFilter" data-filter="year" aria-label="年份筛选">
            ${yearOptions.map((year) => `<option value="${escapeAttr(year)}">${year ? escapeHtml(year) : "不限年份"}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="toolbar-group create-group" aria-label="新增记录">
        <label class="toolbar-field">
          <span>新增年份</span>
          <input type="number" id="newYear" min="2000" max="2099" value="${escapeAttr(currentYear)}" aria-label="新增目标归属年份">
        </label>
        <button class="btn secondary" type="button" data-action="add-annual-goal-item">新增目标</button>
      </div>
    `;
    el.list.innerHTML = items.length ? `
      <div class="table-area">
        <div class="table-scroll">
          <table class="data-table" aria-label="年度目标表">
            <thead>
              <tr>
                <th>完成</th>
                <th>目标</th>
                <th>年份</th>
                <th>创建时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(renderAnnualGoalItemRow).join("")}
            </tbody>
          </table>
        </div>
        <div class="action-sidebar">
          <div class="action-sidebar-head">操作</div>
          <div class="action-sidebar-list"></div>
        </div>
      </div>
      <p class="table-note">目标按对象维护；年份只是归属字段，历史未完成项会排在前面。</p>
    ` : emptyState("还没有年度目标。可以先新增一个目标，再选择归属年份。");
    applyCurrentFilters();
    if (items.length) initActionSidebar(items.length);
    applyCurrentFilters();
  }

  function renderAnnualGoalItemRow(item) {
    return `
      <tr class="data-row" data-kind="annual-goal-item" data-row data-done="${item.done ? "true" : "false"}" data-year="${escapeAttr(item.year)}" data-search="${escapeAttr(item.text)}" data-item-id="${escapeAttr(item.id)}" data-created-at="${item.created_at || ""}">
        <td><input type="checkbox" data-field="goal-done" ${item.done ? "checked" : ""} aria-label="完成状态"></td>
        <td><input type="text" data-field="goal-text" value="${escapeAttr(item.text)}" placeholder="年度目标"></td>
        <td><input type="number" data-field="goal-year" value="${escapeAttr(item.year)}" min="2000" max="2099" aria-label="归属年份"></td>
        <td class="readonly-cell">${formatTimestamp(item.created_at) || '<span class="muted">—</span>'}</td>
        <td>${statusPill(item.done)}</td>
      </tr>
    `;
  }

  function renderMonthItemRow(item) {
    return `
      <tr class="data-row" data-kind="month-item" data-row data-done="${item.done ? "true" : "false"}" data-month="${escapeAttr(item.month)}" data-search="${escapeAttr(item.text)}" data-item-id="${escapeAttr(item.id)}" data-created-at="${item.created_at || ""}">
        <td><input type="checkbox" data-field="month-done" ${item.done ? "checked" : ""} aria-label="完成状态"></td>
        <td><input type="text" data-field="month-text" value="${escapeAttr(item.text)}" placeholder="月度重要事项"></td>
        <td><input type="text" data-field="month-note" value="${escapeAttr(item.note || "")}"></td>
        <td><input type="month" data-field="month-value" value="${escapeAttr(item.month)}" aria-label="归属月份"></td>
        <td class="readonly-cell">${formatTimestamp(item.created_at) || '<span class="muted">—</span>'}</td>
        <td>${statusPill(item.done)}</td>
      </tr>
    `;
  }

  function statusPill(done) {
    return `<span class="status-pill" data-done="${done ? "true" : "false"}">${done ? "已完成" : "未完成"}</span>`;
  }

  let filterTimer = null;
  function scheduleFilters() {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyCurrentFilters, 200);
  }

  el.list.addEventListener("input", (event) => {
    updateRowMeta(event.target.closest("[data-row]"));
    requestSave();
  });
  el.list.addEventListener("change", (event) => {
    updateRowMeta(event.target.closest("[data-row]"));
    requestSave();
  });
  el.list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    if (action === "delete-row") {
      const sidebarItem = button.closest(".action-sidebar-item");
      const tbody = el.list.querySelector(".data-table tbody");
      if (sidebarItem && tbody) {
        const list = sidebarItem.parentElement;
        const index = [...list.children].indexOf(sidebarItem);
        const rows = [...tbody.querySelectorAll(".data-row")];
        const row = rows[index];
        if (row) {
          undoStack.push({ rowHTML: row.outerHTML, sidebarHTML: sidebarItem.outerHTML, index, kind: "row" });
          row.remove();
        }
        sidebarItem.remove();
      } else {
        const row = button.closest("[data-row]");
        if (row) { row.remove(); }
      }
      requestSave();
    }
    if (action === "delete-definition") {
      const sidebarItem = button.closest(".action-sidebar-item");
      const defRow = button.closest(".definition-row");
      if (sidebarItem && defRow) {
        const list = sidebarItem.parentElement;
        const index = [...list.children].indexOf(sidebarItem);
        undoStack.push({ rowHTML: defRow.outerHTML, sidebarHTML: sidebarItem.outerHTML, index, kind: "definition" });
        defRow.remove();
        sidebarItem.remove();
      } else {
        if (defRow) defRow.remove();
        if (sidebarItem) sidebarItem.remove();
      }
      requestSave({ rerenderAfterSave: true });
    }
    if (action === "copy-column") {
      copyColumn(button);
    }
  });

  /* ── Column copy ── */

  function initColumnCopy() {
    const table = el.list.querySelector(".data-table");
    const headRow = table?.tHead?.rows[0];
    if (!headRow) return;
    [...headRow.cells].forEach((th) => {
      if (th.querySelector(".th-copy")) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "th-copy";
      button.dataset.action = "copy-column";
      button.title = "复制本列当前显示的行";
      button.setAttribute("aria-label", `复制「${th.textContent.trim()}」列当前显示的行`);
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="12" height="12"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      th.appendChild(button);
    });
  }

  function readCellCopyValue(cell) {
    const checkbox = cell.querySelector('input[type="checkbox"]');
    if (checkbox) return checkbox.checked ? "已完成" : "未完成";
    const input = cell.querySelector("input, textarea, select");
    if (input) return input.value || "";
    return (cell.textContent || "").replace(/\s+/g, " ").trim();
  }

  async function copyColumn(button) {
    const th = button.closest("th");
    const table = th?.closest("table");
    if (!th || !table) return;
    const columnIndex = [...table.tHead.rows[0].cells].indexOf(th);
    const rows = [...table.querySelectorAll("tbody tr")].filter((row) => !row.hidden);
    if (!rows.length) {
      setNotice("当前没有可复制的行。", "error");
      return;
    }
    const text = rows
      .map((row) => readCellCopyValue(row.cells[columnIndex]))
      .filter((value) => value.trim())
      .join("\n");
    if (!text) {
      setNotice("这一列当前显示的行没有内容。", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`已复制 ${text.split("\n").length} 行到剪贴板。`, "saved");
      button.classList.add("copied");
      setTimeout(() => button.classList.remove("copied"), 1200);
    } catch (error) {
      setNotice(toErrorMessage(error), "error");
    }
  }

  /* ── Undo delete ── */

  const undoStack = [];

  function undoDelete() {
    const entry = undoStack.pop();
    if (!entry) return;
    clearTimeout(state.saveTimer);
    const tbody = el.list.querySelector(".data-table tbody");
    const sidebarList = el.list.querySelector(".action-sidebar-list");
    if (entry.kind === "row" && tbody) {
      const rows = [...tbody.querySelectorAll(".data-row")];
      const ref = rows[entry.index] || null;
      if (ref) ref.insertAdjacentHTML("beforebegin", entry.rowHTML);
      else tbody.insertAdjacentHTML("beforeend", entry.rowHTML);
    } else if (entry.kind === "definition") {
      const defRows = el.list.querySelectorAll(".definition-row");
      const ref = defRows[entry.index] || null;
      if (ref) ref.insertAdjacentHTML("beforebegin", entry.rowHTML);
      else {
        const tbody2 = el.list.querySelector("tbody");
        if (tbody2) tbody2.insertAdjacentHTML("beforeend", entry.rowHTML);
      }
    }
    if (sidebarList) {
      const items = [...sidebarList.children];
      const ref = items[entry.index] || null;
      if (ref) ref.insertAdjacentHTML("beforebegin", entry.sidebarHTML);
      else sidebarList.insertAdjacentHTML("beforeend", entry.sidebarHTML);
    }
    applyCurrentFilters();
    requestSave();
    setNotice("已撤销删除。", "saved");
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      undoDelete();
    }
  });

  el.toolbar.addEventListener("input", (event) => {
    if (event.target.matches("[data-filter]")) scheduleFilters();
  });
  el.toolbar.addEventListener("change", (event) => {
    if (event.target.matches("[data-filter]")) applyCurrentFilters();
  });
  el.toolbar.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;

    if (action === "add-frog-item") {
      const date = document.getElementById("newDate")?.value || currentDate;
      const slot = nextFrogSlot(date);
      if (!slot) {
        setNotice("这个日期已经有三只青蛙，请换一个关联日期或调整已有序号。", "error");
        return;
      }
      resetObjectFilters();
      const tbody = ensureFrogTbody();
      if (tbody) {
        tbody.insertAdjacentHTML("afterbegin", renderFrogTask({
          date,
          slot,
          text: "",
          done: false,
          created_at: nowSeconds()
        }));
        tbody.querySelector('[data-field="frog-text"]')?.focus();
        applyCurrentFilters();
        const sidebarList = el.list.querySelector(".action-sidebar-list");
        if (sidebarList) sidebarList.insertAdjacentHTML("afterbegin", '<div class="action-sidebar-item"><button class="btn danger compact" type="button" data-action="delete-row">删除</button></div>');
        initColumnCopy();
        initColumnResize();
      }
    }

    if (action === "add-habit-definition") {
      state.snapshot.habits = collectHabits();
      state.snapshot.habits.definitions.push({ id: uid("habit"), label: "新的习惯", created_at: nowSeconds() });
      renderHabits();
      requestSave();
    }

    if (action === "show-habit-month") {
      await saveNow();
      renderHabits();
    }

    if (action === "add-annual-goal-item") {
      const yearInput = document.getElementById("newYear");
      const year = String(yearInput?.value || currentYear).padStart(4, "0");
      if (!isYear(year)) {
        setNotice("请输入有效的四位数年份。", "error");
        return;
      }
      resetObjectFilters();
      const tbody = ensureAnnualGoalTbody();
      if (tbody) {
        tbody.insertAdjacentHTML("afterbegin", renderAnnualGoalItemRow({
          year,
          id: uid("year"),
          text: "",
          done: false,
          created_at: nowSeconds(),
          updated_at: null
        }));
        tbody.querySelector('[data-field="goal-text"]')?.focus();
        applyCurrentFilters();
        const sidebarList = el.list.querySelector(".action-sidebar-list");
        if (sidebarList) sidebarList.insertAdjacentHTML("afterbegin", '<div class="action-sidebar-item"><button class="btn danger compact" type="button" data-action="delete-row">删除</button></div>');
        initColumnCopy();
      }
    }

    if (action === "add-month-item-row") {
      const month = currentMonth;
      resetObjectFilters();
      const tbody = ensureMonthlyTbody();
      if (tbody) {
        tbody.insertAdjacentHTML("afterbegin", renderMonthItemRow({
          month,
          id: uid("month"),
          text: "",
          done: false,
          note: "",
          created_at: nowSeconds(),
          updated_at: null
        }));
        tbody.querySelector('[data-field="month-text"]')?.focus();
        applyCurrentFilters();
        const sidebarList = el.list.querySelector(".action-sidebar-list");
        if (sidebarList) sidebarList.insertAdjacentHTML("afterbegin", '<div class="action-sidebar-item"><button class="btn danger compact" type="button" data-action="delete-row">删除</button></div>');
        initColumnCopy();
      }
    }
  });

  function requestSave(options = {}) {
    if (!state.booted) return;
    clearTimeout(state.saveTimer);
    setNotice("正在保存...");
    state.saveTimer = setTimeout(() => saveNow(options), 520);
  }

  async function saveNow(options = {}) {
    clearTimeout(state.saveTimer);
    try {
      if (managerType === "habits") {
        const habits = collectHabits();
        const saved = await invoke(view.saveCommand, habits);
        state.snapshot.habits = saved;
      } else if (managerType === "monthly") {
        const monthly = collectMonthly();
        const saved = await invoke(view.saveCommand, { months: monthly.months });
        state.snapshot.monthly = saved;
      } else if (managerType === "annual-goals") {
        const annualGoals = collectAnnualGoals();
        const saved = await invoke(view.saveCommand, { years: annualGoals.years });
        state.snapshot.annual_goals = saved;
      } else {
        const frogs = collectFrogs();
        const saved = await invoke(view.saveCommand, { days: frogs.days });
        state.snapshot.frogs = saved;
      }
      if (options.rerenderAfterSave) {
        setNotice("已保存。", "saved");
        render();
      } else {
        setNotice("", "saved");
      }
    } catch (error) {
      setNotice(toErrorMessage(error), "error");
    }
  }

  function collectFrogs() {
    const grouped = new Map();
    [...el.list.querySelectorAll('[data-kind="frog-item"]')].forEach((row) => {
      const date = row.querySelector('[data-field="frog-date"]')?.value || "";
      if (!isDate(date)) return;
      const slot = readFrogSlot(row) || nextFrogSlot(date, row);
      const text = row.querySelector('[data-field="frog-text"]')?.value || "";
      const done = Boolean(row.querySelector('[data-field="frog-done"]')?.checked);
      const note = row.querySelector('[data-field="frog-note"]')?.value || "";
      if (!text.trim()) return;
      if (!grouped.has(date)) grouped.set(date, normalizeFrogItems([]));
      const createdAt = Number(row.dataset.createdAt) || null;
      grouped.get(date)[Math.max(1, Math.min(3, slot)) - 1] = { slot: Math.max(1, Math.min(3, slot)), text, done, note, created_at: createdAt };
    });
    const days = [...grouped.entries()].map(([date, items]) => ({ date, items, updated_at: null }));
    return { schema_version: 1, days };
  }

  function collectHabits() {
    const definitions = [...el.list.querySelectorAll(".definition-row")].map((row) => ({
      id: row.querySelector('[data-field="habit-id"]')?.value || "",
      label: row.querySelector('[data-field="habit-label"]')?.value || "",
      created_at: Number(row.dataset.createdAt) || null
    }));
    const validDefinitions = normalizeDefinitions(definitions);
    const validIds = new Set(validDefinitions.map((definition) => definition.id));
    const days = (state.snapshot.habits.days || []).map((day) => {
      const checks = {};
      Object.entries(day.checks || {}).forEach(([id, checked]) => {
        if (validIds.has(id)) checks[id] = Boolean(checked);
      });
      return { date: day.date, checks, updated_at: day.updated_at || null };
    });
    return { definitions: validDefinitions, days };
  }

  function collectMonthly() {
    const grouped = new Map();
    [...el.list.querySelectorAll('[data-kind="month-item"]')].forEach((row) => {
      const month = row.querySelector('[data-field="month-value"]')?.value || "";
      if (!isMonth(month)) return;
      const text = row.querySelector('[data-field="month-text"]')?.value || "";
      if (!text.trim()) return;
      const note = row.querySelector('[data-field="month-note"]')?.value || "";
      if (!grouped.has(month)) grouped.set(month, []);
      grouped.get(month).push({
        id: row.dataset.itemId || uid("month"),
        text,
        done: Boolean(row.querySelector('[data-field="month-done"]')?.checked),
        note,
        created_at: Number(row.dataset.createdAt) || nowSeconds(),
        updated_at: null
      });
    });
    const months = [...grouped.entries()].map(([month, items]) => ({ month, items, updated_at: null }));
    return { schema_version: 1, months };
  }

  function updateRowMeta(row) {
    if (!row) return;
    if (row.dataset.kind === "frog-item") {
      row.dataset.done = row.querySelector('[data-field="frog-done"]')?.checked ? "true" : "false";
      row.dataset.date = row.querySelector('[data-field="frog-date"]')?.value || "";
      syncFrogSlot(row);
      row.dataset.search = row.querySelector('[data-field="frog-text"]')?.value || "";
      const status = row.querySelector(".status-pill");
      if (status) status.outerHTML = statusPill(row.dataset.done === "true");
    }
    if (row.dataset.kind === "annual-goal-item") {
      row.dataset.done = row.querySelector('[data-field="goal-done"]')?.checked ? "true" : "false";
      row.dataset.year = String(row.querySelector('[data-field="goal-year"]')?.value || "").padStart(4, "0");
      row.dataset.search = row.querySelector('[data-field="goal-text"]')?.value || "";
      const status = row.querySelector(".status-pill");
      if (status) status.outerHTML = statusPill(row.dataset.done === "true");
    }
    if (row.dataset.kind === "month-item") {
      row.dataset.done = row.querySelector('[data-field="month-done"]')?.checked ? "true" : "false";
      row.dataset.month = row.querySelector('[data-field="month-value"]')?.value || "";
      row.dataset.search = row.querySelector('[data-field="month-text"]')?.value || "";
      const status = row.querySelector(".status-pill");
      if (status) status.outerHTML = statusPill(row.dataset.done === "true");
    }
    applyCurrentFilters();
  }

  function applyCurrentFilters() {
    const query = (document.getElementById("searchQuery")?.value || "").trim().toLowerCase();
    const status = document.getElementById("statusFilter")?.value || "all";
    const date = document.getElementById("dateFilter")?.value || "";
    const month = document.getElementById("monthFilter")?.value || "";
    const year = document.getElementById("yearFilter")?.value || "";
    const rows = [...el.list.querySelectorAll("[data-row]")];
    const sidebarItems = [...(el.list.querySelectorAll(".action-sidebar-item") || [])];
    rows.forEach((row, index) => {
      const text = `${row.dataset.search || ""} ${row.querySelector("input[type='text']")?.value || ""}`.toLowerCase();
      const done = row.dataset.done === "true";
      const statusMatch = status === "all" || (status === "done" && done) || (status === "open" && !done);
      const dateMatch = !date || row.dataset.date === date;
      const monthMatch = !month || row.dataset.month === month;
      const yearMatch = !year || row.dataset.year === year;
      const hidden = Boolean(query && !text.includes(query)) || !statusMatch || !dateMatch || !monthMatch || !yearMatch;
      row.hidden = hidden;
      if (sidebarItems[index]) sidebarItems[index].hidden = hidden;
    });
    syncSidebarRowHeights();
  }

  function nextFrogSlot(date, excludeRow = null) {
    const used = new Set([...el.list.querySelectorAll('[data-kind="frog-item"]')]
      .filter((row) => row !== excludeRow)
      .filter((row) => (row.querySelector('[data-field="frog-date"]')?.value || row.dataset.date) === date)
      .map((row) => readFrogSlot(row)));
    return [1, 2, 3].find((slot) => !used.has(slot)) || null;
  }

  function readFrogSlot(row) {
    return Number(row?.querySelector('[data-field="frog-slot"]')?.value || row?.dataset.slot || 0);
  }

  function syncFrogSlot(row) {
    const date = row.dataset.date;
    const currentSlot = readFrogSlot(row);
    const usedByAnother = [...el.list.querySelectorAll('[data-kind="frog-item"]')]
      .some((other) => other !== row
        && (other.querySelector('[data-field="frog-date"]')?.value || other.dataset.date) === date
        && readFrogSlot(other) === currentSlot);
    const slot = !currentSlot || usedByAnother ? nextFrogSlot(date, row) || currentSlot || 1 : currentSlot;
    const input = row.querySelector('[data-field="frog-slot"]');
    const display = row.querySelector("[data-slot-display]");
    if (input) input.value = String(slot);
    if (display) display.textContent = `#${slot}`;
    row.dataset.slot = String(slot);
  }

  function resetObjectFilters() {
    const search = document.getElementById("searchQuery");
    const status = document.getElementById("statusFilter");
    const date = document.getElementById("dateFilter");
    const month = document.getElementById("monthFilter");
    const year = document.getElementById("yearFilter");
    if (search) search.value = "";
    if (status) status.value = "open";
    if (date) date.value = "";
    if (month) month.value = "";
    if (year) year.value = "";
  }

  function ensureFrogTbody() {
    let tbody = el.list.querySelector("tbody");
    if (tbody) return tbody;
    el.list.innerHTML = `
      <div class="table-area">
        <div class="table-scroll">
          <table class="data-table" aria-label="三只青蛙任务表">
            <thead>
              <tr>
                <th>完成</th>
                <th>青蛙任务</th>
                <th>描述</th>
                <th>关联日期</th>
                <th>序号</th>
                <th>创建时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="action-sidebar">
          <div class="action-sidebar-head">操作</div>
          <div class="action-sidebar-list"></div>
        </div>
      </div>
      <p class="table-note">筛选只影响显示，不会删掉隐藏记录。</p>
    `;
    return el.list.querySelector("tbody");
  }

  function ensureMonthlyTbody() {
    let tbody = el.list.querySelector("tbody");
    if (tbody) return tbody;
    el.list.innerHTML = `
      <div class="table-area">
        <div class="table-scroll">
          <table class="data-table" aria-label="月度事项表">
            <thead>
              <tr>
                <th>完成</th>
                <th>事项</th>
                <th>描述</th>
                <th>月份</th>
                <th>创建时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="action-sidebar">
          <div class="action-sidebar-head">操作</div>
          <div class="action-sidebar-list"></div>
        </div>
      </div>
      <p class="table-note">事项按对象维护；月份只是归属字段，历史未完成项会排在前面。</p>
    `;
    return el.list.querySelector("tbody");
  }

  function ensureAnnualGoalTbody() {
    let tbody = el.list.querySelector("tbody");
    if (tbody) return tbody;
    el.list.innerHTML = `
      <div class="table-area">
        <div class="table-scroll">
          <table class="data-table" aria-label="年度目标表">
            <thead>
              <tr>
                <th>完成</th>
                <th>目标</th>
                <th>年份</th>
                <th>创建时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="action-sidebar">
          <div class="action-sidebar-head">操作</div>
          <div class="action-sidebar-list"></div>
        </div>
      </div>
      <p class="table-note">目标按对象维护；年份只是归属字段，历史未完成项会排在前面。</p>
    `;
    return el.list.querySelector("tbody");
  }

  function getMatrixMonth() {
    return document.getElementById("matrixMonth")?.value || currentMonth;
  }

  function getMonthDates(month) {
    if (!isMonth(month)) return [];
    const [year, monthNumber] = month.split("-").map(Number);
    const date = new Date(year, monthNumber - 1, 1);
    const dates = [];
    while (date.getMonth() === monthNumber - 1) {
      dates.push(formatDate(date));
      date.setDate(date.getDate() + 1);
    }
    return dates;
  }

  function weekdayLabel(dateValue) {
    const date = new Date(`${dateValue}T00:00:00`);
    return ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];
  }

  function flattenFrogTasks(days) {
    return (days || []).flatMap((day) => normalizeFrogItems(day.items || [])
      .filter((item) => String(item.text || "").trim())
      .map((item) => ({
        date: day.date,
        slot: item.slot,
        text: item.text,
        done: item.done,
        note: item.note,
        created_at: item.created_at || null,
        updated_at: day.updated_at || null
      })));
  }

  function sortFrogTasks(tasks) {
    return [...tasks].sort((a, b) => Number(a.done) - Number(b.done) || b.date.localeCompare(a.date) || a.slot - b.slot || (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
  }

  function flattenAnnualGoalItems(years) {
    return (years || []).flatMap((record) => (record.items || []).map((item) => ({
      year: record.year,
      id: item.id || uid("year"),
      text: item.text || "",
      done: Boolean(item.done),
      created_at: item.created_at || nowSeconds(),
      updated_at: item.updated_at || null
    })));
  }

  function sortAnnualGoalItems(items) {
    return [...items].sort((a, b) => Number(a.done) - Number(b.done) || b.year.localeCompare(a.year) || (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
  }

  function collectAnnualGoals() {
    const grouped = new Map();
    [...el.list.querySelectorAll('[data-kind="annual-goal-item"]')].forEach((row) => {
      const year = String(row.querySelector('[data-field="goal-year"]')?.value || "").padStart(4, "0");
      if (!isYear(year)) return;
      const text = row.querySelector('[data-field="goal-text"]')?.value || "";
      if (!text.trim()) return;
      if (!grouped.has(year)) grouped.set(year, []);
      grouped.get(year).push({
        id: row.dataset.itemId || uid("year"),
        text,
        done: Boolean(row.querySelector('[data-field="goal-done"]')?.checked),
        created_at: Number(row.dataset.createdAt) || nowSeconds(),
        updated_at: null
      });
    });
    const years = [...grouped.entries()].map(([year, items]) => ({ year, items, updated_at: null }));
    return { schema_version: 1, years };
  }

  function flattenMonthItems(months) {
    return (months || []).flatMap((record) => (record.items || []).map((item) => ({
      month: record.month,
      id: item.id || uid("month"),
      text: item.text || "",
      done: Boolean(item.done),
      note: item.note || "",
      created_at: item.created_at || nowSeconds(),
      updated_at: item.updated_at || null
    })));
  }

  function sortMonthItems(items) {
    return [...items].sort((a, b) => Number(a.done) - Number(b.done) || b.month.localeCompare(a.month) || (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
  }

  function setSummary(items) {
    el.summary.innerHTML = items.map(([label, value]) => `
      <div class="summary-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `).join("");
  }

  function setNotice(message, stateName = "") {
    el.notice.textContent = message || "";
    el.notice.dataset.state = stateName;
  }

  function normalizeSnapshot(snapshot) {
    return {
      frogs: {
        schema_version: 1,
        days: normalizeFrogDays(snapshot?.frogs?.days || [])
      },
      habits: {
        schema_version: 1,
        definitions: normalizeDefinitions(snapshot?.habits?.definitions || defaultHabitDefinitions()),
        days: normalizeHabitDays(snapshot?.habits?.days || [], snapshot?.habits?.definitions || defaultHabitDefinitions())
      },
      monthly: {
        schema_version: 1,
        months: normalizeMonths(snapshot?.monthly?.months || [])
      },
      annual_goals: {
        schema_version: 1,
        years: normalizeAnnualGoalYears(snapshot?.annual_goals?.years || [])
      },
      paths: snapshot?.paths || {}
    };
  }

  function defaultFrogs() {
    return { schema_version: 1, days: [] };
  }

  function defaultHabits() {
    return { schema_version: 1, definitions: defaultHabitDefinitions(), days: [] };
  }

  function defaultMonthly() {
    return { schema_version: 1, months: [] };
  }

  function defaultAnnualGoals() {
    return { schema_version: 1, years: [] };
  }

  function normalizeFrogDays(days) {
    return [...dedupeBy(days, "date")].filter((day) => isDate(day.date)).map((day) => ({
      date: day.date,
      items: normalizeFrogItems(day.items || []),
      updated_at: day.updated_at || null
    })).sort((a, b) => a.date.localeCompare(b.date));
  }

  function normalizeFrogItems(items) {
    const bySlot = new Map((items || []).map((item) => [Number(item.slot), item]));
    return [1, 2, 3].map((slot) => {
      const item = bySlot.get(slot) || {};
      return {
        slot,
        text: String(item.text || ""),
        done: Boolean(item.done),
        note: String(item.note || ""),
        created_at: item.created_at || null
      };
    });
  }

  function normalizeDefinitions(definitions) {
    const seen = new Set();
    const rows = [];
    (definitions || []).forEach((definition, index) => {
      const label = String(definition.label || "").trim();
      if (!label) return;
      let id = String(definition.id || "").trim() || `habit-${index + 1}`;
      if (seen.has(id)) id = `${id}-${index + 1}`;
      seen.add(id);
      rows.push({ id, label, created_at: definition.created_at || null });
    });
    return rows.length ? rows : defaultHabitDefinitions();
  }

  function normalizeHabitDays(days, definitions) {
    const validIds = new Set(normalizeDefinitions(definitions).map((definition) => definition.id));
    return [...dedupeBy(days, "date")].filter((day) => isDate(day.date)).map((day) => {
      const checks = {};
      Object.entries(day.checks || {}).forEach(([id, checked]) => {
        if (validIds.has(id)) checks[id] = Boolean(checked);
      });
      return { date: day.date, checks, updated_at: day.updated_at || null };
    }).sort((a, b) => a.date.localeCompare(b.date));
  }

  function normalizeMonths(months) {
    return [...dedupeBy(months, "month")].filter((month) => isMonth(month.month)).map((record) => ({
      month: record.month,
      items: (record.items || []).filter((item) => String(item.text || "").trim()).map((item) => ({
        id: item.id || uid("month"),
        text: String(item.text || "").trim(),
        done: Boolean(item.done),
        note: String(item.note || ""),
        created_at: item.created_at || nowSeconds(),
        updated_at: item.updated_at || null
      })),
      updated_at: record.updated_at || null
    })).filter((record) => record.items.length).sort((a, b) => a.month.localeCompare(b.month));
  }

  function normalizeAnnualGoalYears(years) {
    return [...dedupeBy(years, "year")].filter((record) => isYear(record.year)).map((record) => ({
      year: record.year,
      items: (record.items || []).filter((item) => String(item.text || "").trim()).map((item) => ({
        id: item.id || uid("year"),
        text: String(item.text || "").trim(),
        done: Boolean(item.done),
        created_at: item.created_at || nowSeconds(),
        updated_at: item.updated_at || null
      })),
      updated_at: record.updated_at || null
    })).sort((a, b) => a.year.localeCompare(b.year));
  }

  function dedupeBy(items, key) {
    const map = new Map();
    (items || []).forEach((item) => {
      if (item?.[key] && !map.has(item[key])) map.set(item[key], item);
    });
    return map.values();
  }

  function readFallback(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch {
      return fallback;
    }
  }

  function emptyState(message) {
    return `<div class="empty">${escapeHtml(message)}</div>`;
  }

  function uid(prefix) {
    if (crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  /* ── Action sidebar ── */

  function initActionSidebar(count, actionType = "delete-row") {
    const sidebar = el.list.querySelector(".action-sidebar");
    if (!sidebar) return;
    sidebar.dataset.actionType = actionType;
    const scrollEl = el.list.querySelector(".table-scroll");
    if (!scrollEl) return;
    const headHeight = scrollEl.querySelector(".data-table thead")?.getBoundingClientRect().height || 0;
    sidebar.querySelector(".action-sidebar-head").style.minHeight = headHeight + "px";
    scrollEl.addEventListener("scroll", () => { sidebar.scrollTop = scrollEl.scrollTop; });
    syncActionSidebar(count, actionType);
    syncSidebarRowHeights();
  }

  function syncSidebarRowHeights() {
    const sidebarItems = el.list.querySelectorAll(".action-sidebar-item");
    const rows = el.list.querySelectorAll(".data-table tbody .data-row");
    sidebarItems.forEach((item, i) => {
      const row = rows[i];
      if (!row || row.hidden) {
        item.style.height = "";
        item.style.minHeight = "";
      } else {
        item.style.height = row.getBoundingClientRect().height + "px";
        item.style.minHeight = "0";
      }
    });
  }

  function syncActionSidebar(count, actionType) {
    const list = el.list.querySelector(".action-sidebar-list");
    if (!list) return;
    const at = actionType || el.list.querySelector(".action-sidebar")?.dataset.actionType || "delete-row";
    const items = Array.from({ length: count }, () =>
      `<div class="action-sidebar-item"><button class="btn danger compact" type="button" data-action="${at}">删除</button></div>`
    ).join("");
    list.innerHTML = items;
  }

  /* ── Column resize ── */

  const colResizeState = {};

  function getColKey(table) {
    return table.getAttribute("aria-label") || "default";
  }

  function getResizeInfo() {
    const saved = colResizeState[managerType];
    if (saved) return saved;
    const table = el.list.querySelector(".data-table");
    if (!table) return null;
    const ths = [...table.tHead.rows[0].cells];
    colResizeState[managerType] = { table, ths };
    return colResizeState[managerType];
  }

  function initColumnResize() {
    colResizeState[managerType] = null;
    const table = el.list.querySelector(".data-table");
    if (!table || !table.tHead) return;
    const ths = [...table.tHead.rows[0].cells];
    if (ths.length < 2) return;
    colResizeState[managerType] = { table, ths };
    ths.forEach((th) => { th.style.position = "relative"; });
    restoreColumnWidths(table, ths);
    ths.slice(0, -1).forEach((th, index) => {
      const handle = document.createElement("div");
      handle.className = "col-resize-handle";
      th.appendChild(handle);
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const info = getResizeInfo();
        if (!info) return;
        const colIndex = info.ths.indexOf(th);
        const startX = e.clientX;
        const widths = info.ths.map((h) => Math.round(h.getBoundingClientRect().width));
        info.ths.forEach((h, i) => { h.style.width = widths[i] + "px"; });
        const startWidth = widths[colIndex];
        info.table.style.width = widths.reduce((a, b) => a + b, 0) + "px";
        handle.classList.add("active");
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;cursor:col-resize;z-index:99999";
        document.body.appendChild(overlay);
        function onMove(me) {
          const newWidth = Math.max(40, startWidth + (me.clientX - startX));
          widths[colIndex] = Math.round(newWidth);
          info.ths[colIndex].style.width = widths[colIndex] + "px";
          info.table.style.width = widths.reduce((a, b) => a + b, 0) + "px";
        }
        function onUp() {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          handle.classList.remove("active");
          overlay.remove();
          saveColumnWidths(managerType, info.ths);
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  }

  function saveColumnWidths(type, ths) {
    const widths = ths.map((th) => Math.round(th.getBoundingClientRect().width));
    try {
      localStorage.setItem(`lifeos-colwidths:${type}`, JSON.stringify(widths));
    } catch {}
  }

  function restoreColumnWidths(table, ths) {
    let widths;
    try {
      widths = JSON.parse(localStorage.getItem(`lifeos-colwidths:${managerType}`));
    } catch {}
    if (Array.isArray(widths) && widths.length === ths.length) {
      ths.forEach((th, i) => { th.style.width = widths[i] + "px"; });
      table.style.width = widths.reduce((a, b) => a + b, 0) + "px";
    }
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();
