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
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
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
    return await run({ openPage, evaluate, mouse, assert });
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGTERM");
      const exited = await Promise.race([exitPromise.then(() => true), delay(5000).then(() => false)]);
      if (!exited) {
        chrome.kill("SIGKILL");
        await exitPromise;
      }
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
