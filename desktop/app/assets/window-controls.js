(() => {
  const tauriWindow = window.__TAURI__?.window;
  const getWindow = () => {
    try {
      return tauriWindow?.getCurrentWindow?.() || tauriWindow?.appWindow || null;
    } catch {
      return null;
    }
  };

  const appWindow = getWindow();
  const controls = {
    minimize: document.querySelector("[data-window-control='minimize']"),
    maximize: document.querySelector("[data-window-control='maximize']"),
    close: document.querySelector("[data-window-control='close']")
  };

  controls.minimize?.addEventListener("click", () => appWindow?.minimize?.());
  controls.maximize?.addEventListener("click", () => {
    if (typeof appWindow?.toggleMaximize === "function") {
      appWindow.toggleMaximize();
      return;
    }
    appWindow?.maximize?.();
  });
  controls.close?.addEventListener("click", () => appWindow?.close?.());
})();
