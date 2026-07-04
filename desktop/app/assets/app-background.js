(() => {
  const PREFS_KEY = "lifeos-wallpaper-prefs";
  const DEFAULT_PREFS = {
    overlay: 16,
    fit: "cover",
    mode: "random",
    selectedPath: "",
    selectedName: ""
  };

  function readPrefs() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      const overlay = Number(parsed.overlay);
      return {
        overlay: Number.isFinite(overlay) ? Math.min(100, Math.max(0, overlay)) : DEFAULT_PREFS.overlay,
        fit: ["cover", "contain"].includes(parsed.fit) ? parsed.fit : DEFAULT_PREFS.fit,
        mode: ["random", "fixed"].includes(parsed.mode) ? parsed.mode : DEFAULT_PREFS.mode,
        selectedPath: typeof parsed.selectedPath === "string" ? parsed.selectedPath : DEFAULT_PREFS.selectedPath,
        selectedName: typeof parsed.selectedName === "string" ? parsed.selectedName : DEFAULT_PREFS.selectedName
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

  function fileNameFromPath(path) {
    const value = String(path || "");
    return value.split(/[\\/]/).filter(Boolean).pop() || value;
  }

  function install(options = {}) {
    const invoke = options.invoke || window.__TAURI__?.core?.invoke;
    const layer = options.layer || document.getElementById("wallpaperLayer");
    const statusEl = options.statusEl || null;
    const overlayInput = options.overlayInput || null;
    const fitSelect = options.fitSelect || null;
    const modeSelect = options.modeSelect || null;
    const imageInput = options.imageInput || null;
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
      const alpha = (min, max) => String((min + (max - min) * overlay).toFixed(3));
      document.documentElement.style.setProperty("--wallpaper-wash", "0");
      document.documentElement.style.setProperty("--wallpaper-wash-end", "0");
      document.documentElement.style.setProperty("--content-mask", alpha(0.14, 0.76));
      document.documentElement.style.setProperty("--content-mask-soft", alpha(0.09, 0.58));
      document.documentElement.style.setProperty("--content-mask-strong", alpha(0.18, 0.84));
      document.documentElement.style.setProperty("--content-mask-panel-top", alpha(0.22, 0.82));
      document.documentElement.style.setProperty("--content-mask-panel-bottom", alpha(0.15, 0.74));
      document.documentElement.style.setProperty("--content-mask-input", alpha(0.12, 0.62));
      document.documentElement.style.setProperty("--content-mask-chip", alpha(0.22, 0.60));
      document.documentElement.style.setProperty("--content-mask-hero-start", alpha(0.58, 0.86));
      document.documentElement.style.setProperty("--content-mask-hero-mid", alpha(0.30, 0.66));
      document.documentElement.style.setProperty("--content-mask-hero-end", alpha(0.08, 0.26));
      document.documentElement.style.setProperty("--wallpaper-size", state.prefs.fit || DEFAULT_PREFS.fit);
      document.body?.classList.remove("wallpaper-covered");
    }

    function syncControls() {
      if (overlayInput) overlayInput.value = String(state.prefs.overlay);
      if (fitSelect) fitSelect.value = state.prefs.fit || DEFAULT_PREFS.fit;
      if (modeSelect) modeSelect.value = state.prefs.mode || DEFAULT_PREFS.mode;
      syncImageInput();
      applyPrefs();
    }

    function syncImageInput() {
      if (!imageInput) return;
      imageInput.value = state.prefs.selectedName || fileNameFromPath(state.prefs.selectedPath) || "";
      imageInput.title = state.prefs.selectedPath || "";
    }

    function clear() {
      state.images = [];
      state.index = -1;
      document.body.classList.remove("has-wallpaper");
      document.body.classList.remove("wallpaper-covered");
      if (layer) layer.style.backgroundImage = "";
      syncImageInput();
    }

    function reset() {
      state.prefs.mode = DEFAULT_PREFS.mode;
      state.prefs.selectedPath = "";
      state.prefs.selectedName = "";
      savePrefs(state.prefs);
      clear();
      syncControls();
    }

    async function showImage(image, index = -1) {
      if (!image?.path || !layer) {
        clear();
        return false;
      }

      try {
        const url = await firstLoadableUrl(image.path);
        state.index = index;
        layer.style.backgroundImage = `url(${JSON.stringify(url)})`;
        document.body.classList.add("has-wallpaper");
        syncImageInput();
        return true;
      } catch {
        setStatus(`背景图片加载失败：${image.name || image.path}`);
        return false;
      }
    }

    async function show(index) {
      if (!state.images.length) {
        clear();
        return false;
      }

      const safeIndex = ((index % state.images.length) + state.images.length) % state.images.length;
      return showImage(state.images[safeIndex], safeIndex);
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

    async function shuffle() {
      const shown = await showRandom();
      if (shown && state.prefs.mode === "fixed") {
        state.prefs.selectedPath = state.images[state.index]?.path || "";
        state.prefs.selectedName = state.images[state.index]?.name || fileNameFromPath(state.prefs.selectedPath);
        savePrefs(state.prefs);
        syncControls();
      }
      return shown;
    }

    async function showSelected(path = state.prefs.selectedPath) {
      if (!path) return false;
      const index = state.images.findIndex((image) => image.path === path);
      if (index >= 0) return show(index);
      return showImage({
        path,
        name: state.prefs.selectedName || fileNameFromPath(path)
      });
    }

    async function setFixedImage(image) {
      if (!image?.path) return false;
      state.prefs.mode = "fixed";
      state.prefs.selectedPath = image.path;
      state.prefs.selectedName = image.name || fileNameFromPath(image.path);
      savePrefs(state.prefs);
      syncControls();
      return showSelected(image.path);
    }

    async function refresh(settings = null, showErrors = false) {
      applyPrefs();
      const hasFixedImage = state.prefs.mode === "fixed" && state.prefs.selectedPath;
      const wallpaperDir = settings?.wallpaper_dir || "";
      if (!wallpaperDir || !invoke) {
        if (hasFixedImage && await showSelected()) {
          setStatus(`已固定使用：${state.prefs.selectedName || fileNameFromPath(state.prefs.selectedPath)}`);
        } else {
          clear();
          setStatus("选择一个图片文件夹后，晨间日记会在每次打开时随机使用一张背景。");
        }
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
        if (hasFixedImage && await showSelected()) {
          setStatus(`已固定使用：${state.prefs.selectedName || state.images[state.index]?.name || "指定壁纸"}`);
        } else {
          if (hasFixedImage) {
            state.prefs.mode = "random";
            state.prefs.selectedPath = "";
            state.prefs.selectedName = "";
            savePrefs(state.prefs);
          }
          await showRandom();
          setStatus(`已找到 ${state.images.length} 张背景。本次打开已随机选择一张。`);
        }
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
        fit: fitSelect?.value || state.prefs.fit || DEFAULT_PREFS.fit,
        mode: modeSelect?.value || state.prefs.mode || DEFAULT_PREFS.mode,
        selectedPath: state.prefs.selectedPath || "",
        selectedName: state.prefs.selectedName || ""
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
    modeSelect?.addEventListener("change", async () => {
      state.prefs.mode = modeSelect.value === "fixed" ? "fixed" : "random";
      if (state.prefs.mode === "fixed" && !state.prefs.selectedPath) {
        state.prefs.selectedPath = state.images[state.index]?.path || state.images[0]?.path || "";
        state.prefs.selectedName = state.images[state.index]?.name || state.images[0]?.name || fileNameFromPath(state.prefs.selectedPath);
      }
      savePrefs(state.prefs);
      syncControls();
      if (state.prefs.mode === "fixed") await showSelected();
    });

    syncControls();
    return {
      state,
      readPrefs,
      refresh,
      clear,
      reset,
      showRandom,
      shuffle,
      showSelected,
      setFixedImage,
      updatePrefs,
      setStatus
    };
  }

  window.LifeOSBackground = { install, readPrefs };
})();
