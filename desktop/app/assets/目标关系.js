(() => {
  const {
    weekKey,
    weekRangeLabel,
    formatDate,
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
    const targetScope = { week: "month", month: "year" }[scope];
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

  function setBoardEnabled(enabled) {
    board.classList.toggle("is-disabled", !enabled);
    board.setAttribute("aria-disabled", String(!enabled));
    board.inert = !enabled;
  }

  function setNotice(message, isError = false) {
    notice.textContent = message;
    notice.classList.toggle("is-error", isError);
  }
})();
