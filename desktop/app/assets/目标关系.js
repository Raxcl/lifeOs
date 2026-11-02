(() => {
  const {
    weekKey,
    weekRangeLabel,
    formatDate,
    nowSeconds,
    escapeHtml,
    toErrorMessage
  } = window.LifeOSShared;
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const fallbackKeys = {
    frogs: "lifeos-db:frogs",
    habits: "lifeos-db:habits",
    items: "lifeos-db:items",
    annualGoals: "lifeos-db:annual-goals"
  };
  const board = document.getElementById("relationBoard");
  const notice = document.getElementById("relationNotice");
  const lineGroup = document.getElementById("relationLines");
  const temporaryLine = document.getElementById("temporaryLine");
  const TARGET_SCOPE = { week: "month", month: "year" };
  const containers = {
    week: document.getElementById("weekCards"),
    month: document.getElementById("monthCards"),
    year: document.getElementById("yearCards")
  };
  const state = {
    snapshot: null,
    columns: { week: [], month: [], year: [] },
    saving: false,
    drag: null,
    connection: null,
    drawFrame: 0
  };
  const currentDate = formatDate(new Date());
  const currentWeek = weekKey(currentDate);
  const currentMonth = currentDate.slice(0, 7);
  const currentYear = currentDate.slice(0, 4);
  const labels = { week: "本周", month: "本月", year: "今年" };
  const emptyLabels = { week: "本周暂无事项", month: "本月暂无事项", year: "今年暂无目标" };

  window.LifeOSBackground.install({ layer: document.getElementById("wallpaperLayer") });
  document.getElementById("relationPeriod").textContent = `${weekRangeLabel(currentWeek)} · ${currentMonth} · ${currentYear}`;
  installDrawTriggers();
  installSortHandlers();
  installConnectionHandlers();
  boot();

  async function boot() {
    setBoardEnabled(false);
    setNotice("正在读取数据库...");
    try {
      state.snapshot = tauriInvoke
        ? await tauriInvoke("get_database_manager", {})
        : readFallbackSnapshot();
      selectCurrentColumns();
      render();
      setBoardEnabled(true);
      setNotice(tauriInvoke ? "已连接本地数据库。" : "当前是浏览器预览，仅展示本地缓存中的目标关系。");
    } catch (error) {
      state.snapshot = null;
      lineGroup.replaceChildren();
      setBoardEnabled(false);
      setNotice(`读取失败：${toErrorMessage(error)}`, true);
    }
  }

  function readFallbackSnapshot() {
    return {
      frogs: readFallback(fallbackKeys.frogs, { schema_version: 1, days: [] }),
      habits: readFallback(fallbackKeys.habits, { schema_version: 1, definitions: [], days: [] }),
      items: readFallback(fallbackKeys.items, { schema_version: 1, items: [] }),
      annual_goals: readFallback(fallbackKeys.annualGoals, { schema_version: 1, years: [] }),
      paths: {
        frogs: "本机预览 / LifeOS-Vault / 00-Databases / frogs.csv",
        habits: "本机预览 / LifeOS-Vault / 00-Databases / habits.csv",
        items: "本机预览 / LifeOS-Vault / 00-Databases / items.csv",
        annual_goals: "本机预览 / LifeOS-Vault / 00-Databases / annual-goals.csv"
      }
    };
  }

  function readFallback(key, fallback) {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  }

  async function invoke(command, args) {
    if (tauriInvoke) return tauriInvoke(command, args);
    if (command === "save_plan_item_database") {
      const database = { schema_version: 1, items: normalizeItems(args.items || []) };
      localStorage.setItem(fallbackKeys.items, JSON.stringify(database));
      return database;
    }
    if (command === "save_annual_goal_database") {
      const database = { schema_version: 1, years: normalizeAnnualGoalYears(args.years || []) };
      localStorage.setItem(fallbackKeys.annualGoals, JSON.stringify(database));
      return database;
    }
    throw new Error(`未支持的命令：${command}`);
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
        updated_at: item.updated_at || null,
        sort_order: Number(item.sort_order) || 0
      }));
  }

  function normalizeAnnualGoalYears(years) {
    return [...dedupeBy(years, "year")].filter((record) => /^\d{4}$/.test(String(record.year || ""))).map((record) => ({
      year: record.year,
      items: (record.items || []).filter((item) => String(item.text || "").trim()).map((item) => ({
        id: item.id || uid("year"),
        text: String(item.text || "").trim(),
        done: Boolean(item.done),
        created_at: item.created_at || nowSeconds(),
        updated_at: item.updated_at || null,
        sort_order: Number(item.sort_order) || 0
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

  function uid(prefix) {
    if (crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function selectCurrentColumns() {
    const items = Array.isArray(state.snapshot?.items?.items) ? state.snapshot.items.items : [];
    const years = Array.isArray(state.snapshot?.annual_goals?.years) ? state.snapshot.annual_goals.years : [];
    state.columns.week = items
      .filter((item) => item.scope === "week" && item.period === currentWeek)
      .sort(compareItems);
    state.columns.month = items
      .filter((item) => item.scope === "month" && item.period === currentMonth)
      .sort(compareItems);
    state.columns.year = years
      .filter((year) => String(year.year) === currentYear)
      .flatMap((year) => Array.isArray(year.items) ? year.items : [])
      .sort(compareItems);
  }

  function compareItems(a, b) {
    return ((a.sort_order || 0) - (b.sort_order || 0))
      || ((a.created_at || 0) - (b.created_at || 0))
      || String(a.id || "").localeCompare(String(b.id || ""));
  }

  function visibleMap() {
    const visible = new Map();
    for (const [scope, items] of Object.entries(state.columns)) {
      for (const item of items) visible.set(String(item.id), { item, scope });
    }
    return visible;
  }

  function parentTarget(scope, item, visible) {
    const targetScope = TARGET_SCOPE[scope];
    if (!targetScope || !item.parent_id) return null;
    const target = visible.get(String(item.parent_id));
    return target?.scope === targetScope ? target.item : null;
  }

  function formalRelations() {
    const visible = visibleMap();
    const relations = [];
    for (const scope of ["week", "month"]) {
      for (const item of state.columns[scope]) {
        const target = parentTarget(scope, item, visible);
        if (target) relations.push({ source: item, target });
      }
    }
    return relations;
  }

  function render() {
    selectCurrentColumns();
    const visible = visibleMap();
    for (const scope of ["week", "month", "year"]) {
      const items = state.columns[scope];
      containers[scope].innerHTML = items.length
        ? items.map((item) => renderCard(scope, item, visible)).join("")
        : `<p class="relation-empty">${emptyLabels[scope]}</p>`;
    }
    scheduleDraw();
  }

  function renderCard(scope, item, visible) {
    const id = String(item.id);
    const text = String(item.text || "未命名目标");
    const unavailable = scope !== "year" && item.parent_id && !parentTarget(scope, item, visible);
    return `
      <article class="relation-card${item.done ? " is-done" : ""}" data-scope="${scope}" data-item-id="${escapeHtml(id)}">
        <div class="relation-card-head">
          <button class="relation-handle" type="button" data-sort-handle aria-label="拖拽排序：${escapeHtml(text)}">↕</button>
          <span class="relation-card-kind">${labels[scope]}${item.done ? " · 已完成" : ""}</span>
        </div>
        <p class="relation-card-text">${escapeHtml(text)}</p>
        <div class="relation-card-actions">
          ${scope !== "year" ? `
            <button class="relation-connect" type="button" data-connect aria-label="连接${labels[scope]}目标：${escapeHtml(text)}">●</button>
            <button class="relation-action" type="button" data-disconnect aria-label="断开上级关系：${escapeHtml(text)}">断开</button>
          ` : ""}
          ${unavailable ? '<span class="relation-unavailable">上级不可用</span>' : ""}
        </div>
      </article>
    `;
  }

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

  function drawLines() {
    lineGroup.replaceChildren();
    if (!state.snapshot) return;
    for (const relation of formalRelations()) {
      const sourceCard = document.querySelector(`[data-item-id="${CSS.escape(String(relation.source.id))}"]`);
      const targetCard = document.querySelector(`[data-item-id="${CSS.escape(String(relation.target.id))}"]`);
      if (!sourceCard || !targetCard) continue;
      const source = boardPoint(sourceCard.getBoundingClientRect(), "right");
      const target = boardPoint(targetCard.getBoundingClientRect(), "left");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", curvePath(source, target));
      path.dataset.source = String(relation.source.id);
      path.dataset.target = String(relation.target.id);
      lineGroup.append(path);
    }
  }

  function scheduleDraw() {
    if (state.drawFrame) return;
    state.drawFrame = requestAnimationFrame(() => {
      state.drawFrame = 0;
      drawLines();
    });
  }

  function installDrawTriggers() {
    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(board);
    for (const column of document.querySelectorAll(".relation-column")) observer.observe(column);
    document.fonts.ready.then(scheduleDraw);
    window.addEventListener("resize", scheduleDraw);
  }

  function installSortHandlers() {
    board.addEventListener("pointerdown", startSort);
    board.addEventListener("pointermove", moveSort);
    board.addEventListener("pointerup", finishSort);
    board.addEventListener("pointercancel", cancelSort);
  }

  function startSort(event) {
    const handle = event.target.closest("[data-sort-handle]");
    if (!handle || state.saving || state.drag || state.connection || event.button !== 0) return;
    const card = handle.closest(".relation-card");
    const list = card?.parentElement;
    if (!card || !list) return;
    const before = structuredClone(state.snapshot);
    const scope = card.dataset.scope;
    state.drag = {
      card,
      list,
      handle,
      scope,
      before,
      beforeOrder: state.columns[scope].map((item) => String(item.id)),
      pointerId: event.pointerId,
      startY: event.clientY
    };
    handle.setPointerCapture(event.pointerId);
    card.classList.add("is-dragging");
    event.preventDefault();
    event.stopPropagation();
  }

  function moveSort(event) {
    const drag = state.drag;
    if (!drag || state.saving || drag.pointerId !== event.pointerId) return;
    const delta = event.clientY - drag.startY;
    drag.card.style.transform = `translateY(${delta}px)`;
    const siblings = [...drag.list.querySelectorAll(".relation-card")].filter((card) => card !== drag.card);
    const next = siblings.find((card) => {
      const rect = card.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    drag.list.insertBefore(drag.card, next || null);
    scheduleDraw();
    event.preventDefault();
  }

  async function finishSort(event) {
    const drag = state.drag;
    if (!drag || state.saving || drag.pointerId !== event.pointerId) return;
    state.drag = null;
    if (drag.handle.hasPointerCapture(event.pointerId)) drag.handle.releasePointerCapture(event.pointerId);
    drag.card.style.transform = "";
    drag.card.classList.remove("is-dragging");
    const ids = [...drag.list.querySelectorAll(".relation-card")].map((card) => card.dataset.itemId);
    scheduleDraw();
    if (ids.join("\u0000") === drag.beforeOrder.join("\u0000")) return;

    ids.forEach((id, index) => {
      if (drag.scope === "year") {
        const year = state.snapshot.annual_goals.years.find((record) => String(record.year) === currentYear);
        const item = year?.items.find((entry) => String(entry.id) === id);
        if (item) item.sort_order = index + 1;
      } else {
        const item = state.snapshot.items.items.find((entry) => String(entry.id) === id);
        if (item) item.sort_order = index + 1;
      }
    });
    selectCurrentColumns();
    await saveSnapshot(drag.before, drag.scope === "year" ? "annual" : "items");
    event.preventDefault();
  }

  function cancelSort(event) {
    const drag = state.drag;
    if (!drag || state.saving || drag.pointerId !== event.pointerId) return;
    state.drag = null;
    if (drag.handle.hasPointerCapture(event.pointerId)) drag.handle.releasePointerCapture(event.pointerId);
    state.snapshot = drag.before;
    render();
  }

  function installConnectionHandlers() {
    board.addEventListener("pointerdown", startConnection);
    board.addEventListener("pointermove", moveConnection);
    board.addEventListener("pointerup", finishConnection);
    board.addEventListener("pointercancel", cancelConnection);
    board.addEventListener("click", disconnect);
  }

  function startConnection(event) {
    const handle = event.target.closest("[data-connect]");
    if (!handle || state.saving || state.drag || state.connection || event.button !== 0) return;
    const card = handle.closest(".relation-card");
    const sourceId = card?.dataset.itemId;
    const sourceScope = card?.dataset.scope;
    const targetScope = TARGET_SCOPE[sourceScope];
    if (!sourceId || !targetScope) return;
    state.connection = { sourceId, sourceScope, pointerId: event.pointerId, handle };
    handle.setPointerCapture(event.pointerId);
    temporaryLine.classList.add("is-active");
    for (const target of containers[targetScope].querySelectorAll(".relation-card")) {
      target.classList.add("is-valid-target");
    }
    updateTemporaryLine(event);
    event.preventDefault();
    event.stopPropagation();
  }

  function moveConnection(event) {
    if (!state.connection || state.saving || state.connection.pointerId !== event.pointerId) return;
    updateTemporaryLine(event);
    event.preventDefault();
  }

  function updateTemporaryLine(event) {
    const connection = state.connection;
    const sourceCard = document.querySelector(`[data-item-id="${CSS.escape(connection.sourceId)}"]`);
    if (!sourceCard) return;
    const source = boardPoint(sourceCard.getBoundingClientRect(), "right");
    const boardRect = board.getBoundingClientRect();
    const target = { x: event.clientX - boardRect.left, y: event.clientY - boardRect.top };
    temporaryLine.setAttribute("d", curvePath(source, target));
  }

  async function finishConnection(event) {
    const connection = state.connection;
    if (!connection || state.saving || connection.pointerId !== event.pointerId) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".relation-card");
    const targetId = target?.dataset.itemId;
    const valid = targetId && target.dataset.scope === TARGET_SCOPE[connection.sourceScope];
    clearConnection();
    if (!valid) return;
    const item = state.snapshot.items.items.find((entry) => String(entry.id) === connection.sourceId);
    if (!item || String(item.parent_id || "") === targetId) return;
    const before = structuredClone(state.snapshot);
    item.parent_id = targetId;
    render();
    await saveSnapshot(before, "items");
    event.preventDefault();
  }

  function cancelConnection(event) {
    if (!state.connection || state.connection.pointerId !== event.pointerId) return;
    clearConnection();
  }

  function clearConnection() {
    const connection = state.connection;
    if (!connection) return;
    state.connection = null;
    if (connection.handle.hasPointerCapture(connection.pointerId)) {
      connection.handle.releasePointerCapture(connection.pointerId);
    }
    temporaryLine.classList.remove("is-active");
    temporaryLine.setAttribute("d", "");
    for (const target of document.querySelectorAll(".relation-card.is-valid-target")) {
      target.classList.remove("is-valid-target");
    }
  }

  async function disconnect(event) {
    const button = event.target.closest("[data-disconnect]");
    if (!button || state.saving || state.drag || state.connection) return;
    const sourceId = button.closest(".relation-card")?.dataset.itemId;
    const item = state.snapshot.items.items.find((entry) => String(entry.id) === sourceId);
    if (!item || !item.parent_id) return;
    const before = structuredClone(state.snapshot);
    item.parent_id = "";
    render();
    await saveSnapshot(before, "items");
    event.preventDefault();
  }

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

  function setBoardEnabled(enabled) {
    board.classList.toggle("is-disabled", !enabled);
    board.setAttribute("aria-disabled", String(!enabled));
    board.inert = !enabled;
  }

  function setControlsDisabled(disabled) {
    for (const button of board.querySelectorAll("button")) button.disabled = disabled;
  }

  function setNotice(message, stateName = "") {
    notice.textContent = message;
    notice.dataset.state = stateName === true ? "error" : stateName;
    notice.classList.toggle("is-error", stateName === true || stateName === "error");
  }
})();
