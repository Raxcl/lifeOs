(() => {
  const {
    weekKey,
    weekRangeLabel,
    formatDate,
    nowSeconds,
    escapeHtml,
    toErrorMessage
  } = window.LifeOSShared;
  const { Graph, Shape } = window.X6;
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  const fallbackKeys = {
    frogs: "lifeos-db:frogs",
    habits: "lifeos-db:habits",
    items: "lifeos-db:items",
    annualGoals: "lifeos-db:annual-goals"
  };
  const board = document.getElementById("relationBoard");
  const scroll = document.getElementById("relationScroll");
  const graphContainer = document.getElementById("relationGraph");
  const notice = document.getElementById("relationNotice");
  const TARGET_SCOPE = { week: "month", month: "year" };
  const NODE_HEIGHT = 136;
  const NODE_GAP = 14;
  const NODE_TOP = 92;
  const BOARD_PADDING = 30;
  const COLUMN_GAP = 64;
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
    layout: null
  };
  const currentDate = formatDate(new Date());
  const currentWeek = weekKey(currentDate);
  const currentMonth = currentDate.slice(0, 7);
  const currentYear = currentDate.slice(0, 4);
  const labels = { week: "本周", month: "本月", year: "今年" };
  const emptyLabels = { week: "本周暂无事项", month: "本月暂无事项", year: "今年暂无目标" };
  const portGroups = {
    in: portGroup("in"),
    out: portGroup("out")
  };

  Shape.HTML.register({
    shape: "relation-card-node",
    width: 280,
    height: NODE_HEIGHT,
    effect: ["data"],
    html(cell) {
      const { scope, item, unavailable } = cell.getData();
      return renderCard(scope, item, unavailable);
    }
  });

  const graph = new Graph({
    container: graphContainer,
    width: Math.max(960, scroll.clientWidth - 4),
    height: 420,
    background: false,
    grid: false,
    interacting: {
      nodeMovable: false,
      edgeMovable: false,
      edgeLabelMovable: false
    },
    connecting: {
      snap: { radius: 24 },
      allowBlank: false,
      allowLoop: false,
      allowNode: false,
      allowEdge: false,
      allowMulti: false,
      highlight: true,
      connector: { name: "smooth" },
      validateMagnet({ magnet }) {
        return Boolean(state.snapshot) && !state.saving && magnet.getAttribute("port-group") === "out";
      },
      validateConnection({ sourceCell, targetCell, sourceMagnet, targetMagnet }) {
        if (state.saving || !sourceCell || !targetCell || !sourceMagnet || !targetMagnet) return false;
        if (sourceMagnet.getAttribute("port-group") !== "out" || targetMagnet.getAttribute("port-group") !== "in") return false;
        const sourceScope = sourceCell.getData().scope;
        const targetScope = targetCell.getData().scope;
        return TARGET_SCOPE[sourceScope] === targetScope;
      },
      createEdge() {
        return new Shape.Edge(edgeOptions(false));
      }
    }
  });

  window.LifeOSBackground.install({ layer: document.getElementById("wallpaperLayer") });
  const backLink = document.querySelector(".relation-back");
  const fromJournal = new URLSearchParams(window.location.search).get("from") === "journal";
  backLink.href = fromJournal ? "晨间日记页面.html" : "index.html";
  backLink.textContent = fromJournal ? "← 返回晨间日记" : "← 返回日历";
  document.getElementById("relationPeriod").textContent = `${weekRangeLabel(currentWeek)} · ${currentMonth} · ${currentYear}`;
  installGraphHandlers();
  installSortHandlers();
  board.addEventListener("click", disconnect);
  window.addEventListener("resize", resizeGraph);
  window.addEventListener("beforeunload", (event) => {
    if (!state.saving) return;
    event.preventDefault();
    event.returnValue = "";
  });
  boot();

  function portGroup(group) {
    return {
      position: group === "in" ? "left" : "right",
      attrs: {
        circle: {
          class: "relation-port",
          "data-connect": "true",
          r: 4,
          magnet: true,
          stroke: "#687d5b",
          strokeWidth: 1.5,
          fill: "#fffdf7"
        }
      }
    };
  }

  function edgeOptions(formal, sourceId = "", targetId = "") {
    return {
      data: { formal },
      attrs: {
        line: {
          stroke: "#687d5b",
          strokeWidth: 2,
          targetMarker: { name: "block", width: 9, height: 7 },
          ...(formal ? { "data-source": sourceId, "data-target": targetId } : {})
        }
      },
      connector: { name: "smooth" },
      zIndex: 0
    };
  }

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
      graph.clearCells();
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
        text: String(item.text).trim(),
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

  function calculateLayout() {
    const width = Math.max(960, scroll.clientWidth - 4);
    const count = Math.max(...Object.values(state.columns).map((items) => items.length), 0);
    const height = Math.max(420, NODE_TOP + count * (NODE_HEIGHT + NODE_GAP) + BOARD_PADDING);
    const nodeWidth = (width - BOARD_PADDING * 2 - COLUMN_GAP * 2) / 3;
    return {
      width,
      height,
      nodeWidth,
      x: {
        week: BOARD_PADDING,
        month: BOARD_PADDING + nodeWidth + COLUMN_GAP,
        year: BOARD_PADDING + (nodeWidth + COLUMN_GAP) * 2
      }
    };
  }

  function updateBoardSize() {
    state.layout = calculateLayout();
    board.style.width = `${state.layout.width}px`;
    board.style.height = `${state.layout.height}px`;
    graph.resize(state.layout.width, state.layout.height);
  }

  function render() {
    selectCurrentColumns();
    updateBoardSize();
    const visible = visibleMap();
    const desiredIds = new Set(Object.values(state.columns).flat().map((item) => String(item.id)));
    for (const node of graph.getNodes()) {
      if (!desiredIds.has(String(node.id))) node.remove();
    }
    for (const scope of ["week", "month", "year"]) {
      const items = state.columns[scope];
      containers[scope].innerHTML = items.length ? "" : `<p class="relation-empty">${emptyLabels[scope]}</p>`;
      items.forEach((item, index) => {
        const id = String(item.id);
        const data = {
          scope,
          item,
          unavailable: scope !== "year" && item.parent_id && !parentTarget(scope, item, visible)
        };
        const x = state.layout.x[scope];
        const y = NODE_TOP + index * (NODE_HEIGHT + NODE_GAP);
        const existing = graph.getCellById(id);
        if (existing) {
          existing.setData(data);
          existing.resize(state.layout.nodeWidth, NODE_HEIGHT);
          existing.position(x, y);
          return;
        }
        const ports = [];
        if (scope !== "week") ports.push({ id: `${id}-in`, group: "in" });
        if (scope !== "year") ports.push({ id: `${id}-out`, group: "out" });
        graph.addNode({
          id,
          shape: "relation-card-node",
          x,
          y,
          width: state.layout.nodeWidth,
          height: NODE_HEIGHT,
          data,
          portMarkup: [{ tagName: "circle", selector: "circle" }],
          ports: { groups: portGroups, items: ports },
          zIndex: 1
        });
      });
    }
    const desiredRelations = new Map(formalRelations().map((relation) => {
      const sourceId = String(relation.source.id);
      const targetId = String(relation.target.id);
      return [`${sourceId}\u0000${targetId}`, { sourceId, targetId }];
    }));
    for (const edge of graph.getEdges()) {
      const key = `${edge.getSourceCellId()}\u0000${edge.getTargetCellId()}`;
      if (edge.getData()?.formal && desiredRelations.has(key)) {
        syncEdgeView(edge);
        desiredRelations.delete(key);
      } else {
        edge.remove();
      }
    }
    for (const { sourceId, targetId } of desiredRelations.values()) {
      graph.addEdge({
        ...edgeOptions(true, sourceId, targetId),
        source: { cell: sourceId, port: `${sourceId}-out` },
        target: { cell: targetId, port: `${targetId}-in` }
      });
    }
  }

  function renderCard(scope, item, unavailable) {
    const id = String(item.id);
    const text = String(item.text || "未命名目标");
    return `
      <article class="relation-card${item.done ? " is-done" : ""}" data-scope="${scope}" data-item-id="${escapeHtml(id)}">
        <div class="relation-card-head">
          <button class="relation-handle" type="button" data-sort-handle aria-label="拖拽排序：${escapeHtml(text)}">↕</button>
          <span class="relation-card-kind">${labels[scope]}${item.done ? " · 已完成" : ""}</span>
        </div>
        <p class="relation-card-text">${escapeHtml(text)}</p>
        <div class="relation-card-actions">
          ${scope !== "year" ? `<button class="relation-action" type="button" data-disconnect aria-label="断开上级关系：${escapeHtml(text)}">断开</button>` : ""}
          ${unavailable ? '<span class="relation-unavailable">上级不可用</span>' : ""}
        </div>
      </article>
    `;
  }

  function resizeGraph() {
    if (!state.snapshot) return;
    updateBoardSize();
    for (const scope of ["week", "month", "year"]) {
      state.columns[scope].forEach((item, index) => {
        const node = graph.getCellById(String(item.id));
        if (!node) return;
        node.resize(state.layout.nodeWidth, NODE_HEIGHT);
        node.position(state.layout.x[scope], NODE_TOP + index * (NODE_HEIGHT + NODE_GAP));
      });
    }
  }

  function installGraphHandlers() {
    board.addEventListener("mouseover", (event) => {
      const node = event.target.closest(".x6-node");
      if (node && (!event.relatedTarget || !node.contains(event.relatedTarget))) node.classList.add("ports-visible");
      event.target.closest(".relation-port")?.classList.add("is-port-active");
    });
    board.addEventListener("mouseout", (event) => {
      const node = event.target.closest(".x6-node");
      if (node && (!event.relatedTarget || !node.contains(event.relatedTarget))) node.classList.remove("ports-visible");
      event.target.closest(".relation-port")?.classList.remove("is-port-active");
    });
    graph.on("edge:connected", async ({ edge, isNew }) => {
      if (!isNew || state.saving) return;
      const sourceId = edge.getSourceCellId();
      const targetId = edge.getTargetCellId();
      const item = state.snapshot?.items.items.find((entry) => String(entry.id) === sourceId);
      if (!item || !targetId) {
        edge.remove();
        return;
      }
      if (String(item.parent_id || "") === targetId) {
        edge.remove();
        return;
      }
      const before = structuredClone(state.snapshot);
      item.parent_id = targetId;
      for (const candidate of graph.getEdges()) {
        if (candidate.id !== edge.id && candidate.getSourceCellId() === sourceId) candidate.remove();
      }
      edge.setData({ formal: true });
      syncEdgeView(edge);
      syncNodeData(sourceId);
      await saveSnapshot(before, "items");
    });
  }

  function syncEdgeView(edge) {
    if (!edge.getData()?.formal) return;
    edge.attr("line/data-source", edge.getSourceCellId());
    edge.attr("line/data-target", edge.getTargetCellId());
  }

  function syncNodeData(itemId) {
    const node = graph.getCellById(itemId);
    if (!node) return;
    const scope = node.getData().scope;
    const item = state.columns[scope].find((entry) => String(entry.id) === itemId);
    if (!item) return;
    node.setData({
      scope,
      item,
      unavailable: Boolean(item.parent_id) && !parentTarget(scope, item, visibleMap())
    });
  }

  function installSortHandlers() {
    board.addEventListener("pointerdown", startSort);
    board.addEventListener("pointermove", moveSort);
    board.addEventListener("pointerup", finishSort);
    board.addEventListener("pointercancel", cancelSort);
  }

  function startSort(event) {
    const handle = event.target.closest("[data-sort-handle]");
    if (!handle || state.saving || state.drag || event.button !== 0) return;
    const card = handle.closest(".relation-card");
    const node = graph.getCellById(card?.dataset.itemId);
    if (!card || !node) return;
    const position = node.getPosition();
    state.drag = {
      card,
      handle,
      node,
      scope: card.dataset.scope,
      before: structuredClone(state.snapshot),
      beforeOrder: state.columns[card.dataset.scope].map((item) => String(item.id)),
      pointerId: event.pointerId,
      startY: event.clientY,
      startNodeY: position.y
    };
    handle.setPointerCapture(event.pointerId);
    card.classList.add("is-dragging");
    event.preventDefault();
    event.stopPropagation();
  }

  function moveSort(event) {
    const drag = state.drag;
    if (!drag || state.saving || drag.pointerId !== event.pointerId) return;
    const y = Math.max(
      NODE_TOP,
      Math.min(drag.startNodeY + event.clientY - drag.startY, state.layout.height - NODE_HEIGHT - BOARD_PADDING)
    );
    drag.node.position(state.layout.x[drag.scope], y);
    event.preventDefault();
  }

  async function finishSort(event) {
    const drag = state.drag;
    if (!drag || state.saving || drag.pointerId !== event.pointerId) return;
    state.drag = null;
    if (drag.handle.hasPointerCapture(event.pointerId)) drag.handle.releasePointerCapture(event.pointerId);
    drag.card.classList.remove("is-dragging");
    drag.node.position(state.layout.x[drag.scope], drag.node.getPosition().y);
    const ids = graph.getNodes()
      .filter((node) => node.getData().scope === drag.scope)
      .sort((a, b) => a.getPosition().y - b.getPosition().y)
      .map((node) => String(node.id));
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
    render();
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

  async function disconnect(event) {
    const button = event.target.closest("[data-disconnect]");
    if (!button || state.saving || state.drag) return;
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
    }
  }

  function setBoardEnabled(enabled) {
    board.classList.toggle("is-disabled", !enabled);
    board.setAttribute("aria-disabled", String(!enabled));
    board.inert = !enabled;
  }

  function setControlsDisabled(disabled) {
    board.setAttribute("aria-busy", String(disabled));
    for (const button of board.querySelectorAll("button")) button.disabled = disabled;
  }

  function setNotice(message, stateName = "") {
    notice.textContent = message;
    notice.dataset.state = stateName === true ? "error" : stateName;
    notice.classList.toggle("is-error", stateName === true || stateName === "error");
  }
})();
