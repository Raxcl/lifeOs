import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_URL = pathToFileURL(`${path.join(ROOT, "desktop", "app")}/`).href;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable"
].filter(Boolean);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForValue(read, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

function chromeExecutable() {
  const executable = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Google Chrome was not found; set CHROME_PATH to its executable.");
  return executable;
}

async function withChrome(run) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lifeos-plan-relations-"));
  const chrome = spawn(chromeExecutable(), [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--metrics-recording-only",
    "--mute-audio",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const exitPromise = new Promise((resolve) => chrome.once("exit", resolve));
  let socket;

  try {
    const port = await waitForValue(() => {
      const activePort = path.join(profile, "DevToolsActivePort");
      return fs.existsSync(activePort) ? fs.readFileSync(activePort, "utf8").split("\n")[0].trim() : "";
    }, "Chrome DevTools port");
    const targets = await waitForValue(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return null;
      const pages = await response.json();
      return pages.find((target) => target.type === "page");
    }, "Chrome page target");

    socket = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to Chrome DevTools.")), 10000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to Chrome DevTools."));
      }, { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    const consoleErrors = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(message.params.args.map((argument) => argument.value || argument.description || "").join(" "));
      }
      if (!message.id) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result || {});
    });
    socket.addEventListener("close", () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`Chrome closed during ${request.method}.`));
      }
      pending.clear();
    });

    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out during ${method}.`));
        }, 10000);
        pending.set(id, { method, resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evaluate(expression) {
      const response = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
      });
      if (response.exceptionDetails) {
        const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
        throw new Error(description);
      }
      return response.result?.value;
    }

    async function openPage(relativePath, width = 1440, height = 1000) {
      const url = new URL(relativePath, APP_URL).href;
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      });
      const navigation = await send("Page.navigate", { url });
      if (navigation.errorText) throw new Error(`Could not open ${relativePath}: ${navigation.errorText}`);
      await waitForValue(
        () => evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`),
        `${relativePath} to load`
      );
    }

    async function addInitScript(source) {
      await send("Page.addScriptToEvaluateOnNewDocument", { source });
    }

    let mouseDown = false;
    async function mouse(type, x, y) {
      if (type === "mousePressed") mouseDown = true;
      if (type === "mouseReleased") mouseDown = false;
      await send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: mouseDown ? 1 : 0,
        clickCount: type === "mouseMoved" ? 0 : 1
      });
    }

    await send("Page.enable");
    await send("Runtime.enable");
    return await run({ openPage, addInitScript, evaluate, mouse, assert, getConsoleErrors: () => [...consoleErrors] });
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: -1, method: "Browser.close" }));
    } else if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGTERM");
    }
    if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = await Promise.race([exitPromise.then(() => true), delay(5000).then(() => false)]);
      if (!exited) {
        chrome.kill("SIGKILL");
        await exitPromise;
      }
    }
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

async function waitFor(evaluate, expression, description) {
  return waitForValue(() => evaluate(expression), description);
}

async function clickSelector(evaluate, mouse, selector) {
  const point = await evaluate(`(async () => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error(${JSON.stringify(`Missing selector: ${selector}`)});
    element.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await mouse("mousePressed", point.x, point.y);
  await mouse("mouseReleased", point.x, point.y);
}

async function dragCardBelow(evaluate, mouse, sourceId, targetId, whileDragging) {
  const points = await evaluate(`(async () => {
    const handle = document.querySelector('[data-item-id="${sourceId}"] [data-sort-handle]');
    const target = document.querySelector('[data-item-id="${targetId}"]');
    if (!handle || !target) throw new Error("Missing sort drag fixture");
    target.scrollIntoView({ block: "center", inline: "center" });
    handle.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const handleRect = handle.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return {
      start: { x: handleRect.left + handleRect.width / 2, y: handleRect.top + handleRect.height / 2 },
      end: { x: targetRect.left + targetRect.width / 2, y: targetRect.bottom + 8 }
    };
  })()`);
  await mouse("mousePressed", points.start.x, points.start.y);
  await mouse("mouseMoved", points.end.x, points.end.y);
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  if (whileDragging) await whileDragging();
  await mouse("mouseReleased", points.end.x, points.end.y);
}

async function dragConnection(evaluate, mouse, sourceId, targetId, { whileDragging, cancel = false } = {}) {
  const points = await evaluate(`(async () => {
    const handle = document.querySelector('[data-item-id="${sourceId}"] [data-connect]');
    const target = ${targetId ? `document.querySelector('[data-item-id="${targetId}"]')` : "null"};
    const board = document.querySelector("#relationBoard");
    if (!handle || (${Boolean(targetId)} && !target)) throw new Error("Missing connection drag fixture");
    if (target) target.scrollIntoView({ block: "center", inline: "center" });
    handle.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const handleRect = handle.getBoundingClientRect();
    const boardRect = board.getBoundingClientRect();
    const end = target ? (() => {
      const targetRect = target.getBoundingClientRect();
      return { x: targetRect.left + targetRect.width / 2, y: targetRect.top + targetRect.height / 2 };
    })() : { x: boardRect.right - 12, y: boardRect.bottom - 12 };
    if (!target && document.elementFromPoint(end.x, end.y)?.closest(".relation-card")) {
      throw new Error("Blank connection fixture hit a card");
    }
    return {
      start: { x: handleRect.left + handleRect.width / 2, y: handleRect.top + handleRect.height / 2 },
      end
    };
  })()`);
  await mouse("mousePressed", points.start.x, points.start.y);
  await mouse("mouseMoved", points.end.x, points.end.y);
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  if (whileDragging) await whileDragging(points.end);
  if (cancel) {
    await evaluate(`document.querySelector('[data-item-id="${sourceId}"] [data-connect]').dispatchEvent(
      new PointerEvent("pointercancel", { bubbles: true, pointerId: 1, pointerType: "mouse" })
    )`);
  } else {
    await mouse("mouseReleased", points.end.x, points.end.y);
  }
  await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}

const JOURNAL_FIXTURE = `
localStorage.setItem("lifeos-db:items", JSON.stringify({schema_version:1,items:[{
  id:"m-sort",text:"保留月排序",done:false,note:"",scope:"month",period:"2026-10",
  parent_id:"",created_at:1,updated_at:1,sort_order:42
}]}));
localStorage.setItem("lifeos-db:annual-goals", JSON.stringify({schema_version:1,years:[{
  year:"2026",updated_at:1,items:[{id:"y-sort",text:"保留年排序",done:false,created_at:1,updated_at:1,sort_order:23}]
}]}));
location.reload();
`;

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function relationFixture({ emptyYear = false } = {}) {
  const now = new Date();
  const today = localDateKey(now);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const currentWeek = localDateKey(monday);
  const currentMonth = today.slice(0, 7);
  const currentYear = today.slice(0, 4);
  const otherYear = String(Number(currentYear) - 1);
  const otherMonth = localDateKey(new Date(now.getFullYear(), now.getMonth() + 1, 1)).slice(0, 7);
  const items = {
    schema_version: 1,
    items: [
      { id: "w1", text: "本周关联事项", done: false, note: "", scope: "week", period: currentWeek, parent_id: "m1", created_at: 1, updated_at: 1, sort_order: 1 },
      { id: "w2", text: "本周已完成事项", done: true, note: "", scope: "week", period: currentWeek, parent_id: "", created_at: 2, updated_at: 2, sort_order: 2 },
      { id: "m1", text: "本月关联事项", done: false, note: "", scope: "month", period: currentMonth, parent_id: "y1", created_at: 3, updated_at: 3, sort_order: 1 },
      { id: "m2", text: "本月悬空事项", done: false, note: "", scope: "month", period: currentMonth, parent_id: "missing-year", created_at: 4, updated_at: 4, sort_order: 2 },
      { id: "m-other", text: "其他月份事项", done: false, note: "", scope: "month", period: otherMonth, parent_id: "", created_at: 5, updated_at: 5, sort_order: 3 }
    ]
  };
  const annualGoals = {
    schema_version: 1,
    years: [
      {
        year: currentYear,
        updated_at: 1,
        items: emptyYear ? [] : [
          { id: "y1", text: "今年关联目标", done: false, created_at: 6, updated_at: 6, sort_order: 1 },
          { id: "y2", text: "今年第二目标", done: false, created_at: 7, updated_at: 7, sort_order: 2 }
        ]
      },
      {
        year: otherYear,
        updated_at: 8,
        items: [{ id: "y-other", text: "其他年度目标", done: false, created_at: 8, updated_at: 8, sort_order: 9 }]
      }
    ]
  };
  return `
    localStorage.setItem("lifeos-db:items", JSON.stringify(${JSON.stringify(items)}));
    localStorage.setItem("lifeos-db:annual-goals", JSON.stringify(${JSON.stringify(annualGoals)}));
    location.reload();
  `;
}

const tests = [
  {
    name: "journal month and annual fallback saves preserve sort_order",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("晨间日记页面.html?date=2026-10-15");
      await evaluate(JOURNAL_FIXTURE);
      await waitFor(evaluate, `document.querySelector('#todoList [data-id="m-sort"]')`, "journal month fixture");
      await evaluate(`document.querySelector('#todoInput').value = '新增月事项'`);
      await clickSelector(evaluate, mouse, "#addTodo");
      await waitFor(evaluate, `JSON.parse(localStorage.getItem('lifeos-db:items')).items.some((item) => item.text === '新增月事项')`, "month item save");
      await evaluate(`(() => {
        const input = [...document.querySelectorAll('#annualGoalList input.write-line')].find((field) => !field.value);
        input.value = '新增年度目标';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(evaluate, `JSON.parse(localStorage.getItem('lifeos-db:annual-goals')).years[0].items.some((item) => item.text === '新增年度目标')`, "annual goal save");
      const { items, years } = await evaluate(`(() => {
        const items = JSON.parse(localStorage.getItem("lifeos-db:items")).items;
        const years = JSON.parse(localStorage.getItem("lifeos-db:annual-goals")).years;
        return { items, years };
      })()`);
      assert.equal(items.find((item) => item.id === "m-sort").sort_order, 42);
      assert.equal(years[0].items.find((item) => item.id === "y-sort").sort_order, 23);
    }
  },
  {
    name: "inbox manager edit preserves sort_order",
    async run({ openPage, evaluate, assert }) {
      await openPage("收集箱.html");
      await evaluate(`
        localStorage.setItem("lifeos-db:items", JSON.stringify({schema_version:1,items:[{
          id:"i-sort",text:"保留收集箱排序",done:false,note:"",scope:"inbox",period:"",
          parent_id:"",created_at:1,updated_at:1,sort_order:17
        }]}));
        location.reload();
      `);
      await waitFor(evaluate, `document.querySelector('[data-item-id="i-sort"] [data-field="item-text"]')`, "inbox fixture");
      await evaluate(`(() => {
        const input = document.querySelector('[data-item-id="i-sort"] [data-field="item-text"]');
        input.value = '保留收集箱排序（已编辑）';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(evaluate, `JSON.parse(localStorage.getItem('lifeos-db:items')).items[0]?.text === '保留收集箱排序（已编辑）'`, "inbox text writeback");
      const sortOrder = await evaluate(`JSON.parse(localStorage.getItem('lifeos-db:items')).items.find((item) => item.id === 'i-sort').sort_order`);
      assert.equal(sortOrder, 17);
    }
  },
  {
    name: "annual goal manager edit preserves sort_order",
    async run({ openPage, evaluate, assert }) {
      await openPage("年度目标管理.html");
      await evaluate(`
        localStorage.setItem("lifeos-db:annual-goals", JSON.stringify({schema_version:1,years:[{
          year:"2026",updated_at:1,items:[{id:"y-sort",text:"保留年排序",done:false,created_at:1,updated_at:1,sort_order:23}]
        }]}));
        location.reload();
      `);
      await waitFor(evaluate, `document.querySelector('[data-item-id="y-sort"] [data-field="goal-text"]')`, "annual goal fixture");
      await evaluate(`(() => {
        const input = document.querySelector('[data-item-id="y-sort"] [data-field="goal-text"]');
        input.value = '保留年排序（已编辑）';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor(evaluate, `JSON.parse(localStorage.getItem('lifeos-db:annual-goals')).years[0].items[0]?.text === '保留年排序（已编辑）'`, "annual goal text writeback");
      const sortOrder = await evaluate(`JSON.parse(localStorage.getItem('lifeos-db:annual-goals')).years[0].items.find((item) => item.id === 'y-sort').sort_order`);
      assert.equal(sortOrder, 23);
    }
  },
  {
    name: "home preview completion preserves sort_order",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("index.html");
      await evaluate(`
        localStorage.setItem("lifeos-db:items", JSON.stringify({schema_version:1,items:[{
          id:"i-sort",text:"保留收集箱排序",done:false,note:"",scope:"inbox",period:"",
          parent_id:"",created_at:1,updated_at:1,sort_order:17
        }]}));
        localStorage.setItem("lifeos-db:annual-goals", JSON.stringify({schema_version:1,years:[{
          year:"2026",updated_at:1,items:[{id:"y-sort",text:"保留年排序",done:false,created_at:1,updated_at:1,sort_order:23}]
        }]}));
        location.reload();
      `);
      await waitFor(evaluate, `document.querySelector('[data-preview-kind="item"][data-item-id="i-sort"]') && document.querySelector('[data-preview-kind="annual-goal"][data-item-id="y-sort"]')`, "home preview fixtures");
      await clickSelector(evaluate, mouse, '[data-preview-kind="item"][data-item-id="i-sort"]');
      await waitFor(evaluate, `JSON.parse(localStorage.getItem('lifeos-db:items')).items.find((item) => item.id === 'i-sort').done === true`, "home item done writeback");
      await clickSelector(evaluate, mouse, '[data-preview-kind="annual-goal"][data-item-id="y-sort"]');
      await waitFor(evaluate, `JSON.parse(localStorage.getItem('lifeos-db:annual-goals')).years[0].items.find((item) => item.id === 'y-sort').done === true`, "home annual goal done writeback");
      const { itemSort, goalSort } = await evaluate(`(() => ({
        itemSort: JSON.parse(localStorage.getItem('lifeos-db:items')).items.find((item) => item.id === 'i-sort').sort_order,
        goalSort: JSON.parse(localStorage.getItem('lifeos-db:annual-goals')).years[0].items.find((item) => item.id === 'y-sort').sort_order
      }))()`);
      assert.equal(itemSort, 17);
      assert.equal(goalSort, 23);
    }
  },
  {
    name: "relation page filters current periods and draws only valid formal links",
    async run({ openPage, evaluate, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('[data-item-id="w1"]') && document.querySelectorAll('#relationSvg path[data-source]').length === 2`, "relation cards and formal paths");
      const cards = await evaluate(`(() => {
        const cardIds = (scope) => Array.from(
          document.querySelectorAll('.relation-card[data-scope="' + scope + '"]'),
          (card) => card.dataset.itemId
        );
        return { week: cardIds("week"), month: cardIds("month"), year: cardIds("year") };
      })()`);
      assert.deepEqual(cards.week, ["w1", "w2"]);
      assert.deepEqual(cards.month, ["m1", "m2"]);
      assert.deepEqual(cards.year, ["y1", "y2"]);
      assert.equal(await evaluate(`document.querySelectorAll("#relationSvg path[data-source]").length`), 2);
      assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="w1"]').dataset.target`), "m1");
      assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="m1"]').dataset.target`), "y1");
      assert.ok(await evaluate(`document.querySelector('#relationSvg path[data-source="w1"]').getAttribute("d").includes(" C ")`));
      assert.ok(await evaluate(`document.querySelector('[data-item-id="w2"]').classList.contains("is-done")`));
      assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="w2"]')`), null);
      assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="m2"]')`), null);
      assert.equal(await evaluate(`document.querySelector('[data-item-id="m2"] .relation-unavailable').textContent`), "上级不可用");
      assert.equal(await evaluate(`document.querySelector('[data-item-id="m-other"]')`), null);
      assert.ok(await evaluate(`["w1", "m1", "y1"].every((id) => document.querySelector('[data-item-id="' + id + '"] [data-sort-handle]'))`));
      assert.ok(await evaluate(`["w1", "m1"].every((id) => document.querySelector('[data-item-id="' + id + '"] [data-connect]') && document.querySelector('[data-item-id="' + id + '"] [data-disconnect]'))`));
    }
  },
  {
    name: "relation sorting follows the pointer and persists current week order",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('[data-item-id="w1"]') && document.querySelector('#relationSvg path[data-source="w1"]')`, "week sort fixture");
      const beforePath = await evaluate(`document.querySelector('#relationSvg path[data-source="w1"]').getAttribute("d")`);
      const beforeAnnual = await evaluate(`localStorage.getItem("lifeos-db:annual-goals")`);
      const beforeItems = await evaluate(`JSON.parse(localStorage.getItem("lifeos-db:items")).items`);
      await dragCardBelow(evaluate, mouse, "w1", "w2", async () => {
        const duringPath = await evaluate(`document.querySelector('#relationSvg path[data-source="w1"]').getAttribute("d")`);
        assert.notEqual(duringPath, beforePath, "formal path must follow the card before pointerup");
      });
      await waitFor(evaluate, `(() => {
        const items = JSON.parse(localStorage.getItem("lifeos-db:items")).items;
        return items.find((item) => item.id === "w2").sort_order === 1 && items.find((item) => item.id === "w1").sort_order === 2;
      })()`, "week sort save");
      const saved = await evaluate(`(() => {
        const database = JSON.parse(localStorage.getItem("lifeos-db:items"));
        const order = Array.from(document.querySelectorAll('#weekCards .relation-card'), (card) => {
          const item = database.items.find((entry) => entry.id === card.dataset.itemId);
          return { id: item.id, sort_order: item.sort_order, scope: item.scope, period: item.period, parent_id: item.parent_id };
        });
        return { order, otherMonth: database.items.find((item) => item.id === "m-other") };
      })()`);
      assert.deepEqual(saved.order, [
        { id: "w2", sort_order: 1, scope: "week", period: beforeItems.find((item) => item.id === "w2").period, parent_id: "" },
        { id: "w1", sort_order: 2, scope: "week", period: beforeItems.find((item) => item.id === "w1").period, parent_id: "m1" }
      ]);
      assert.deepEqual(saved.otherMonth, beforeItems.find((item) => item.id === "m-other"));
      assert.equal(await evaluate(`localStorage.getItem("lifeos-db:annual-goals")`), beforeAnnual);
      await evaluate(`location.reload()`);
      await waitFor(evaluate, `Array.from(document.querySelectorAll('#weekCards .relation-card'), (card) => card.dataset.itemId).join(",") === "w2,w1"`, "week order after refresh");
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#weekCards .relation-card'), (card) => card.dataset.itemId)`), ["w2", "w1"]);
    }
  },
  {
    name: "relation annual sorting saves only annual goals",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('[data-item-id="y2"]')`, "annual sort fixture");
      const beforeItems = await evaluate(`localStorage.getItem("lifeos-db:items")`);
      await dragCardBelow(evaluate, mouse, "y1", "y2");
      await waitFor(evaluate, `(() => {
        const years = JSON.parse(localStorage.getItem("lifeos-db:annual-goals")).years;
        const current = years.find((year) => year.items.some((item) => item.id === "y1"));
        return current.items.find((item) => item.id === "y2").sort_order === 1 && current.items.find((item) => item.id === "y1").sort_order === 2;
      })()`, "annual sort save");
      assert.equal(await evaluate(`localStorage.getItem("lifeos-db:items")`), beforeItems);
      const saved = await evaluate(`(() => {
        const years = JSON.parse(localStorage.getItem("lifeos-db:annual-goals")).years;
        const current = years.find((year) => year.items.some((item) => item.id === "y1"));
        const other = years.find((year) => year.items.some((item) => item.id === "y-other"));
        return {
          order: Array.from(document.querySelectorAll('#yearCards .relation-card'), (card) => {
            const item = current.items.find((entry) => entry.id === card.dataset.itemId);
            return { id: item.id, sort_order: item.sort_order };
          }),
          other
        };
      })()`);
      assert.deepEqual(saved.order, [{ id: "y2", sort_order: 1 }, { id: "y1", sort_order: 2 }]);
      assert.equal(saved.other.items[0].sort_order, 9);
      assert.equal(saved.other.updated_at, 8);
    }
  },
  {
    name: "relation item sort save failure restores DOM storage and lines",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('[data-item-id="w1"]') && document.querySelector('#relationSvg path[data-source="w1"]')`, "item rollback fixture");
      const before = await evaluate(`(() => ({
        items: localStorage.getItem("lifeos-db:items"),
        order: Array.from(document.querySelectorAll('#weekCards .relation-card'), (card) => card.dataset.itemId),
        path: document.querySelector('#relationSvg path[data-source="w1"]').getAttribute("d")
      }))()`);
      await evaluate(`
        window.__originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === "lifeos-db:items") throw new Error("模拟保存失败");
          return window.__originalSetItem.call(this, key, value);
        };
      `);
      try {
        await dragCardBelow(evaluate, mouse, "w1", "w2");
        await waitFor(evaluate, `document.querySelector('#relationNotice').textContent.includes("保存失败，已撤销")`, "item rollback notice");
        await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#weekCards .relation-card'), (card) => card.dataset.itemId)`), before.order);
        assert.equal(await evaluate(`localStorage.getItem("lifeos-db:items")`), before.items);
        assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="w1"]').getAttribute("d")`), before.path);
        assert.match(await evaluate(`document.querySelector('#relationNotice').textContent`), /模拟保存失败/);
        assert.ok(await evaluate(`document.querySelector('#relationNotice').classList.contains("is-error")`));
      } finally {
        await evaluate(`Storage.prototype.setItem = window.__originalSetItem; delete window.__originalSetItem;`);
      }
    }
  },
  {
    name: "relation annual sort save failure restores DOM storage and lines",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('[data-item-id="y2"]') && document.querySelector('#relationSvg path[data-source="m1"]')`, "annual rollback fixture");
      const before = await evaluate(`(() => ({
        annual: localStorage.getItem("lifeos-db:annual-goals"),
        order: Array.from(document.querySelectorAll('#yearCards .relation-card'), (card) => card.dataset.itemId),
        path: document.querySelector('#relationSvg path[data-source="m1"]').getAttribute("d")
      }))()`);
      await evaluate(`
        window.__originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === "lifeos-db:annual-goals") throw new Error("模拟年度保存失败");
          return window.__originalSetItem.call(this, key, value);
        };
      `);
      try {
        await dragCardBelow(evaluate, mouse, "y1", "y2");
        await waitFor(evaluate, `document.querySelector('#relationNotice').textContent.includes("保存失败，已撤销")`, "annual rollback notice");
        await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#yearCards .relation-card'), (card) => card.dataset.itemId)`), before.order);
        assert.equal(await evaluate(`localStorage.getItem("lifeos-db:annual-goals")`), before.annual);
        assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="m1"]').getAttribute("d")`), before.path);
        assert.match(await evaluate(`document.querySelector('#relationNotice').textContent`), /模拟年度保存失败/);
        assert.ok(await evaluate(`document.querySelector('#relationNotice').classList.contains("is-error")`));
      } finally {
        await evaluate(`Storage.prototype.setItem = window.__originalSetItem; delete window.__originalSetItem;`);
      }
    }
  },
  {
    name: "relation manual connection connects w2 to m2 then replaces it with m1",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('[data-item-id="w2"] [data-connect]')`, "manual connection fixture");
      const beforeAnnual = await evaluate(`localStorage.getItem("lifeos-db:annual-goals")`);

      await dragConnection(evaluate, mouse, "w2", "m2");
      assert.equal(
        await evaluate(`JSON.parse(localStorage.getItem("lifeos-db:items")).items.find((item) => item.id === "w2").parent_id`),
        "m2",
        "the first connection must persist w2.parent_id"
      );
      await waitFor(evaluate, `document.querySelector('#relationSvg path[data-source="w2"][data-target="m2"]')`, "w2 to m2 formal path");
      assert.equal(await evaluate(`document.querySelectorAll('#relationSvg path[data-source="w2"]').length`), 1);
      assert.equal(await evaluate(`document.querySelector("#temporaryLine").getAttribute("d")`), "");
      assert.equal(await evaluate(`document.querySelectorAll(".relation-card.is-valid-target").length`), 0);

      await dragConnection(evaluate, mouse, "w2", "m1");
      await waitFor(evaluate, `JSON.parse(localStorage.getItem("lifeos-db:items")).items.find((item) => item.id === "w2").parent_id === "m1"`, "replacement parent save");
      await waitFor(evaluate, `document.querySelector('#relationSvg path[data-source="w2"][data-target="m1"]')`, "replacement formal path");
      const replacement = await evaluate(`(() => {
        const items = JSON.parse(localStorage.getItem("lifeos-db:items")).items.filter((item) => item.id === "w2");
        return {
          parents: items.map((item) => item.parent_id),
          paths: Array.from(document.querySelectorAll('#relationSvg path[data-source="w2"]'), (path) => path.dataset.target)
        };
      })()`);
      assert.deepEqual(replacement.parents, ["m1"], "replacement must keep one item and overwrite parent_id");
      assert.deepEqual(replacement.paths, ["m1"], "replacement must remove the old formal path");

      await evaluate(`
        window.__originalSetItem = Storage.prototype.setItem;
        window.__itemWrites = 0;
        Storage.prototype.setItem = function (key, value) {
          if (key === "lifeos-db:items") window.__itemWrites += 1;
          return window.__originalSetItem.call(this, key, value);
        };
      `);
      try {
        const beforeNoOp = await evaluate(`localStorage.getItem("lifeos-db:items")`);
        await dragConnection(evaluate, mouse, "w2", "m1");
        assert.equal(await evaluate(`window.__itemWrites`), 0, "connecting the existing parent must be a no-op");
        assert.equal(await evaluate(`localStorage.getItem("lifeos-db:items")`), beforeNoOp);
        assert.equal(await evaluate(`localStorage.getItem("lifeos-db:annual-goals")`), beforeAnnual, "connections must save only items");
      } finally {
        await evaluate(`Storage.prototype.setItem = window.__originalSetItem; delete window.__originalSetItem; delete window.__itemWrites;`);
      }
    }
  },
  {
    name: "relation connection preview follows the pointer and highlights only legal cards",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('[data-item-id="w2"] [data-connect]')`, "connection preview fixture");
      await dragConnection(evaluate, mouse, "w2", "m2", {
        whileDragging: async (end) => {
          const preview = await evaluate(`(() => {
            const line = document.querySelector("#temporaryLine");
            const boardRect = document.querySelector("#relationBoard").getBoundingClientRect();
            const match = line.getAttribute("d").match(/,\\s*(-?[\\d.]+)\\s+(-?[\\d.]+)$/);
            const point = ${JSON.stringify(end)};
            return {
              display: getComputedStyle(line).display,
              path: line.getAttribute("d"),
              actualEnd: match ? { x: Number(match[1]), y: Number(match[2]) } : null,
              expectedEnd: { x: point.x - boardRect.left, y: point.y - boardRect.top },
              highlights: Array.from(document.querySelectorAll(".relation-card.is-valid-target"), (card) => card.dataset.itemId),
              captured: document.querySelector('[data-item-id="w2"] [data-connect]').hasPointerCapture(1)
            };
          })()`);
          assert.notEqual(preview.display, "none");
          assert.ok(preview.path.includes(" C "));
          assert.ok(Math.abs(preview.actualEnd.x - preview.expectedEnd.x) < 0.01, "temporary path x must follow the pointer");
          assert.ok(Math.abs(preview.actualEnd.y - preview.expectedEnd.y) < 0.01, "temporary path y must follow the pointer");
          assert.deepEqual(preview.highlights, ["m1", "m2"], "only month cards are legal week targets");
          assert.equal(preview.captured, true);
        }
      });
      await waitFor(evaluate, `JSON.parse(localStorage.getItem("lifeos-db:items")).items.find((item) => item.id === "w2").parent_id === "m2"`, "preview connection save");
      assert.equal(await evaluate(`document.querySelector("#temporaryLine").getAttribute("d")`), "");
      assert.equal(await evaluate(`document.querySelectorAll(".relation-card.is-valid-target").length`), 0);
      assert.equal(await evaluate(`document.querySelector('[data-item-id="w2"] [data-connect]').hasPointerCapture(1)`), false);
    }
  },
  {
    name: "relation invalid blank and pointercancel gestures leave data unchanged",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('#relationSvg path[data-source="w1"][data-target="m1"]')`, "connection cancellation fixture");
      const before = await evaluate(`(() => ({
        items: localStorage.getItem("lifeos-db:items"),
        annual: localStorage.getItem("lifeos-db:annual-goals"),
        path: document.querySelector('#relationSvg path[data-source="w1"]').getAttribute("d")
      }))()`);
      await evaluate(`
        window.__originalSetItem = Storage.prototype.setItem;
        window.__itemWrites = 0;
        Storage.prototype.setItem = function (key, value) {
          if (key === "lifeos-db:items") window.__itemWrites += 1;
          return window.__originalSetItem.call(this, key, value);
        };
      `);
      const assertUnchanged = async () => {
        assert.equal(await evaluate(`localStorage.getItem("lifeos-db:items")`), before.items);
        assert.equal(await evaluate(`localStorage.getItem("lifeos-db:annual-goals")`), before.annual);
        assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="w1"]').getAttribute("d")`), before.path);
        assert.equal(await evaluate(`document.querySelector("#temporaryLine").getAttribute("d")`), "");
        assert.equal(await evaluate(`document.querySelectorAll(".relation-card.is-valid-target").length`), 0);
      };
      try {
        await dragConnection(evaluate, mouse, "w1", "y1");
        await assertUnchanged();
        await dragConnection(evaluate, mouse, "w1", null);
        await assertUnchanged();
        await dragConnection(evaluate, mouse, "w2", "m2", {
          cancel: true,
          whileDragging: async () => {
            assert.equal(await evaluate(`document.querySelector('[data-item-id="w2"] [data-connect]').hasPointerCapture(1)`), true);
          }
        });
        await assertUnchanged();
        assert.equal(await evaluate(`JSON.parse(localStorage.getItem("lifeos-db:items")).items.find((item) => item.id === "w2").parent_id`), "");
        assert.equal(await evaluate(`window.__itemWrites`), 0, "cancelled gestures must not save");
      } finally {
        await evaluate(`Storage.prototype.setItem = window.__originalSetItem; delete window.__originalSetItem; delete window.__itemWrites;`);
      }
    }
  },
  {
    name: "relation month connection and disconnect handle valid and unavailable parents",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('[data-item-id="m2"] .relation-unavailable')`, "disconnect fixture");
      const beforeAnnual = await evaluate(`localStorage.getItem("lifeos-db:annual-goals")`);

      await clickSelector(evaluate, mouse, '[data-item-id="m2"] [data-disconnect]');
      await waitFor(evaluate, `JSON.parse(localStorage.getItem("lifeos-db:items")).items.find((item) => item.id === "m2").parent_id === ""`, "unavailable parent disconnect");
      assert.equal(await evaluate(`document.querySelector('[data-item-id="m2"] .relation-unavailable')`), null);
      assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="m2"]')`), null);

      await dragConnection(evaluate, mouse, "m2", "y1");
      await waitFor(evaluate, `JSON.parse(localStorage.getItem("lifeos-db:items")).items.find((item) => item.id === "m2").parent_id === "y1"`, "month to year save");
      await waitFor(evaluate, `document.querySelector('#relationSvg path[data-source="m2"][data-target="y1"]')`, "month to year path");
      await dragConnection(evaluate, mouse, "w2", "m2");
      await waitFor(evaluate, `document.querySelector('#relationSvg path[data-source="w2"][data-target="m2"]')`, "valid parent disconnect fixture");
      await clickSelector(evaluate, mouse, '[data-item-id="w2"] [data-disconnect]');
      await waitFor(evaluate, `JSON.parse(localStorage.getItem("lifeos-db:items")).items.find((item) => item.id === "w2").parent_id === ""`, "valid parent disconnect");
      await waitFor(evaluate, `!document.querySelector('#relationSvg path[data-source="w2"]')`, "valid parent path removal");
      assert.equal(await evaluate(`localStorage.getItem("lifeos-db:annual-goals")`), beforeAnnual, "connect and disconnect must save only items");

      await evaluate(`
        window.__originalSetItem = Storage.prototype.setItem;
        window.__itemWrites = 0;
        Storage.prototype.setItem = function (key, value) {
          if (key === "lifeos-db:items") window.__itemWrites += 1;
          return window.__originalSetItem.call(this, key, value);
        };
      `);
      try {
        await clickSelector(evaluate, mouse, '[data-item-id="w2"] [data-disconnect]');
        assert.equal(await evaluate(`window.__itemWrites`), 0, "disconnecting an empty parent must be a no-op");
      } finally {
        await evaluate(`Storage.prototype.setItem = window.__originalSetItem; delete window.__originalSetItem; delete window.__itemWrites;`);
      }
    }
  },
  {
    name: "relation connection save failure restores parent DOM path and storage",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('#relationSvg path[data-source="w1"][data-target="m1"]')`, "connection rollback fixture");
      const before = await evaluate(`(() => ({
        items: localStorage.getItem("lifeos-db:items"),
        annual: localStorage.getItem("lifeos-db:annual-goals"),
        path: document.querySelector('#relationSvg path[data-source="w1"]').getAttribute("d")
      }))()`);
      await evaluate(`
        window.__originalSetItem = Storage.prototype.setItem;
        window.__failItemWrite = true;
        Storage.prototype.setItem = function (key, value) {
          if (key === "lifeos-db:items" && window.__failItemWrite) {
            window.__failItemWrite = false;
            throw new Error("模拟连接保存失败");
          }
          return window.__originalSetItem.call(this, key, value);
        };
      `);
      try {
        await dragConnection(evaluate, mouse, "w1", "m2");
        await waitFor(evaluate, `document.querySelector('#relationNotice').textContent.includes("保存失败，已撤销")`, "connection rollback notice");
        await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        assert.equal(await evaluate(`localStorage.getItem("lifeos-db:items")`), before.items);
        assert.equal(await evaluate(`localStorage.getItem("lifeos-db:annual-goals")`), before.annual);
        assert.equal(await evaluate(`JSON.parse(localStorage.getItem("lifeos-db:items")).items.find((item) => item.id === "w1").parent_id`), "m1");
        assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="w1"]').dataset.target`), "m1");
        assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="w1"]').getAttribute("d")`), before.path);
        assert.equal(await evaluate(`document.querySelector("#temporaryLine").getAttribute("d")`), "");
        assert.equal(await evaluate(`document.querySelectorAll(".relation-card.is-valid-target").length`), 0);
        assert.equal(await evaluate(`window.__failItemWrite`), false);
        assert.match(await evaluate(`document.querySelector('#relationNotice').textContent`), /模拟连接保存失败/);
        assert.equal(await evaluate(`document.querySelector('[data-item-id="w1"] [data-connect]').disabled`), false);
      } finally {
        await evaluate(`Storage.prototype.setItem = window.__originalSetItem; delete window.__originalSetItem; delete window.__failItemWrite;`);
      }
    }
  },
  {
    name: "relation disconnect save failure restores parent DOM path and storage",
    async run({ openPage, evaluate, mouse, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('#relationSvg path[data-source="w1"][data-target="m1"]')`, "disconnect rollback fixture");
      const before = await evaluate(`(() => ({
        items: localStorage.getItem("lifeos-db:items"),
        annual: localStorage.getItem("lifeos-db:annual-goals"),
        path: document.querySelector('#relationSvg path[data-source="w1"]').getAttribute("d")
      }))()`);
      await evaluate(`
        window.__originalSetItem = Storage.prototype.setItem;
        window.__failItemWrite = true;
        Storage.prototype.setItem = function (key, value) {
          if (key === "lifeos-db:items" && window.__failItemWrite) {
            window.__failItemWrite = false;
            throw new Error("模拟断开保存失败");
          }
          return window.__originalSetItem.call(this, key, value);
        };
      `);
      try {
        await clickSelector(evaluate, mouse, '[data-item-id="w1"] [data-disconnect]');
        await waitFor(evaluate, `document.querySelector('#relationNotice').textContent.includes("保存失败，已撤销")`, "disconnect rollback notice");
        await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        assert.equal(await evaluate(`localStorage.getItem("lifeos-db:items")`), before.items);
        assert.equal(await evaluate(`localStorage.getItem("lifeos-db:annual-goals")`), before.annual);
        assert.equal(await evaluate(`JSON.parse(localStorage.getItem("lifeos-db:items")).items.find((item) => item.id === "w1").parent_id`), "m1");
        assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="w1"]').dataset.target`), "m1");
        assert.equal(await evaluate(`document.querySelector('#relationSvg path[data-source="w1"]').getAttribute("d")`), before.path);
        assert.equal(await evaluate(`window.__failItemWrite`), false);
        assert.match(await evaluate(`document.querySelector('#relationNotice').textContent`), /模拟断开保存失败/);
        assert.equal(await evaluate(`document.querySelector('[data-item-id="w1"] [data-disconnect]').disabled`), false);
      } finally {
        await evaluate(`Storage.prototype.setItem = window.__originalSetItem; delete window.__originalSetItem; delete window.__failItemWrite;`);
      }
    }
  },
  {
    name: "relation page renders an empty current-year column",
    async run({ openPage, evaluate, assert }) {
      await openPage("目标关系.html");
      await evaluate(relationFixture({ emptyYear: true }));
      await waitFor(evaluate, `document.querySelector('[data-item-id="w1"]') && document.querySelector('#yearCards .relation-empty')`, "empty relation year column");
      assert.equal(await evaluate(`document.querySelectorAll('#yearCards .relation-card').length`), 0);
      assert.match(await evaluate(`document.querySelector('#yearCards .relation-empty').textContent`), /暂无/);
    }
  },
  {
    name: "relation narrow viewport keeps one row and aligned paths after horizontal scrolling",
    async run({ openPage, evaluate, assert }) {
      await openPage("目标关系.html", 440, 843);
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelectorAll('#relationSvg path[data-source]').length === 2`, "narrow relation fixture");
      const layout = await evaluate(`(() => {
        const relationScroll = document.querySelector("#relationScroll");
        return {
          scrollWidth: relationScroll.scrollWidth,
          clientWidth: relationScroll.clientWidth,
          columnTops: Array.from(document.querySelectorAll(".relation-column"), (column) => Math.round(column.getBoundingClientRect().top))
        };
      })()`);
      assert.ok(layout.scrollWidth > layout.clientWidth, "440px viewport must retain horizontal overflow");
      assert.equal(new Set(layout.columnTops).size, 1, "week, month, and year columns must remain on the same row");
      await evaluate(`(async () => {
        const relationScroll = document.querySelector("#relationScroll");
        relationScroll.scrollLeft = relationScroll.scrollWidth;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      assert.ok(await evaluate(`document.querySelector("#relationScroll").scrollLeft > 0`), "the board must actually scroll horizontally");
      const endpoints = await evaluate(`(() => {
        const boardRect = document.querySelector("#relationBoard").getBoundingClientRect();
        return Array.from(document.querySelectorAll("#relationSvg path[data-source]"), (path) => {
          const values = path.getAttribute("d").match(/-?\\d+(?:\\.\\d+)?/g).map(Number);
          const source = document.querySelector('[data-item-id="' + path.dataset.source + '"]').getBoundingClientRect();
          const target = document.querySelector('[data-item-id="' + path.dataset.target + '"]').getBoundingClientRect();
          return {
            id: path.dataset.source,
            actual: { startX: values[0], startY: values[1], endX: values[6], endY: values[7] },
            expected: {
              startX: source.right - boardRect.left,
              startY: source.top + source.height / 2 - boardRect.top,
              endX: target.left - boardRect.left,
              endY: target.top + target.height / 2 - boardRect.top
            }
          };
        });
      })()`);
      for (const endpoint of endpoints) {
        for (const key of ["startX", "startY", "endX", "endY"]) {
          assert.ok(Math.abs(endpoint.actual[key] - endpoint.expected[key]) < 0.01, `${endpoint.id} ${key} must match its card side midpoint after scrolling`);
        }
      }
    }
  },
  {
    name: "relation save lifecycle guards unload disables controls and leaves no animation loop or console errors",
    async run({ openPage, addInitScript, evaluate, mouse, assert, getConsoleErrors }) {
      await addInitScript(`(() => {
        const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        const stats = window.__relationRafStats = { requested: 0, callbacks: 0 };
        window.requestAnimationFrame = (callback) => {
          stats.requested += 1;
          return nativeRequestAnimationFrame((timestamp) => {
            stats.callbacks += 1;
            callback(timestamp);
          });
        };
      })();`);
      await openPage("目标关系.html");
      await evaluate(relationFixture());
      await waitFor(evaluate, `document.querySelector('[data-item-id="w1"]') && document.querySelector('#relationSvg path[data-source="w1"]')`, "save lifecycle fixture");
      await delay(100);
      const rafBefore = await evaluate(`({ ...window.__relationRafStats })`);
      await delay(350);
      const rafAfter = await evaluate(`({ ...window.__relationRafStats })`);
      assert.deepEqual(rafAfter, rafBefore, "an idle relation page must not keep requesting animation frames");
      assert.equal(rafAfter.requested, rafAfter.callbacks, "all scheduled relation drawing must settle");

      await evaluate(`
        window.__originalSetItem = Storage.prototype.setItem;
        window.__saveLifecycle = null;
        Storage.prototype.setItem = function (key, value) {
          if (key === "lifeos-db:items" && !window.__saveLifecycle) {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            window.__saveLifecycle = {
              prevented: event.defaultPrevented,
              controlsDisabled: Array.from(document.querySelectorAll("[data-sort-handle], [data-connect], [data-disconnect]")).every((button) => button.disabled),
              scrollEnabled: !document.querySelector("#relationScroll").inert && !document.querySelector("#relationScroll").hasAttribute("disabled"),
              boardEnabled: !document.querySelector("#relationBoard").inert
            };
          }
          return window.__originalSetItem.call(this, key, value);
        };
      `);
      try {
        await dragCardBelow(evaluate, mouse, "w1", "w2");
        await waitFor(evaluate, `JSON.parse(localStorage.getItem("lifeos-db:items")).items.find((item) => item.id === "w1").sort_order === 2`, "lifecycle sort save");
        const duringSave = await evaluate(`window.__saveLifecycle`);
        assert.equal(duringSave.prevented, true, "beforeunload must be prevented while saving");
        assert.equal(duringSave.controlsDisabled, true, "sort, connect, and disconnect controls must be disabled while saving");
        assert.equal(duringSave.scrollEnabled, true, "horizontal scrolling must remain available while saving");
        assert.equal(duringSave.boardEnabled, true, "saving must not make the whole board inert");
        const afterSave = await evaluate(`(() => {
          const event = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(event);
          return {
            prevented: event.defaultPrevented,
            controlsEnabled: Array.from(document.querySelectorAll("[data-sort-handle], [data-connect], [data-disconnect]")).every((button) => !button.disabled)
          };
        })()`);
        assert.equal(afterSave.prevented, false, "beforeunload must not be prevented after saving finishes");
        assert.equal(afterSave.controlsEnabled, true, "all relation controls must be re-enabled after saving");
        assert.deepEqual(getConsoleErrors(), [], "the relation page must not emit console or unhandled runtime errors");
      } finally {
        await evaluate(`Storage.prototype.setItem = window.__originalSetItem; delete window.__originalSetItem; delete window.__saveLifecycle; delete window.__relationRafStats;`);
      }
    }
  },
  {
    name: "journal future path links to the relation page",
    async run({ openPage, evaluate, assert }) {
      await openPage("晨间日记页面.html");
      assert.ok(await evaluate(`document.querySelector('.path-label a[href="目标关系.html"]')`));
    }
  }
];

let failures = 0;
for (const test of tests) {
  try {
    await withChrome(test.run);
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${test.name}`);
    console.error(error.stack || error);
  }
}

if (failures) {
  console.error(`${failures} browser regression test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`${tests.length} browser regression tests passed.`);
}
