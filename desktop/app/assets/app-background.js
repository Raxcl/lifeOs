(() => {
  const PREFS_KEY = "lifeos-wallpaper-prefs";
  const DEFAULT_PREFS = {
    overlay: 16,
    fit: "cover"
  };

  function readPrefs() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      const overlay = Number(parsed.overlay);
      return {
        overlay: Number.isFinite(overlay) ? Math.min(100, Math.max(0, overlay)) : DEFAULT_PREFS.overlay,
        fit: ["cover", "contain"].includes(parsed.fit) ? parsed.fit : DEFAULT_PREFS.fit
      };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  function savePrefs(prefs) {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }

  function assetUrlCandidates(path) {
    const value = String(path || "");
    if (!value) return [];

    const candidates = [];
    const add = (url) => {
      if (url && !candidates.includes(url)) candidates.push(url);
    };

    const coreConverter = window.__TAURI__?.core?.convertFileSrc;
    if (coreConverter) {
      try {
        add(coreConverter(value));
      } catch {}
    }

    const internalConverter = window.__TAURI_INTERNALS__?.convertFileSrc;
    if (internalConverter) {
      try {
        add(internalConverter(value, "asset"));
      } catch {}
    }

    if (/^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\") || value.startsWith("/")) {
      add(`asset://localhost/${encodeURIComponent(value)}`);
      add(`asset://localhost/${encodeURI(value.replace(/\\/g, "/"))}`);
    }

    add(value);
    return candidates;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(url);
      image.onerror = () => reject(new Error(url));
      image.src = url;
    });
  }

  async function firstLoadableUrl(path) {
    const candidates = assetUrlCandidates(path);
    let lastError = null;
    for (const url of candidates) {
      try {
        return await loadImage(url);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("图片无法加载");
  }

  function randomIndex(length, previousIndex = -1) {
    if (length <= 1) return 0;
    let next = Math.floor(Math.random() * length);
    if (next === previousIndex) next = (next + 1) % length;
    return next;
  }

  function install(options = {}) {
    const invoke = options.invoke || window.__TAURI__?.core?.invoke;
    const layer = options.layer || document.getElementById("wallpaperLayer");
    const statusEl = options.statusEl || null;
    const overlayInput = options.overlayInput || null;
    const fitSelect = options.fitSelect || null;
    const prefs = readPrefs();
    const state = {
      images: [],
      index: -1,
      prefs
    };

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text || "";
      if (typeof options.onStatus === "function") options.onStatus(text || "");
    }

    function applyPrefs() {
      const overlay = Math.min(1, Math.max(0, Number(state.prefs.overlay) / 100));
      document.documentElement.style.setProperty("--wallpaper-wash", String(overlay));
      document.documentElement.style.setProperty("--wallpaper-wash-end", String(Math.min(1, overlay + 0.08)));
      document.documentElement.style.setProperty("--wallpaper-size", state.prefs.fit || DEFAULT_PREFS.fit);
    }

    function syncControls() {
      if (overlayInput) overlayInput.value = String(state.prefs.overlay);
      if (fitSelect) fitSelect.value = state.prefs.fit || DEFAULT_PREFS.fit;
      applyPrefs();
    }

    function clear() {
      state.images = [];
      state.index = -1;
      document.body.classList.remove("has-wallpaper");
      if (layer) layer.style.backgroundImage = "";
    }

    async function show(index) {
      if (!state.images.length || !layer) {
        clear();
        return false;
      }

      const safeIndex = ((index % state.images.length) + state.images.length) % state.images.length;
      const image = state.images[safeIndex];
      try {
        const url = await firstLoadableUrl(image.path);
        state.index = safeIndex;
        layer.style.backgroundImage = `url(${JSON.stringify(url)})`;
        document.body.classList.add("has-wallpaper");
        return true;
      } catch {
        setStatus(`背景图片加载失败：${image.name || image.path}`);
        return false;
      }
    }

    async function showRandom() {
      if (!state.images.length) return false;
      const firstIndex = randomIndex(state.images.length, state.index);
      if (await show(firstIndex)) return true;

      for (let offset = 1; offset < state.images.length; offset += 1) {
        if (await show(firstIndex + offset)) return true;
      }
      return false;
    }

    async function refresh(settings = null, showErrors = false) {
      applyPrefs();
      const wallpaperDir = settings?.wallpaper_dir || "";
      if (!wallpaperDir || !invoke) {
        clear();
        setStatus("选择一个图片文件夹后，晨间日记会在每次打开时随机使用一张背景。");
        return [];
      }

      try {
        const images = await invoke("list_wallpaper_images", {});
        state.images = Array.isArray(images) ? images : [];
        syncControls();
        if (!state.images.length) {
          clear();
          setStatus("这个文件夹里还没有找到 PNG、JPG、JPEG、WEBP、GIF 或 BMP 图片。");
          return [];
        }
        await showRandom();
        setStatus(`已找到 ${state.images.length} 张背景。本次打开已随机选择一张。`);
        return state.images;
      } catch (error) {
        clear();
        if (showErrors) setStatus(error?.message || String(error));
        return [];
      }
    }

    function updatePrefs() {
      state.prefs = {
        overlay: Number.isFinite(Number(overlayInput?.value)) ? Number(overlayInput.value) : state.prefs.overlay,
        fit: fitSelect?.value || state.prefs.fit || DEFAULT_PREFS.fit
      };
      savePrefs(state.prefs);
      syncControls();
    }

    overlayInput?.addEventListener("input", () => {
      state.prefs.overlay = Number.isFinite(Number(overlayInput.value)) ? Number(overlayInput.value) : DEFAULT_PREFS.overlay;
      savePrefs(state.prefs);
      applyPrefs();
    });
    overlayInput?.addEventListener("change", updatePrefs);
    fitSelect?.addEventListener("change", updatePrefs);

    syncControls();
    return {
      state,
      readPrefs,
      refresh,
      clear,
      showRandom,
      updatePrefs,
      setStatus
    };
  }

  window.LifeOSBackground = { install, readPrefs };
})();
