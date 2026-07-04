(() => {
  const getWindow = () => {
    const tauriWindow = window.__TAURI__?.window;
    try {
      return tauriWindow?.getCurrentWindow?.() || tauriWindow?.appWindow || null;
    } catch {
      return null;
    }
  };

  const controls = {
    minimize: document.querySelector("[data-window-control='minimize']"),
    maximize: document.querySelector("[data-window-control='maximize']"),
    close: document.querySelector("[data-window-control='close']")
  };

  const runWindowAction = async (event, action) => {
    event.preventDefault();
    event.stopPropagation();

    const appWindow = getWindow();
    if (!appWindow) return;

    try {
      if (action === "maximize") {
        if (typeof appWindow.toggleMaximize === "function") {
          await appWindow.toggleMaximize();
          return;
        }
        if (typeof appWindow.isMaximized === "function" && typeof appWindow.unmaximize === "function") {
          if (await appWindow.isMaximized()) {
            await appWindow.unmaximize();
            return;
          }
        }
      }

      await appWindow[action]?.();
    } catch (error) {
      console.warn(`window ${action} failed`, error);
    }
  };

  controls.minimize?.addEventListener("click", (event) => runWindowAction(event, "minimize"));
  controls.maximize?.addEventListener("click", (event) => runWindowAction(event, "maximize"));
  controls.close?.addEventListener("click", (event) => runWindowAction(event, "close"));
})();
