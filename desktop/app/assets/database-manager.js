(() => {
  const managerType = document.body.dataset.manager;
  const today = new Date();
  const currentDate = formatDate(today);
  const currentMonth = currentDate.slice(0, 7);
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const fallbackKeys = {
    frogs: "lifeos-db:frogs",
    habits: "lifeos-db:habits",
    monthly: "lifeos-db:monthly-important"
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
      subtitle: "维护习惯定义，并用月度矩阵查看坚持情况。",
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
    notice: document.getElementById("notice"),
    saveNow: document.getElementById("saveNow")
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
        paths: {
          frogs: `本机预览 / LifeOS-Vault / 00-Databases / ${config.frogs.fileName}`,
          habits: `本机预览 / LifeOS-Vault / 00-Databases / ${config.habits.fileName}`,
          monthly: `本机预览 / LifeOS-Vault / 00-Databases / ${config.monthly.fileName}`
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

    throw new Error(`未支持的命令：${command}`);
  }

  function render() {
    el.path.textContent = state.snapshot.paths?.[view.pathKey] || view.fileName;
    if (managerType === "habits") {
      renderHabits();
    } else if (managerType === "monthly") {
      renderMonthly();
    } else {
      renderFrogs();
    }
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
      <div class="table-scroll">
        <table class="data-table" aria-label="三只青蛙任务表">
          <thead>
            <tr>
              <th>完成</th>
              <th>青蛙任务</th>
              <th>关联日期</th>
              <th>序号</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${tasks.map(renderFrogTask).join("")}
          </tbody>
        </table>
      </div>
      <p class="table-note">共关联 ${dateCount} 个日记日期；筛选只影响显示，不会删掉隐藏记录。</p>
    ` : emptyState("还没有三只青蛙记录。可以先新增一只青蛙，再选择关联日期。");
    applyCurrentFilters();
  }

  function renderFrogTask(task) {
    return `
      <tr class="data-row" data-kind="frog-item" data-row data-done="${task.done ? "true" : "false"}" data-date="${escapeAttr(task.date)}" data-slot="${escapeAttr(task.slot)}" data-search="${escapeAttr(task.text)}">
        <td><input type="checkbox" data-field="frog-done" ${task.done ? "checked" : ""} aria-label="完成状态"></td>
        <td><input type="text" data-field="frog-text" value="${escapeAttr(task.text)}" placeholder="青蛙任务"></td>
        <td><input type="date" data-field="frog-date" value="${escapeAttr(task.date)}" aria-label="关联日期"></td>
        <td class="readonly-cell">
          <input type="hidden" data-field="frog-slot" value="${escapeAttr(task.slot)}">
          <span class="readonly-token" data-slot-display>#${escapeHtml(task.slot)}</span>
        </td>
        <td>${statusPill(task.done)}</td>
        <td><button class="btn danger compact" type="button" data-action="delete-row">删除</button></td>
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
      <div class="toolbar-group filter-group" aria-label="矩阵月份">
        <label class="toolbar-field">
          <span>月份</span>
          <input type="month" id="matrixMonth" value="${escapeAttr(selectedMonth)}" aria-label="查看月份">
        </label>
        <button class="btn secondary" type="button" data-action="show-habit-month">查看月份</button>
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
        <div class="table-scroll">
          <table class="data-table compact-table habit-definition-table" aria-label="习惯定义表">
            <thead>
              <tr>
                <th>习惯名称</th>
                <th class="action-col">操作</th>
              </tr>
            </thead>
            <tbody>
              ${definitions.map((definition) => `
                <tr class="definition-row">
                  <td>
                    <input type="hidden" data-field="habit-id" value="${escapeAttr(definition.id)}">
                    <input type="text" data-field="habit-label" value="${escapeAttr(definition.label)}" aria-label="习惯名称">
                  </td>
                  <td class="actions-cell"><button class="btn danger compact" type="button" data-action="delete-definition">删除</button></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
      ${renderHabitMatrix(definitions, days, monthDates)}
    `;
  }

  function renderHabitMatrix(definitions, days, monthDates) {
    const byDate = new Map(days.map((day) => [day.date, day.checks || {}]));
    return `
      <section class="record" data-kind="habit-matrix" data-month="${escapeAttr(getMatrixMonth())}">
        <div class="record-head">
          <div class="record-title">
            <strong>${escapeHtml(getMatrixMonth())} 打卡矩阵</strong>
            <span class="muted">横向是日期，纵向是习惯</span>
          </div>
        </div>
        <div class="matrix-scroll">
          <table class="habit-matrix" aria-label="习惯月度打卡矩阵">
            <thead>
              <tr>
                <th class="sticky-col">习惯</th>
                ${monthDates.map((date) => `
                  <th>
                    <span>${Number(date.slice(-2))}</span>
                    <small>${weekdayLabel(date)}</small>
                  </th>
                `).join("")}
              </tr>
            </thead>
            <tbody>
              ${definitions.map((definition) => `
                <tr>
                  <th class="sticky-col">${escapeHtml(definition.label)}</th>
                  ${monthDates.map((date) => {
                    const checks = byDate.get(date) || {};
                    return `
                      <td>
                        <label class="day-check" title="${escapeAttr(date)} ${escapeAttr(definition.label)}">
                          <input type="checkbox" data-field="habit-check" data-date="${escapeAttr(date)}" data-habit-id="${escapeAttr(definition.id)}" ${checks[definition.id] ? "checked" : ""}>
                          <span></span>
                        </label>
                      </td>
                    `;
                  }).join("")}
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
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
        <label class="toolbar-field">
          <span>新增月份</span>
          <input type="month" id="newMonth" aria-label="新增事项归属月份">
        </label>
        <button class="btn secondary" type="button" data-action="add-month-item-row">新增事项</button>
      </div>
    `;
    el.list.innerHTML = items.length ? `
      <div class="table-scroll">
        <table class="data-table" aria-label="月度事项表">
          <thead>
            <tr>
              <th>完成</th>
              <th>事项</th>
              <th>月份</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(renderMonthItemRow).join("")}
          </tbody>
        </table>
      </div>
      <p class="table-note">事项按对象维护；月份只是归属字段，历史未完成项会排在前面。</p>
    ` : emptyState("还没有月度事项。可以先新增一件事项，再选择归属月份。");
    applyCurrentFilters();
  }

  function renderMonthItemRow(item) {
    return `
      <tr class="data-row" data-kind="month-item" data-row data-done="${item.done ? "true" : "false"}" data-month="${escapeAttr(item.month)}" data-search="${escapeAttr(item.text)}" data-item-id="${escapeAttr(item.id)}" data-created-at="${item.created_at || ""}">
        <td><input type="checkbox" data-field="month-done" ${item.done ? "checked" : ""} aria-label="完成状态"></td>
        <td><input type="text" data-field="month-text" value="${escapeAttr(item.text)}" placeholder="月度重要事项"></td>
        <td><input type="month" data-field="month-value" value="${escapeAttr(item.month)}" aria-label="归属月份"></td>
        <td>${statusPill(item.done)}</td>
        <td><button class="btn danger compact" type="button" data-action="delete-row">删除</button></td>
      </tr>
    `;
  }

  function statusPill(done) {
    return `<span class="status-pill" data-done="${done ? "true" : "false"}">${done ? "已完成" : "未完成"}</span>`;
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
      button.closest("[data-row]")?.remove();
      requestSave();
    }
    if (action === "delete-definition") {
      button.closest(".definition-row")?.remove();
      requestSave({ rerenderAfterSave: true });
    }
  });

  el.toolbar.addEventListener("input", (event) => {
    if (event.target.matches("[data-filter]")) applyCurrentFilters();
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
          done: false
        }));
        tbody.querySelector('[data-field="frog-text"]')?.focus();
        applyCurrentFilters();
      }
    }

    if (action === "add-habit-definition") {
      state.snapshot.habits = collectHabits();
      state.snapshot.habits.definitions.push({ id: uid("habit"), label: "新的习惯" });
      renderHabits();
      requestSave();
    }

    if (action === "show-habit-month") {
      await saveNow();
      renderHabits();
    }

    if (action === "add-month-item-row") {
      const month = document.getElementById("newMonth")?.value || currentMonth;
      resetObjectFilters();
      const tbody = ensureMonthlyTbody();
      if (tbody) {
        tbody.insertAdjacentHTML("afterbegin", renderMonthItemRow({
          month,
          id: uid("month"),
          text: "",
          done: false,
          created_at: nowSeconds(),
          updated_at: null
        }));
        tbody.querySelector('[data-field="month-text"]')?.focus();
        applyCurrentFilters();
      }
    }
  });

  el.saveNow.addEventListener("click", () => saveNow({ rerenderAfterSave: true }));

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
      } else {
        const frogs = collectFrogs();
        const saved = await invoke(view.saveCommand, { days: frogs.days });
        state.snapshot.frogs = saved;
      }
      setNotice("已保存到独立数据库。", "saved");
      if (options.rerenderAfterSave) render();
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
      if (!text.trim()) return;
      if (!grouped.has(date)) grouped.set(date, normalizeFrogItems([]));
      grouped.get(date)[Math.max(1, Math.min(3, slot)) - 1] = { slot: Math.max(1, Math.min(3, slot)), text, done };
    });
    const days = [...grouped.entries()].map(([date, items]) => ({ date, items, updated_at: null }));
    return { schema_version: 1, days };
  }

  function collectHabits() {
    const definitions = [...el.list.querySelectorAll(".definition-row")].map((row) => ({
      id: row.querySelector('[data-field="habit-id"]')?.value || "",
      label: row.querySelector('[data-field="habit-label"]')?.value || ""
    }));
    const validDefinitions = normalizeDefinitions(definitions);
    const validIds = new Set(validDefinitions.map((definition) => definition.id));
    const matrix = el.list.querySelector('[data-kind="habit-matrix"]');
    const displayedDates = new Set(matrix ? getMonthDates(matrix.dataset.month || currentMonth) : []);
    const preservedDays = (state.snapshot.habits.days || [])
      .filter((day) => !displayedDates.has(day.date))
      .map((day) => {
        const checks = {};
        Object.entries(day.checks || {}).forEach(([id, checked]) => {
          if (validIds.has(id)) checks[id] = Boolean(checked);
        });
        return { date: day.date, checks, updated_at: day.updated_at || null };
      });
    const matrixByDate = new Map();
    el.list.querySelectorAll('[data-field="habit-check"]').forEach((field) => {
      const date = field.dataset.date;
      const habitId = field.dataset.habitId;
      if (!isDate(date) || !validIds.has(habitId)) return;
      if (!matrixByDate.has(date)) matrixByDate.set(date, {});
      matrixByDate.get(date)[habitId] = field.checked;
    });
    const matrixDays = [...matrixByDate.entries()].map(([date, checks]) => ({
      date,
      checks,
      updated_at: null
    })).filter((day) => Object.values(day.checks).some(Boolean));
    return { definitions: validDefinitions, days: [...preservedDays, ...matrixDays] };
  }

  function collectMonthly() {
    const grouped = new Map();
    [...el.list.querySelectorAll('[data-kind="month-item"]')].forEach((row) => {
      const month = row.querySelector('[data-field="month-value"]')?.value || "";
      if (!isMonth(month)) return;
      const text = row.querySelector('[data-field="month-text"]')?.value || "";
      if (!text.trim()) return;
      if (!grouped.has(month)) grouped.set(month, []);
      grouped.get(month).push({
        id: row.dataset.itemId || uid("month"),
        text,
        done: Boolean(row.querySelector('[data-field="month-done"]')?.checked),
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
    el.list.querySelectorAll("[data-row]").forEach((row) => {
      const text = `${row.dataset.search || ""} ${row.querySelector("input[type='text']")?.value || ""}`.toLowerCase();
      const done = row.dataset.done === "true";
      const statusMatch = status === "all" || (status === "done" && done) || (status === "open" && !done);
      const dateMatch = !date || row.dataset.date === date;
      const monthMatch = !month || row.dataset.month === month;
      row.hidden = Boolean(query && !text.includes(query)) || !statusMatch || !dateMatch || !monthMatch;
    });
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
    if (search) search.value = "";
    if (status) status.value = "open";
    if (date) date.value = "";
    if (month) month.value = "";
  }

  function ensureFrogTbody() {
    let tbody = el.list.querySelector("tbody");
    if (tbody) return tbody;
    el.list.innerHTML = `
      <div class="table-scroll">
        <table class="data-table" aria-label="三只青蛙任务表">
          <thead>
            <tr>
              <th>完成</th>
              <th>青蛙任务</th>
              <th>关联日期</th>
              <th>序号</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <p class="table-note">共关联 1 个日记日期；筛选只影响显示，不会删掉隐藏记录。</p>
    `;
    return el.list.querySelector("tbody");
  }

  function ensureMonthlyTbody() {
    let tbody = el.list.querySelector("tbody");
    if (tbody) return tbody;
    el.list.innerHTML = `
      <div class="table-scroll">
        <table class="data-table" aria-label="月度事项表">
          <thead>
            <tr>
              <th>完成</th>
              <th>事项</th>
              <th>月份</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <p class="table-note">事项按对象维护；月份只是归属字段，历史未完成项会排在前面。</p>
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
        updated_at: day.updated_at || null
      })));
  }

  function sortFrogTasks(tasks) {
    return [...tasks].sort((a, b) => Number(a.done) - Number(b.done) || b.date.localeCompare(a.date) || a.slot - b.slot);
  }

  function flattenMonthItems(months) {
    return (months || []).flatMap((record) => (record.items || []).map((item) => ({
      month: record.month,
      id: item.id || uid("month"),
      text: item.text || "",
      done: Boolean(item.done),
      created_at: item.created_at || nowSeconds(),
      updated_at: item.updated_at || null
    })));
  }

  function sortMonthItems(items) {
    return [...items].sort((a, b) => Number(a.done) - Number(b.done) || b.month.localeCompare(a.month) || String(a.text).localeCompare(String(b.text), "zh-CN"));
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

  function defaultHabitDefinitions() {
    return [
      { id: "habit-journal", label: "写了晨间日记" },
      { id: "habit-focus", label: "推进了核心任务" },
      { id: "habit-review", label: "晚上做了简短回看" }
    ];
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
        done: Boolean(item.done)
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
      rows.push({ id, label });
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
        created_at: item.created_at || nowSeconds(),
        updated_at: item.updated_at || null
      })),
      updated_at: record.updated_at || null
    })).filter((record) => record.items.length).sort((a, b) => a.month.localeCompare(b.month));
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

  function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function isDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
  }

  function isMonth(value) {
    return /^\d{4}-\d{2}$/.test(value || "");
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  function formatUpdated(value) {
    if (!value) return "未保存";
    const date = new Date(Number(value) * 1000);
    if (Number.isNaN(date.getTime())) return "已保存";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function uid(prefix) {
    if (crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function toErrorMessage(error) {
    if (!error) return "出现未知错误";
    if (typeof error === "string") return error;
    return error.message || JSON.stringify(error);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();
