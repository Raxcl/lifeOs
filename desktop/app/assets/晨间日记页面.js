    (() => {
      const {
        formatDate,
        parseDateKey,
        normaliseDate,
        weekdayLabel,
        toErrorMessage,
        defaultHabitDefinitions: habitDefinitions
      } = window.LifeOSShared;
      const tauriInvoke = window.__TAURI__?.core?.invoke;
      const query = new URLSearchParams(window.location.search);
      const date = normaliseDate(query.get("date")) || formatDate(new Date());
      const dataSaveFields = () => Array.from(document.querySelectorAll("[data-save]"));
      const fields = dataSaveFields();
      const moodButtons = Array.from(document.querySelectorAll(".mood-btn"));
      const weatherButtons = Array.from(document.querySelectorAll("[data-weather]"));
      const bodyTagGrid = document.getElementById("bodyTagGrid");
      const bodyTagsEdit = document.getElementById("bodyTagsEdit");
      const bodyTagEditor = document.getElementById("bodyTagEditor");
      const bodyTagEditorInput = document.getElementById("bodyTagEditorInput");
      const bodyTagSave = document.getElementById("bodyTagSave");
      const bodyTagCancel = document.getElementById("bodyTagCancel");
      const bodyTagSummary = document.getElementById("bodyTagSummary");
      const moodIconEdit = document.getElementById("moodIconEdit");
      const moodIconEditor = document.getElementById("moodIconEditor");
      const MOOD_ICONS_KEY = "lifeos-mood-icons";
      const bodyTagButtonEls = () => Array.from(bodyTagGrid?.querySelectorAll("[data-body-tag]") || []);
      const BODY_TAGS_KEY = "lifeos-body-tags";
      const DEFAULT_BODY_TAGS = ["肩颈紧", "腰疼", "眼睛酸", "状态不错", "没什么问题"];
      const identityTitleEl = document.getElementById("identityTitleText");
      const freeNotesPanel = document.getElementById("freeNotesPanel");
      const brainDump = document.getElementById("brainDump");
      const IDENTITY_TITLE_KEY = "lifeos-identity-card-title";
      const DEFAULT_IDENTITY_TITLE = "今日的剧本关键词是？";
      const LEGACY_IDENTITY_TITLE = "我想成为怎样的人";
      const todoList = document.getElementById("todoList");
      const todoInput = document.getElementById("todoInput");
      const addTodo = document.getElementById("addTodo");
      const annualGoalList = document.getElementById("annualGoalList");
      const addAnnualGoal = document.getElementById("addAnnualGoal");
      const ANNUAL_GOAL_PLACEHOLDERS = ["一年后希望自己更像谁", "今年最想拿到的一个证据"];
      const frogDebtList = document.getElementById("frogDebtList");
      const habitCheckList = document.getElementById("habitCheckList");
      const status = document.getElementById("saveStatus");
      const backButton = document.getElementById("backToCalendar");
      const messageCount = document.getElementById("messageCount");
      const todoCount = document.getElementById("todoCount");
      const frogDebtCount = document.getElementById("frogDebtCount");
      const hitokotoText = document.getElementById("hitokotoText");
      const hitokotoRefresh = document.getElementById("hitokotoRefresh");
      const HITOKOTO_FALLBACKS = [
        "把今天过好，就是对未来最好的负责。",
        "慢慢来，比较快。",
        "种一棵树最好的时间是十年前，其次是现在。",
        "你只管努力，剩下的交给时间。",
        "保持热爱，奔赴山海。"
      ];
      const wallpaperDirInput = document.getElementById("wallpaperDirInput");
      const chooseWallpaperDirButton = document.getElementById("chooseWallpaperDir");
      const resetWallpaperDirButton = document.getElementById("resetWallpaperDir");
      const wallpaperOverlayInput = document.getElementById("wallpaperOverlayInput");
      const wallpaperFitSelect = document.getElementById("wallpaperFitSelect");
      const wallpaperStatus = document.getElementById("wallpaperStatus");
      const wallpaperSettingsToggle = document.getElementById("wallpaperSettingsToggle");
      const wallpaperSettingsPanel = document.getElementById("wallpaperSettingsPanel");
      const wallpaperModeSelect = document.getElementById("wallpaperModeSelect");
      const wallpaperImageInput = document.getElementById("wallpaperImageInput");
      const chooseWallpaperImageButton = document.getElementById("chooseWallpaperImage");
      const shuffleWallpaperButton = document.getElementById("shuffleWallpaper");

      const state = {
        file: null,
        databases: null,
        form: defaultForm(date),
        timer: null,
        saveToken: 0,
        lastSavedContent: "",
        background: null
      };

      state.background = window.LifeOSBackground?.install({
        invoke,
        layer: document.getElementById("wallpaperLayer"),
        statusEl: wallpaperStatus,
        overlayInput: wallpaperOverlayInput,
        fitSelect: wallpaperFitSelect,
        modeSelect: wallpaperModeSelect,
        imageInput: wallpaperImageInput,
        onStatus: (message) => {
          if (message) setStatus(message);
        }
      });

      wallpaperSettingsToggle?.addEventListener("click", () => {
        setWallpaperPanelOpen(wallpaperSettingsPanel?.hidden !== false);
      });
      chooseWallpaperDirButton?.addEventListener("click", chooseWallpaperDir);
      resetWallpaperDirButton?.addEventListener("click", resetWallpaperDir);
      chooseWallpaperImageButton?.addEventListener("click", chooseWallpaperImage);
      shuffleWallpaperButton?.addEventListener("click", async () => {
        if (!state.background?.state?.images?.length && wallpaperDirInput?.value) {
          const settings = await invoke("get_vault_settings", {}).catch(() => null);
          if (settings) {
            updateWallpaperFields(settings);
            await state.background?.refresh(settings, true);
          }
        }
        if (state.background?.state?.prefs?.mode === "fixed" && !state.background?.state?.images?.length) {
          await chooseWallpaperImage();
          return;
        }
        if (!state.background?.state?.images?.length) {
          setStatus("先选择一个包含图片的背景目录。");
          return;
        }
        const changed = await state.background.shuffle();
        setStatus(changed ? "已换一张背景。" : "暂时没有可用的背景图片。");
      });
      document.addEventListener("click", (event) => {
        if (wallpaperSettingsPanel?.hidden) return;
        const target = event.target;
        if (wallpaperSettingsPanel?.contains(target) || wallpaperSettingsToggle?.contains(target)) return;
        setWallpaperPanelOpen(false);
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") setWallpaperPanelOpen(false);
      });

      backButton?.addEventListener("click", async () => {
        window.clearTimeout(state.timer);
        setStatus("正在返回日历…");
        await saveNow(true);
        window.location.replace(new URL("index.html", window.location.href).href);
      });

      function setWallpaperPanelOpen(open) {
        if (!wallpaperSettingsPanel || !wallpaperSettingsToggle) return;
        wallpaperSettingsPanel.hidden = !open;
        wallpaperSettingsToggle.setAttribute("aria-expanded", String(open));
      }

      fields.forEach((field) => {
        field.addEventListener("input", () => {
          updateDerivedLabels();
          if (field.dataset.save === "health-signal") renderBodyTagSummary();
          scheduleSave();
        });
        field.addEventListener("change", scheduleSave);
      });

      // 让多行文本域随内容自动增高（替代固定高度 + 内部滚动条）。
      const autoGrowTextareas = Array.from(document.querySelectorAll("textarea.textarea, textarea.write-line"));
      function autoSizeTextarea(el) {
        if (!el) return;
        el.style.height = "auto";
        const next = el.scrollHeight;
        if (next > 0) el.style.height = `${next}px`;
      }
      function autoSizeAll() {
        autoGrowTextareas.forEach(autoSizeTextarea);
      }
      autoGrowTextareas.forEach((el) => {
        el.addEventListener("input", () => autoSizeTextarea(el));
      });
      window.addEventListener("resize", autoSizeAll);

      moodButtons.forEach((button) => {
        button.addEventListener("click", () => {
          setMood(button.dataset.mood);
          scheduleSave("状态已更新，正在保存…");
        });
      });

      applyMoodIcons();

      moodIconEdit?.addEventListener("click", () => {
        if (!moodIconEditor) return;
        const opening = moodIconEditor.hidden;
        moodIconEditor.hidden = !opening;
        moodIconEdit.textContent = opening ? "完成" : "自定义图标";
        if (opening) renderMoodIconEditor();
      });

      weatherButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const next = button.classList.contains("is-active") ? "" : button.dataset.weather;
          setWeather(next);
          scheduleSave("天气已更新，正在保存…");
        });
      });

      bodyTagGrid?.addEventListener("click", (event) => {
        const button = event.target.closest("[data-body-tag]");
        if (!button) return;
        button.classList.toggle("is-active");
        renderBodyTagSummary();
        scheduleSave("身体信号已更新，正在保存…");
      });

      bodyTagsEdit?.addEventListener("click", () => {
        if (!bodyTagEditor) return;
        const opening = bodyTagEditor.hidden;
        bodyTagEditor.hidden = !opening;
        bodyTagsEdit.textContent = opening ? "完成" : "管理标签";
        if (opening) {
          if (bodyTagEditorInput) bodyTagEditorInput.value = storedBodyTags().join("\n");
          bodyTagEditorInput?.focus();
          autoSizeTextarea(bodyTagEditorInput);
        } else {
          renderBodyTagSummary();
        }
      });

      bodyTagCancel?.addEventListener("click", () => {
        if (bodyTagEditor) bodyTagEditor.hidden = true;
        if (bodyTagsEdit) bodyTagsEdit.textContent = "管理标签";
        renderBodyTagSummary();
      });

      bodyTagSave?.addEventListener("click", () => {
        const tags = parseBodyTagsInput(bodyTagEditorInput?.value || "");
        localStorage.setItem(BODY_TAGS_KEY, JSON.stringify(tags));
        const stillActive = activeBodyTags().filter((tag) => tags.includes(tag));
        renderBodyTags(tags);
        applyBodyTags(stillActive);
        if (bodyTagEditor) bodyTagEditor.hidden = true;
        if (bodyTagsEdit) bodyTagsEdit.textContent = "管理标签";
        renderBodyTagSummary();
        scheduleSave("身体标签已更新，正在保存…");
      });

      identityTitleEl?.addEventListener("input", () => {
        const value = identityTitleEl.textContent.trim();
        if (value) localStorage.setItem(IDENTITY_TITLE_KEY, value);
        scheduleSave("标题已更新，正在保存…");
      });

      identityTitleEl?.addEventListener("blur", () => {
        if (!identityTitleEl.textContent.trim()) {
          identityTitleEl.textContent = storedIdentityTitle();
        }
      });

      identityTitleEl?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          identityTitleEl.blur();
        }
      });

      document.querySelectorAll(".collapsible .panel-title").forEach((title) => {
        title.addEventListener("click", (event) => {
          if (event.target.closest("input, button, textarea, a")) return;
          title.closest(".collapsible")?.classList.toggle("is-collapsed");
        });
      });

      brainDump?.addEventListener("paste", (event) => {
        const files = Array.from(event.clipboardData?.items || [])
          .filter((item) => item.kind === "file" && String(item.type).startsWith("image/"))
          .map((item) => item.getAsFile())
          .filter(Boolean);
        if (!files.length) return;
        event.preventDefault();
        files.forEach((file) => ingestImageFile(file));
      });

      if (freeNotesPanel) {
        ["dragenter", "dragover"].forEach((type) => {
          freeNotesPanel.addEventListener(type, (event) => {
            if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
            event.preventDefault();
            freeNotesPanel.classList.add("is-drop-active");
          });
        });
        ["dragleave", "dragend"].forEach((type) => {
          freeNotesPanel.addEventListener(type, (event) => {
            if (type === "dragleave" && event.relatedTarget && freeNotesPanel.contains(event.relatedTarget)) return;
            freeNotesPanel.classList.remove("is-drop-active");
          });
        });
        freeNotesPanel.addEventListener("drop", (event) => {
          freeNotesPanel.classList.remove("is-drop-active");
          const files = Array.from(event.dataTransfer?.files || []).filter((file) => String(file.type).startsWith("image/"));
          if (!files.length) return;
          event.preventDefault();
          files.forEach((file) => ingestImageFile(file));
        });
      }

      hitokotoRefresh?.addEventListener("click", () => loadHitokoto());
      loadHitokoto();

      addTodo?.addEventListener("click", (event) => {
        event.preventDefault();
        if (!addMonthlyItem(todoInput?.value || "")) return;
        todoInput.value = "";
        todoInput.focus();
        scheduleSave("本月事项已更新，正在保存…");
      });

      addAnnualGoal?.addEventListener("click", (event) => {
        event.preventDefault();
        addAnnualGoalRow(true);
        scheduleSave("年度目标已更新，正在保存…");
      });

      todoInput?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addTodo?.click();
        }
      });

      todoList?.addEventListener("change", () => {
        updateTodoCount();
        scheduleSave("本月事项已更新，正在保存…");
      });

      frogDebtList?.addEventListener("change", () => {
        updateFrogDebtCount();
        updateMetrics();
        scheduleSave("未完成青蛙已更新，正在保存…");
      });

      habitCheckList?.addEventListener("change", () => {
        updateMetrics();
        scheduleSave("习惯勾选已更新，正在保存…");
      });

      todoList?.addEventListener("click", (event) => {
        if (event.target.closest(".delete-todo")) {
          window.setTimeout(() => {
            updateTodoCount();
            scheduleSave("本月事项已删除，正在保存…");
          }, 0);
        }
      });

      boot();

      async function boot() {
        try {
          setStatus("正在打开当天 Markdown…");
          const file = await invoke("open_or_create_journal", { date });
          state.file = file;
          state.form = parseMarkdown(file.content, file.date);
          state.form.date = file.date;
          state.form.dayIndex = String(file.day_index || state.form.dayIndex || 1);
          state.databases = await invoke("get_journal_databases", { date: file.date });
          mergeDatabasesToForm(state.databases);
          applyFormToPage();
          state.lastSavedContent = buildMarkdown(state.form);
          updateMasthead();
          setStatus(file.path ? `已连接：${file.path}` : "已连接当天 Markdown");
          const settings = await invoke("get_vault_settings", {}).catch(() => null);
          if (settings) {
            updateWallpaperFields(settings);
            await state.background?.refresh(settings, false);
          }
          await saveNow(true);
        } catch (error) {
          setFormDisabled(true);
          setStatus(`连接失败，当前内容无法保存：${toErrorMessage(error)}`);
        }
      }

      function updateWallpaperFields(settings) {
        if (wallpaperDirInput) {
          wallpaperDirInput.value = settings?.configured_wallpaper_dir || settings?.wallpaper_dir || "";
        }
      }

      async function chooseWallpaperDir() {
        setStatus("打开背景文件夹选择器…");
        try {
          const path = await invoke("pick_wallpaper_dir", {});
          if (!path) {
            setStatus("未更改背景文件夹。");
            return;
          }
          const settings = await invoke("set_wallpaper_dir", { path });
          updateWallpaperFields(settings);
          await state.background?.refresh(settings, true);
          setWallpaperPanelOpen(false);
          setStatus("已保存背景文件夹，本次已随机选择一张。");
        } catch (error) {
          setStatus(toErrorMessage(error));
        }
      }

      async function chooseWallpaperImage() {
        setStatus("打开背景图片选择器…");
        try {
          const image = await invoke("pick_wallpaper_image", {});
          if (!image?.path) {
            setStatus("未更改指定壁纸。");
            return;
          }
          const changed = await state.background?.setFixedImage(image);
          setStatus(changed ? `已固定使用：${image.name || "指定壁纸"}` : "这张图片暂时无法作为背景加载。");
        } catch (error) {
          setStatus(toErrorMessage(error));
        }
      }

      async function resetWallpaperDir() {
        setStatus("正在关闭背景…");
        try {
          const settings = await invoke("reset_wallpaper_dir", {});
          updateWallpaperFields(settings);
          state.background?.reset();
          state.background?.setStatus("选择一个图片文件夹后，晨间日记会在每次打开时随机使用一张背景。");
          setWallpaperPanelOpen(false);
          setStatus("已关闭晨间日记背景。");
        } catch (error) {
          setStatus(toErrorMessage(error));
        }
      }

      function setFormDisabled(disabled) {
        dataSaveFields().forEach((field) => { field.disabled = disabled; });
        const annualInputs = annualGoalList ? Array.from(annualGoalList.querySelectorAll("input")) : [];
        [...moodButtons, addTodo, todoInput, addAnnualGoal, ...annualInputs].forEach((node) => {
          if (node) node.disabled = disabled;
        });
      }

      async function invoke(command, args) {
        if (tauriInvoke) return tauriInvoke(command, args);
        return fallbackInvoke(command, args);
      }

      async function fallbackInvoke(command, args) {
        const prefix = "lifeos-journal:";
        const valueDate = args?.date || date;
        const key = prefix + valueDate;
        const path = fallbackPath(valueDate);
        const wallpaperDirKey = "lifeos-settings:wallpaper-dir";
        if (command === "open_or_create_journal") {
          const created = localStorage.getItem(key) === null;
          if (created) localStorage.setItem(key, buildMarkdown(defaultForm(args.date, "1")));
          return {
            date: args.date,
            path,
            content: localStorage.getItem(key) || "",
            day_index: Number(extractFrontmatter(localStorage.getItem(key) || "").day_index || 1),
            created
          };
        }
        if (command === "save_journal") {
          localStorage.setItem(key, args.content);
          return {
            date: args.date,
            path,
            content: args.content,
            day_index: Number(extractFrontmatter(args.content).day_index || 1),
            created: false
          };
        }
        if (command === "get_journal_databases") {
          return getFallbackDatabases(args.date);
        }
        if (command === "get_vault_settings") {
          const wallpaperDir = localStorage.getItem(wallpaperDirKey);
          return {
            wallpaper_dir: wallpaperDir,
            configured_wallpaper_dir: wallpaperDir
          };
        }
        if (command === "pick_wallpaper_dir") {
          const selected = window.prompt("请输入背景图片文件夹完整路径：", localStorage.getItem(wallpaperDirKey) || "");
          return selected ? selected.trim() : null;
        }
        if (command === "pick_wallpaper_image") {
          const selected = window.prompt("请输入背景图片完整路径：", "");
          if (!selected) return null;
          const path = selected.trim();
          return {
            path,
            name: path.split(/[\\/]/).filter(Boolean).pop() || path
          };
        }
        if (command === "set_wallpaper_dir") {
          localStorage.setItem(wallpaperDirKey, args.path);
          return fallbackInvoke("get_vault_settings", {});
        }
        if (command === "reset_wallpaper_dir") {
          localStorage.removeItem(wallpaperDirKey);
          return fallbackInvoke("get_vault_settings", {});
        }
        if (command === "list_wallpaper_images") {
          return [];
        }
        if (command === "save_journal_databases") {
          return saveFallbackDatabases(
            args.date,
            args.frogs || [],
            args.habits || {},
            args.monthly || [],
            args.frogBacklog || [],
            args.monthlyBacklog || [],
            args.annualGoals || []
          );
        }
        throw new Error(`未知命令：${command}`);
      }

      function getFallbackDatabases(valueDate) {
        const frogsDb = readFallbackDatabase("lifeos-db:frogs", { schema_version: 1, days: [] });
        const habitsDb = readFallbackDatabase("lifeos-db:habits", {
          schema_version: 1,
          definitions: habitDefinitions(),
          days: []
        });
        habitsDb.definitions = normaliseHabitDefinitions(habitsDb.definitions);
        const monthlyDb = readFallbackDatabase("lifeos-db:monthly-important", { schema_version: 1, months: [] });
        const annualGoalsDb = readFallbackDatabase("lifeos-db:annual-goals", { schema_version: 1, years: [] });
        const month = valueDate.slice(0, 7);
        const year = valueDate.slice(0, 4);
        return {
          frogs: frogsDb.days.find((day) => day.date === valueDate) || { date: valueDate, items: [], updated_at: null },
          frog_backlog: collectFrogBacklog(frogsDb.days),
          habits: habitsDb.days.find((day) => day.date === valueDate) || { date: valueDate, checks: {}, updated_at: null },
          habit_definitions: habitsDb.definitions,
          monthly: monthlyDb.months.find((record) => record.month === month) || { month, items: [], updated_at: null },
          monthly_backlog: collectMonthlyBacklog(monthlyDb.months),
          annual_goals: annualGoalsDb.years.find((record) => record.year === year) || { year, items: [], updated_at: null },
          paths: {
            frogs: "本机预览 / LifeOS-Vault / 00-Databases / frogs.csv",
            habits: "本机预览 / LifeOS-Vault / 00-Databases / habits.csv",
            monthly: "本机预览 / LifeOS-Vault / 00-Databases / monthly-important.csv",
            annual_goals: "本机预览 / LifeOS-Vault / 00-Databases / annual-goals.csv"
          }
        };
      }

      function saveFallbackDatabases(valueDate, frogs, habits, monthly, frogBacklog, monthlyBacklog, annualGoals) {
        const now = Math.floor(Date.now() / 1000);
        const month = valueDate.slice(0, 7);
        const year = valueDate.slice(0, 4);
        const frogsDb = readFallbackDatabase("lifeos-db:frogs", { schema_version: 1, days: [] });
        const habitsDb = readFallbackDatabase("lifeos-db:habits", {
          schema_version: 1,
          definitions: habitDefinitions(),
          days: []
        });
        habitsDb.definitions = normaliseHabitDefinitions(habitsDb.definitions);
        const monthlyDb = readFallbackDatabase("lifeos-db:monthly-important", { schema_version: 1, months: [] });
        const annualGoalsDb = readFallbackDatabase("lifeos-db:annual-goals", { schema_version: 1, years: [] });

        const frogDay = {
          date: valueDate,
          items: normaliseFrogsForDatabase(frogs),
          updated_at: now
        };
        frogsDb.days = [...frogsDb.days.filter((day) => day.date !== valueDate), frogDay].sort((a, b) => a.date.localeCompare(b.date));
        applyFrogBacklog(frogsDb, frogBacklog, now);
        localStorage.setItem("lifeos-db:frogs", JSON.stringify(frogsDb));

        const habitDay = {
          date: valueDate,
          checks: habits,
          updated_at: now
        };
        habitsDb.definitions = normaliseHabitDefinitions(habitsDb.definitions);
        habitsDb.days = [...habitsDb.days.filter((day) => day.date !== valueDate), habitDay].sort((a, b) => a.date.localeCompare(b.date));
        localStorage.setItem("lifeos-db:habits", JSON.stringify(habitsDb));

        const monthlyRecord = {
          month,
          items: normaliseMonthlyForDatabase(monthly, month, now),
          updated_at: now
        };
        monthlyDb.months = [...monthlyDb.months.filter((record) => record.month !== month), monthlyRecord].sort((a, b) => a.month.localeCompare(b.month));
        applyMonthlyBacklog(monthlyDb, monthlyBacklog, now);
        localStorage.setItem("lifeos-db:monthly-important", JSON.stringify(monthlyDb));

        const goalItems = (annualGoals || []).map((item, index) => ({
          id: item.id || createClientId("year"),
          text: String(item.text || "").trim(),
          done: Boolean(item.done),
          created_at: item.created_at || now,
          updated_at: now
        })).filter((item) => item.text);
        let annualRecord = annualGoalsDb.years.find((record) => record.year === year);
        if (!annualRecord) {
          annualRecord = { year, items: [], updated_at: now };
          annualGoalsDb.years.push(annualRecord);
        }
        annualRecord.items = goalItems;
        annualRecord.updated_at = now;
        annualGoalsDb.years = annualGoalsDb.years.filter((record) => record.items.length);
        annualGoalsDb.years.sort((a, b) => a.year.localeCompare(b.year));
        localStorage.setItem("lifeos-db:annual-goals", JSON.stringify(annualGoalsDb));

        return getFallbackDatabases(valueDate);
      }

      function collectFrogBacklog(days) {
        return (days || []).flatMap((day) => (day.items || []).map((item) => ({
          date: day.date,
          slot: Number(item.slot),
          text: String(item.text || "").trim(),
          done: Boolean(item.done),
          updated_at: day.updated_at || null
        }))).filter((item) => item.date && item.text && !item.done)
          .sort((left, right) => left.date.localeCompare(right.date) || left.slot - right.slot);
      }

      function applyFrogBacklog(database, backlog, now) {
        (backlog || []).forEach((item) => {
          const dateKey = normaliseDate(item.date);
          const slot = Number(item.slot);
          const text = String(item.text || "").trim();
          if (!dateKey || slot < 1 || slot > 3 || !text) return;
          let day = database.days.find((record) => record.date === dateKey);
          if (!day) {
            day = { date: dateKey, items: normaliseFrogsForDatabase([]), updated_at: now };
            database.days.push(day);
          }
          const frog = day.items.find((record) => Number(record.slot) === slot);
          if (frog) {
            const changed = frog.text !== text || Boolean(frog.done) !== Boolean(item.done);
            frog.text = text;
            frog.done = Boolean(item.done);
            if (changed) {
              day.updated_at = now;
            }
          } else {
            day.updated_at = now;
          }
        });
        database.days.sort((left, right) => left.date.localeCompare(right.date));
      }

      function collectMonthlyBacklog(months) {
        return (months || []).flatMap((record) => (record.items || []).map((item) => ({
          month: record.month,
          id: item.id || createClientId("month"),
          text: String(item.text || "").trim(),
          done: Boolean(item.done),
          created_at: item.created_at || null,
          updated_at: item.updated_at || record.updated_at || null
        }))).filter((item) => item.month && item.text && !item.done)
          .sort((left, right) => left.month.localeCompare(right.month) || left.text.localeCompare(right.text));
      }

      function applyMonthlyBacklog(database, backlog, now) {
        (backlog || []).forEach((item) => {
          const month = /^\d{4}-\d{2}$/.test(String(item.month || "")) ? item.month : "";
          const text = String(item.text || "").trim();
          if (!month || !text) return;
          let record = database.months.find((entry) => entry.month === month);
          if (!record) {
            record = { month, items: [], updated_at: now };
            database.months.push(record);
          }
          const id = item.id || createClientId("month");
          let existing = record.items.find((entry) => entry.id === id);
          if (!existing) {
            existing = { id, text, done: false, created_at: item.created_at || now, updated_at: now };
            record.items.push(existing);
            record.updated_at = now;
          }
          const changed = existing.text !== text || Boolean(existing.done) !== Boolean(item.done);
          existing.text = text;
          existing.done = Boolean(item.done);
          if (changed) {
            existing.updated_at = now;
            record.updated_at = now;
          }
        });
        database.months.sort((left, right) => left.month.localeCompare(right.month));
      }

      function readFallbackDatabase(key, fallback) {
        try {
          return JSON.parse(localStorage.getItem(key) || "") || fallback;
        } catch {
          return fallback;
        }
      }

      function fallbackPath(value) {
        const [year, month] = value.split("-");
        return `本机预览 / LifeOS-Vault / 01-Daily / ${year} / ${month} / ${value}.md`;
      }

      function scheduleSave(label = "正在保存到当天 Markdown…") {
        if (!state.file) return;
        setStatus(label);
        window.clearTimeout(state.timer);
        state.timer = window.setTimeout(() => saveNow(false), 700);
      }

      async function saveNow(force) {
        if (!state.file) return;
        readPageToForm();
        const content = buildMarkdown(state.form);
        const payload = databasePayloadFromForm(state.form);
        console.log("[DEBUG saveNow] annual_goals:", JSON.stringify(payload.annual_goals), "form.annualGoals:", JSON.stringify(state.form.annualGoals));
        if (!force && content === state.lastSavedContent) {
          try {
            const databases = await invoke("save_journal_databases", {
              date: state.form.date,
              ...payload
            });
            state.databases = databases;
            console.log("[DEBUG saveNow] DB sync OK, annual_goals from server:", JSON.stringify(databases?.annual_goals));
            setStatus("已同步数据库");
          } catch (error) {
            console.error("[DEBUG saveNow] DB sync FAILED:", error);
            setStatus(`数据库同步失败：${toErrorMessage(error)}`);
          }
          return;
        }

        const token = state.saveToken + 1;
        state.saveToken = token;
        window.clearTimeout(state.timer);
        setStatus("保存中…");

        try {
          const file = await invoke("save_journal", { date: state.form.date, content });
          const databases = await invoke("save_journal_databases", {
            date: state.form.date,
            ...payload
          });
          if (token !== state.saveToken) return;
          state.file = file;
          state.databases = databases;
          state.form.dayIndex = String(file.day_index || state.form.dayIndex || 1);
          state.lastSavedContent = buildMarkdown(state.form);
          updateMasthead();
          console.log("[DEBUG saveNow] Full save OK, annual_goals from server:", JSON.stringify(databases?.annual_goals));
          setStatus(file.path ? `已保存 Markdown，并同步数据库：${file.path}` : "已保存 Markdown，并同步数据库");
        } catch (error) {
          if (token !== state.saveToken) return;
          console.error("[DEBUG saveNow] Full save FAILED:", error);
          setStatus(`保存失败：${toErrorMessage(error)}`);
        }
      }

      function mergeDatabasesToForm(databases) {
        state.form.habitDefinitions = normaliseHabitDefinitions(databases?.habit_definitions);
        applyHabitMarkdownFallback(state.form, state.form.habitDefinitions);

        const frogs = databases?.frogs;
        if (frogs) {
          [1, 2, 3].forEach((slot) => { state.form[`frog-${slot}`] = ""; });
          (frogs.items || []).forEach((item) => {
            if (item.slot >= 1 && item.slot <= 3) {
              state.form[`frog-${item.slot}`] = item.text || "";
            }
          });
        }

        const habits = databases?.habits;
        if (habits) {
          activeHabitDefinitions().forEach((definition) => {
            state.form[definition.id] = Boolean((habits.checks || {})[definition.id]);
          });
        }

        const monthly = databases?.monthly;
        state.form.frogDebt = (databases?.frog_backlog || []).map((item) => ({
          date: item.date || "",
          slot: Number(item.slot || 0),
          text: item.text || "",
          done: Boolean(item.done),
          updated_at: item.updated_at || null
        })).filter((item) => item.date && item.slot && item.text);

        if (Array.isArray(databases?.monthly_backlog)) {
          state.form.todos = databases.monthly_backlog.map((item) => ({
            month: item.month || state.form.date.slice(0, 7),
            id: item.id || createClientId("month"),
            text: item.text || "",
            done: Boolean(item.done),
            created_at: item.created_at || null,
            updated_at: item.updated_at || null
          })).filter((item) => item.text);
        } else if (monthly) {
          state.form.todos = (monthly.items || []).filter((item) => !item.done).map((item) => ({
            month: monthly.month || state.form.date.slice(0, 7),
            id: item.id || createClientId("month"),
            text: item.text || "",
            done: Boolean(item.done),
            created_at: item.created_at || null,
            updated_at: item.updated_at || null
          })).filter((item) => item.text);
        }

        const annualGoals = databases?.annual_goals;
        console.log("[DEBUG mergeDatabasesToForm] annual_goals:", JSON.stringify(annualGoals));
        if (annualGoals) {
          state.form.annualGoals = (annualGoals.items || []).map((item) => item.text || "").filter(Boolean);
        }
      }

      function databasePayloadFromForm(form) {
        return {
          frogs: collectFrogsForDatabase(form),
          habits: collectHabitsForDatabase(form),
          monthly: collectCurrentMonthlyForDatabase(form),
          frogBacklog: collectFrogBacklogForDatabase(form),
          monthlyBacklog: collectMonthlyBacklogForDatabase(form),
          annualGoals: collectAnnualGoalsForDatabase(form)
        };
      }

      function collectFrogsForDatabase(form) {
        return [1, 2, 3].map((slot) => {
          const text = String(form[`frog-${slot}`] || "");
          const previous = (state.databases?.frogs?.items || []).find((item) => Number(item.slot) === slot);
          const previousText = String(previous?.text || "");
          return {
            slot,
            text,
            done: previousText.trim() === text.trim() ? Boolean(previous?.done) : false
          };
        });
      }

      function collectHabitsForDatabase(form) {
        return Object.fromEntries(
          activeHabitDefinitions(form).map((definition) => [definition.id, Boolean(form[definition.id])])
        );
      }

      function collectFrogBacklogForDatabase(form) {
        return (form.frogDebt || []).map((item) => ({
          date: item.date || "",
          slot: Number(item.slot || 0),
          text: String(item.text || "").trim(),
          done: Boolean(item.done),
          updated_at: item.updated_at || null
        })).filter((item) => item.date && item.slot >= 1 && item.slot <= 3 && item.text);
      }

      function collectCurrentMonthlyForDatabase(form) {
        const month = form.date.slice(0, 7);
        const byId = new Map();
        (state.databases?.monthly?.items || []).filter((item) => item.done && item.text).forEach((item) => {
          const id = item.id || createClientId("month");
          byId.set(id, {
            id,
            text: item.text || "",
            done: Boolean(item.done),
            created_at: item.created_at || null,
            updated_at: item.updated_at || null
          });
        });
        (form.todos || []).filter((item) => (item.month || month) === month).forEach((item) => {
          const id = item.id || createClientId("month");
          byId.set(id, {
            id,
            text: String(item.text || "").trim(),
            done: Boolean(item.done),
            created_at: item.created_at || null,
            updated_at: item.updated_at || null
          });
        });
        return Array.from(byId.values()).filter((item) => item.text);
      }

      function collectMonthlyBacklogForDatabase(form) {
        const month = form.date.slice(0, 7);
        return (form.todos || []).map((item) => ({
          month: item.month || month,
          id: item.id || createClientId("month"),
          text: String(item.text || "").trim(),
          done: Boolean(item.done),
          created_at: item.created_at || null,
          updated_at: item.updated_at || null
        })).filter((item) => item.month && item.text);
      }

      function collectAnnualGoalsForDatabase(form) {
        const existingItems = (state.databases?.annual_goals?.items || []);
        const goalTexts = (form.annualGoals || []).map((goal) => String(goal || "").trim()).filter(Boolean);
        console.log("[DEBUG] collectAnnualGoalsForDatabase: form.annualGoals=", JSON.stringify(form.annualGoals), "goalTexts=", JSON.stringify(goalTexts), "existingItems=", existingItems.length);
        return goalTexts.map((text, index) => {
          const existing = existingItems.find((item) => item.text === text);
          return {
            id: existing?.id || createClientId("year"),
            text,
            done: Boolean(existing?.done),
            created_at: existing?.created_at || null,
            updated_at: existing?.updated_at || null
          };
        });
      }

      function applyFormToPage() {
        renderHabitChecks(activeHabitDefinitions());
        dataSaveFields().forEach((field) => {
          const value = state.form[field.dataset.save];
          if (field.type === "checkbox") {
            field.checked = Boolean(value);
          } else if (value !== undefined) {
            field.value = value;
          }
        });
        setMood(state.form.mood || "平静", false);
        setWeather(state.form.weather || "", false);
        renderBodyTags(unionBodyTagDefinitions());
        applyBodyTags(state.form.bodyTags || []);
        renderBodyTagSummary();
        if (identityTitleEl) identityTitleEl.textContent = state.form.identityTitle || storedIdentityTitle();
        renderFrogDebt(state.form.frogDebt || []);
        renderTodos(state.form.todos || []);
        renderAnnualGoals(state.form.annualGoals || []);
        updateDerivedLabels();
        autoSizeAll();
      }

      function readPageToForm() {
        dataSaveFields().forEach((field) => {
          state.form[field.dataset.save] = field.type === "checkbox" ? field.checked : field.value;
        });
        state.form.habitDefinitions = activeHabitDefinitions();
        state.form.mood = document.querySelector(".mood-btn.is-active")?.dataset.mood || state.form.mood || "平静";
        state.form.weather = document.querySelector("[data-weather].is-active")?.dataset.weather || "";
        state.form.bodyTags = activeBodyTags();
        state.form.identityTitle = identityTitleEl?.textContent.trim() || storedIdentityTitle();
        state.form.todos = Array.from(todoList.querySelectorAll(".todo-item")).map((item) => ({
          id: item.dataset.id || createClientId("month"),
          month: item.dataset.month || state.form.date.slice(0, 7),
          text: item.querySelector(".todo-text")?.textContent.trim() || "",
          done: Boolean(item.querySelector("input")?.checked),
          created_at: item.dataset.createdAt ? Number(item.dataset.createdAt) : null,
          updated_at: item.dataset.updatedAt ? Number(item.dataset.updatedAt) : null
        })).filter((todo) => todo.text);
        state.form.frogDebt = (state.form.frogDebt || []).filter((frog) => frog && frog.date && frog.slot && frog.text);
        state.form.annualGoals = readAnnualGoalsFromDom();
      }

      function setMood(mood, updateForm = true) {
        moodButtons.forEach((button) => {
          const active = button.dataset.mood === mood;
          button.classList.toggle("is-active", active);
          button.setAttribute("aria-pressed", String(active));
        });
        document.getElementById("moodLabel").textContent = mood;
        if (updateForm) state.form.mood = mood;
      }

      function setWeather(weather, updateForm = true) {
        weatherButtons.forEach((button) => {
          button.classList.toggle("is-active", Boolean(weather) && button.dataset.weather === weather);
        });
        if (updateForm) state.form.weather = weather || "";
      }

      function applyBodyTags(tags) {
        const active = new Set(tags || []);
        bodyTagButtonEls().forEach((button) => {
          button.classList.toggle("is-active", active.has(button.dataset.bodyTag));
        });
      }

      function dedupeTags(list) {
        return Array.from(new Set((list || []).map((tag) => String(tag).trim()).filter(Boolean)));
      }

      function storedBodyTags() {
        try {
          const parsed = JSON.parse(localStorage.getItem(BODY_TAGS_KEY) || "");
          if (Array.isArray(parsed)) {
            const tags = dedupeTags(parsed);
            if (tags.length) return tags;
          }
        } catch {}
        return [...DEFAULT_BODY_TAGS];
      }

      function parseBodyTagsInput(text) {
        const tags = dedupeTags(String(text || "").split(/\r?\n/));
        return tags.length ? tags : [...DEFAULT_BODY_TAGS];
      }

      function unionBodyTagDefinitions() {
        return dedupeTags([...storedBodyTags(), ...((state.form && state.form.bodyTags) || [])]);
      }

      function activeBodyTags() {
        return bodyTagButtonEls()
          .filter((button) => button.classList.contains("is-active"))
          .map((button) => button.dataset.bodyTag);
      }

      function renderBodyTags(tags) {
        if (!bodyTagGrid) return;
        const definitions = dedupeTags(tags && tags.length ? tags : storedBodyTags());
        bodyTagGrid.innerHTML = "";
        definitions.forEach((tag) => {
          const button = document.createElement("button");
          button.className = "tag-btn";
          button.type = "button";
          button.dataset.bodyTag = tag;
          button.textContent = tag;
          bodyTagGrid.append(button);
        });
      }

      function renderBodyTagSummary() {
        if (!bodyTagSummary) return;
        const tags = activeBodyTags();
        const noteInput = document.querySelector('[data-save="health-signal"]');
        const note = (noteInput?.value || "").trim();
        bodyTagSummary.innerHTML = "";
        if (!tags.length && !note) {
          const empty = document.createElement("span");
          empty.className = "tag-summary-empty";
          empty.textContent = "还没有标记，点下方标签记录今天的身体信号";
          bodyTagSummary.append(empty);
          return;
        }
        tags.forEach((tag) => {
          const chip = document.createElement("span");
          chip.className = "tag-chip";
          chip.textContent = tag;
          bodyTagSummary.append(chip);
        });
        if (note) {
          const noteChip = document.createElement("span");
          noteChip.className = "tag-chip tag-chip-note";
          noteChip.textContent = note;
          bodyTagSummary.append(noteChip);
        }
      }

      function storedMoodIcons() {
        try {
          const parsed = JSON.parse(localStorage.getItem(MOOD_ICONS_KEY) || "{}");
          if (parsed && typeof parsed === "object") return parsed;
        } catch {}
        return {};
      }

      function applyMoodIcons() {
        const icons = storedMoodIcons();
        moodButtons.forEach((button) => {
          const mood = button.dataset.mood;
          const face = button.querySelector(".mood-face");
          let logo = button.querySelector(".mood-logo");
          if (icons[mood]) {
            if (!logo) {
              logo = document.createElement("img");
              logo.className = "mood-logo";
              logo.alt = "";
              button.insertBefore(logo, button.firstChild);
            }
            logo.src = icons[mood];
            logo.hidden = false;
            if (face) face.style.display = "none";
          } else {
            if (logo) logo.remove();
            if (face) face.style.display = "";
          }
        });
      }

      function readImageAsIcon(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("读取图片失败"));
          reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error("解析图片失败"));
            img.onload = () => {
              const size = 96;
              const canvas = document.createElement("canvas");
              canvas.width = size;
              canvas.height = size;
              const ctx = canvas.getContext("2d");
              const scale = Math.max(size / img.width, size / img.height);
              const w = img.width * scale;
              const h = img.height * scale;
              ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
              resolve(canvas.toDataURL("image/png"));
            };
            img.src = reader.result;
          };
          reader.readAsDataURL(file);
        });
      }

      async function handleMoodIconUpload(mood, file) {
        if (!file) return;
        try {
          const dataUrl = await readImageAsIcon(file);
          const icons = storedMoodIcons();
          icons[mood] = dataUrl;
          localStorage.setItem(MOOD_ICONS_KEY, JSON.stringify(icons));
          applyMoodIcons();
          renderMoodIconEditor();
        } catch (error) {
          setStatus(`图标上传失败：${toErrorMessage(error)}`);
        }
      }

      function removeMoodIcon(mood) {
        const icons = storedMoodIcons();
        delete icons[mood];
        localStorage.setItem(MOOD_ICONS_KEY, JSON.stringify(icons));
        applyMoodIcons();
        renderMoodIconEditor();
      }

      function renderMoodIconEditor() {
        if (!moodIconEditor) return;
        const icons = storedMoodIcons();
        moodIconEditor.innerHTML = "";
        moodButtons.forEach((button) => {
          const mood = button.dataset.mood;
          const row = document.createElement("div");
          row.className = "mood-icon-row";

          const preview = document.createElement(icons[mood] ? "img" : "span");
          preview.className = "mood-icon-preview";
          preview.dataset.mood = mood;
          if (icons[mood]) preview.src = icons[mood];
          row.append(preview);

          const name = document.createElement("span");
          name.className = "mood-icon-name";
          name.textContent = mood;
          row.append(name);

          const actions = document.createElement("div");
          actions.className = "mood-icon-actions";

          const uploadBtn = document.createElement("button");
          uploadBtn.type = "button";
          uploadBtn.textContent = icons[mood] ? "更换" : "上传";
          const fileInput = document.createElement("input");
          fileInput.type = "file";
          fileInput.accept = "image/*";
          fileInput.style.display = "none";
          fileInput.addEventListener("change", () => {
            handleMoodIconUpload(mood, fileInput.files?.[0]);
            fileInput.value = "";
          });
          uploadBtn.addEventListener("click", () => fileInput.click());
          actions.append(uploadBtn, fileInput);

          if (icons[mood]) {
            const clearBtn = document.createElement("button");
            clearBtn.type = "button";
            clearBtn.textContent = "清除";
            clearBtn.addEventListener("click", () => removeMoodIcon(mood));
            actions.append(clearBtn);
          }

          row.append(actions);
          moodIconEditor.append(row);
        });
      }

      function imageExtensionFromType(type) {
        const map = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/jpg": "jpg",
          "image/gif": "gif",
          "image/webp": "webp",
          "image/bmp": "bmp",
          "image/svg+xml": "svg"
        };
        return map[String(type || "").toLowerCase()] || "png";
      }

      function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
          reader.readAsDataURL(blob);
        });
      }

      async function ingestImageFile(file) {
        if (!file || !String(file.type || "").startsWith("image/")) return;
        try {
          setStatus("正在保存图片…");
          const ext = imageExtensionFromType(file.type);
          const fileName = file.name && /\.[a-z0-9]+$/i.test(file.name) ? file.name : `pasted-${Date.now()}.${ext}`;
          let stored;
          if (tauriInvoke) {
            const buffer = await file.arrayBuffer();
            stored = await tauriInvoke("save_journal_image_bytes", {
              date: state.form.date || date,
              fileName,
              bytes: Array.from(new Uint8Array(buffer))
            });
          } else {
            stored = await blobToDataUrl(file);
          }
          if (!stored) {
            setStatus("图片保存失败");
            return;
          }
          insertImageReference(stored);
          setStatus("图片已插入，正在保存…");
        } catch (error) {
          setStatus(`添加图片失败：${toErrorMessage(error)}`);
        }
      }

      // 把保存好的图片以 Obsidian 可识别的形式插入碎碎念光标处：
      // 本地文件用 ![[文件名]] 嵌入（Obsidian 会在库内按文件名自动定位），
      // 没有文件名的 data URL 退回标准 Markdown 图片语法。
      function insertImageReference(stored) {
        if (!brainDump) return;
        const value = String(stored || "");
        const isDataUrl = value.startsWith("data:");
        const fileName = value.split(/[\\/]/).pop() || value;
        const snippet = isDataUrl ? `![](${value})` : `![[${fileName}]]`;
        const current = brainDump.value || "";
        const start = brainDump.selectionStart ?? current.length;
        const end = brainDump.selectionEnd ?? current.length;
        const before = current.slice(0, start);
        const after = current.slice(end);
        const leadingBreak = before && !before.endsWith("\n") ? "\n" : "";
        const trailingBreak = after && !after.startsWith("\n") ? "\n" : "";
        const insertText = `${leadingBreak}${snippet}${trailingBreak}`;
        brainDump.value = `${before}${insertText}${after}`;
        const caret = before.length + insertText.length;
        brainDump.focus();
        brainDump.setSelectionRange(caret, caret);
        brainDump.dispatchEvent(new Event("input", { bubbles: true }));
      }

      async function loadHitokoto() {
        if (!hitokotoText) return;
        hitokotoText.textContent = "正在获取一言…";
        try {
          const controller = new AbortController();
          const timer = window.setTimeout(() => controller.abort(), 5000);
          const response = await fetch("https://v1.hitokoto.cn/?encode=text", { signal: controller.signal });
          window.clearTimeout(timer);
          if (!response.ok) throw new Error(String(response.status));
          const text = (await response.text()).trim();
          hitokotoText.textContent = text || randomHitokotoFallback();
        } catch {
          hitokotoText.textContent = randomHitokotoFallback();
        }
      }

      function randomHitokotoFallback() {
        return HITOKOTO_FALLBACKS[Math.floor(Math.random() * HITOKOTO_FALLBACKS.length)];
      }

      function storedIdentityTitle() {
        return (localStorage.getItem(IDENTITY_TITLE_KEY) || "").trim() || DEFAULT_IDENTITY_TITLE;
      }

      function renderHabitChecks(definitions) {
        if (!habitCheckList) return;
        habitCheckList.innerHTML = "";
        normaliseHabitDefinitions(definitions).forEach((definition) => {
          const item = document.createElement("li");
          item.className = "check-item";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.dataset.save = definition.id;
          input.checked = Boolean(state.form[definition.id]);
          input.setAttribute("aria-label", definition.label);
          const label = document.createElement("span");
          label.textContent = definition.label;
          item.append(input, label);
          habitCheckList.append(item);
        });
      }

      function renderFrogDebt(items) {
        state.form.frogDebt = (items || state.form.frogDebt || []).filter((frog) => frog && frog.date && frog.slot && frog.text);
        if (!frogDebtList) {
          updateFrogDebtCount();
          return;
        }
        frogDebtList.innerHTML = "";
        const visibleItems = state.form.frogDebt;
        if (!visibleItems.length) {
          const empty = document.createElement("li");
          empty.className = "empty-row";
          empty.textContent = "没有未完成青蛙";
          frogDebtList.append(empty);
          updateFrogDebtCount();
          return;
        }

        visibleItems.forEach((frog) => {
          const item = document.createElement("li");
          item.className = `debt-item${frog.done ? " is-done" : ""}`;
          item.dataset.date = frog.date || "";
          item.dataset.slot = String(frog.slot || "");
          if (frog.updated_at) item.dataset.updatedAt = String(frog.updated_at);
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = Boolean(frog.done);
          checkbox.setAttribute("aria-label", "完成这只青蛙");
          const text = document.createElement("span");
          text.className = "debt-text";
          text.textContent = frog.text;
          const meta = document.createElement("span");
          meta.className = "debt-meta";
          const date = document.createElement("time");
          date.dateTime = frog.date || "";
          date.textContent = frog.date || "未记录";
          const slot = document.createElement("span");
          slot.className = "debt-slot";
          slot.textContent = `#${frog.slot || "-"}`;
          meta.append(date, slot);
          checkbox.addEventListener("change", () => item.classList.toggle("is-done", checkbox.checked));
          item.append(checkbox, text, meta);
          frogDebtList.append(item);
        });
        updateFrogDebtCount();
      }

      function renderTodos(todos) {
        todoList.innerHTML = "";
        const month = state.form.date.slice(0, 7);
        const visibleTodos = (todos || []).filter((todo) => todo.text);
        if (!visibleTodos.length) {
          const empty = document.createElement("li");
          empty.className = "empty-row";
          empty.textContent = "没有未完成事项";
          todoList.append(empty);
          updateTodoCount();
          return;
        }
        visibleTodos.forEach((todo) => {
          const item = document.createElement("li");
          item.className = `todo-item${todo.done ? " is-done" : ""}`;
          item.dataset.id = todo.id || createClientId("month");
          item.dataset.month = todo.month || month;
          if (todo.created_at) item.dataset.createdAt = String(todo.created_at);
          if (todo.updated_at) item.dataset.updatedAt = String(todo.updated_at);
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = Boolean(todo.done);
          checkbox.setAttribute("aria-label", "完成本月事项");
          const text = document.createElement("span");
          text.className = "todo-text";
          text.textContent = todo.text;
          const meta = document.createElement("time");
          meta.className = "todo-meta";
          meta.dateTime = item.dataset.month;
          meta.textContent = item.dataset.month === month ? "本月" : item.dataset.month;
          const button = document.createElement("button");
          button.className = "delete-todo";
          button.type = "button";
          button.setAttribute("aria-label", "删除本月事项");
          button.textContent = "×";
          button.addEventListener("click", () => item.remove());
          checkbox.addEventListener("change", () => item.classList.toggle("is-done", checkbox.checked));
          item.append(checkbox, text, meta);
          if (item.dataset.month === month) item.append(button);
          todoList.append(item);
        });
        updateTodoCount();
      }

      function addMonthlyItem(text) {
        const cleanText = String(text || "").trim();
        if (!cleanText) return false;
        const now = Math.floor(Date.now() / 1000);
        readPageToForm();
        const item = {
          id: createClientId("month"),
          month: state.form.date.slice(0, 7),
          text: cleanText,
          done: false,
          created_at: now,
          updated_at: now
        };
        renderTodos([...(state.form.todos || []), item]);
        readPageToForm();
        return true;
      }

      function readAnnualGoalsFromDom() {
        if (!annualGoalList) { console.log("[DEBUG] readAnnualGoalsFromDom: annualGoalList is null!"); return []; }
        const values = Array.from(annualGoalList.querySelectorAll("input.write-line")).map((input) => input.value);
        console.log("[DEBUG] readAnnualGoalsFromDom: found", values.length, "inputs, values=", JSON.stringify(values));
        return values;
      }

      function renderAnnualGoals(goals) {
        if (!annualGoalList) return;
        const list = Array.isArray(goals) ? goals.slice() : [];
        while (list.length < 2) list.push("");
        annualGoalList.innerHTML = "";
        list.forEach((goal, index) => {
          const row = document.createElement("label");
          row.className = index >= 2 ? "line-field annual-goal-row" : "line-field";
          const num = document.createElement("span");
          num.className = "line-number";
          num.textContent = String(index + 1);
          const input = document.createElement("input");
          input.className = "write-line";
          input.type = "text";
          input.autocomplete = "off";
          input.value = goal || "";
          input.placeholder = ANNUAL_GOAL_PLACEHOLDERS[index] || "再写一个今年想达成的目标";
          input.addEventListener("input", () => {
            updateDerivedLabels();
            scheduleSave();
          });
          row.append(num, input);
          if (index >= 2) {
            const del = document.createElement("button");
            del.type = "button";
            del.className = "delete-todo";
            del.setAttribute("aria-label", "删除年度目标");
            del.textContent = "×";
            del.addEventListener("click", () => {
              const current = readAnnualGoalsFromDom();
              current.splice(index, 1);
              renderAnnualGoals(current);
              scheduleSave("年度目标已更新，正在保存…");
            });
            row.append(del);
          }
          annualGoalList.append(row);
        });
      }

      function addAnnualGoalRow(focus) {
        const current = readAnnualGoalsFromDom();
        current.push("");
        renderAnnualGoals(current);
        if (focus) {
          const inputs = annualGoalList.querySelectorAll("input.write-line");
          inputs[inputs.length - 1]?.focus();
        }
      }

      function updateDerivedLabels() {
        const message = document.querySelector('[data-save="self-message"]');
        if (messageCount && message) messageCount.textContent = String(message.value.trim().length);
        updateFrogDebtCount();
        updateTodoCount();
        updateMetrics();
      }

      function openFrogDebtCount() {
        return (state.form.frogDebt || []).filter((frog) => frog && frog.text && !frog.done).length;
      }

      function updateFrogDebtCount() {
        if (frogDebtCount) frogDebtCount.textContent = `${openFrogDebtCount()} 项未完成`;
      }

      function updateTodoCount() {
        const items = Array.from(todoList.querySelectorAll(".todo-item"));
        const done = items.filter((item) => item.querySelector("input")?.checked).length;
        if (todoCount) todoCount.textContent = `${Math.max(0, items.length - done)} 项未完成`;
      }

      function updateMasthead() {
        const currentDate = parseDateKey(state.form.date);
        const dayIndex = Number(state.form.dayIndex) || 1;
        const dayTitle = `第 ${dayIndex} 天`;
        document.querySelector(".day-title h1").textContent = dayTitle;
        document.querySelector(".meta-line").textContent = `${state.form.date.replaceAll("-", ".")} · ${weekdayLabel(currentDate)} · 时光手帐 Daily`;
        document.querySelector(".weather-chip").textContent = `${weekdayLabel(currentDate)} · 早间记录`;
        const chipWeekday = document.getElementById("chipWeekday");
        const chipDayIndex = document.getElementById("chipDayIndex");
        if (chipWeekday) chipWeekday.textContent = `${weekdayLabel(currentDate)} · 早间记录`;
        if (chipDayIndex) chipDayIndex.textContent = dayTitle;
        const metricJournalCount = document.getElementById("metricJournalCount");
        if (metricJournalCount) metricJournalCount.innerHTML = `${dayIndex} <span>篇</span>`;
        updateMetrics();
      }

      function updateMetrics() {
        const metricFrogOpen = document.getElementById("metricFrogOpen");
        if (metricFrogOpen) {
          metricFrogOpen.innerHTML = `${openFrogDebtCount()} <span>项</span>`;
        }
        const metricHabitChecks = document.getElementById("metricHabitChecks");
        if (metricHabitChecks && habitCheckList) {
          const boxes = Array.from(habitCheckList.querySelectorAll('input[type="checkbox"]'));
          const checked = boxes.filter((box) => box.checked).length;
          metricHabitChecks.textContent = `${checked}/${boxes.length}`;
        }
      }

      function buildMarkdown(form) {
        const frogs = [form["frog-1"], form["frog-2"], form["frog-3"]].map((value) => String(value || "").trim());
        const habits = activeHabitDefinitions(form).map((definition) => [definition.label, form[definition.id]]);
        const todos = (form.todos || []).filter((todo) => String(todo.text || "").trim());
        const identityTitle = String(form.identityTitle || "").trim() || DEFAULT_IDENTITY_TITLE;
        const freeNotes = textOrBlank(form["brain-dump"]);
        const annualGoals = (form.annualGoals || []).map((goal) => String(goal || "").trim()).filter(Boolean);
        const progress = String(form["yesterday-progress"] || "").trim();
        const learn = String(form["yesterday-learn"] || "").trim();
        const bodyTags = (form.bodyTags || []).filter(Boolean).join("、");
        const healthSignal = String(form["health-signal"] || "").trim();
        const selfMessage = textOrBlank(form["self-message"]);
        const confidence = String(form["half-year-confidence"] || "").trim();
        const mood = String(form.mood || "").trim();
        const weather = String(form.weather || "").trim();

        const frontmatter = [
          "---",
          "type: daily",
          `date: ${form.date}`,
          `day_index: ${form.dayIndex || ""}`,
        ];
        if (mood) frontmatter.push(`mood: ${mood}`);
        if (weather) frontmatter.push(`weather: ${weather}`);
        if (confidence) frontmatter.push(`half_year_confidence: ${confidence}`);
        frontmatter.push("tags:", "  - daily", "  - morning", "---");

        const parts = [
          ...frontmatter,
          "",
          `# 第 ${Number(form.dayIndex) || 1} 天`,
          "",
          "## 碎碎念",
          freeNotes || "——",
          "",
          "## 三只青蛙",
          `1. ${frogs[0] || "——"}`,
          `2. ${frogs[1] || "——"}`,
          `3. ${frogs[2] || "——"}`,
          "",
          `## ${identityTitle}`,
          selfMessage || "——",
          "",
          "## 理解昨天",
          habits.map(([label, checked]) => `- [${checked ? "x" : " "}] ${label}`).join("\n"),
        ];

        if (progress || learn) {
          parts.push("", "## 昨日有没有日拱一卒");
          if (progress) parts.push(`- 进：${progress}`);
          if (learn) parts.push(`- 学：${learn}`);
        }

        if (bodyTags || healthSignal) {
          parts.push("", "## 今天身体有没有提醒我什么");
          if (bodyTags) parts.push(`- 标签：${bodyTags}`);
          if (healthSignal) parts.push(`- 备注：${healthSignal}`);
        }

        parts.push(
          "",
          "## 看见未来",
          todos.length ? todos.map((todo) => {
            const prefix = todo.month && todo.month !== form.date.slice(0, 7) ? `${todo.month} · ` : "";
            return `- [${todo.done ? "x" : " "}] ${prefix}${todo.text}`;
          }).join("\n") : "——",
        );

        if (annualGoals.length) {
          parts.push("", "## 年度目标");
          parts.push(annualGoals.map((goal, index) => `${index + 1}. ${goal}`).join("\n"));
        }

        parts.push("");
        return parts.join("\n");
      }

      function parseMarkdown(markdown, valueDate) {
        const form = defaultForm(valueDate);
        const frontmatter = extractFrontmatter(markdown);
        form.dayIndex = frontmatter.day_index || frontmatter.day || form.dayIndex;
        form.mood = frontmatter.mood || form.mood;
        form.weather = frontmatter.weather || form.weather;
        form.identityTitle = frontmatter.identity_title || form.identityTitle;
        form["half-year-confidence"] = frontmatter.half_year_confidence || form["half-year-confidence"];

        const sections = splitSections(stripFrontmatter(markdown));
        parseStatusLines(findSection(sections, ["规划今天"])).forEach(([key, value]) => {
          if (key === "心情") form.mood = value || form.mood;
          if (key === "天气") form.weather = value || form.weather;
        });

        const frogs = parseNumberedList(findSection(sections, ["三只青蛙"])).map((text) => (text === "_(待定)_" || text === "——") ? "" : text);
        form["frog-1"] = frogs[0] || "";
        form["frog-2"] = frogs[1] || "";
        form["frog-3"] = frogs[2] || "";
        const selfMsg = findSection(sections, [
          form.identityTitle,
          storedIdentityTitle(),
          DEFAULT_IDENTITY_TITLE,
          LEGACY_IDENTITY_TITLE
        ].filter(Boolean));
        form["self-message"] = (selfMsg === "_暂无_" || selfMsg === "——") ? "" : selfMsg;
        const habitChecklist = parseChecklistLines(findSection(sections, ["理解昨天"]));
        form.habitChecklistByLabel = Object.fromEntries(habitChecklist.map((item) => [item.label, item.checked]));
        applyChecklistEntries(form, habitChecklist, {
          "写了晨间日记": "habit-journal",
          "推进了核心任务": "habit-focus",
          "晚上做了简短回看": "habit-review"
        });
        parseStatusLines(findSection(sections, ["昨日有没有日拱一卒"])).forEach(([key, value]) => {
          if (key === "进") form["yesterday-progress"] = value;
          if (key === "学") form["yesterday-learn"] = value;
        });
        parseStatusLines(findSection(sections, ["今天身体有没有提醒我什么", "身体健康注意了吗"])).forEach(([key, value]) => {
          if (key === "标签") form.bodyTags = value.split(/[、,，\s]+/).map((tag) => tag.trim()).filter(Boolean);
          if (key === "备注" || key === "身体信号") form["health-signal"] = value;
        });
        form.todos = parseTodoLines(findSection(sections, ["看见未来"]));
        form.annualGoals = parseNumberedList(findSection(sections, ["年度目标", "半年目标"]));
        parseStatusLines(findSection(sections, ["年度目标", "半年目标"])).forEach(([key, value]) => {
          if (key === "把握") form["half-year-confidence"] = value;
        });
        const freeNotes = findSection(sections, ["碎碎念", "其他想记录的"]);
        form["brain-dump"] = String(freeNotes || "").trim().replace(/^(?:_暂无_|——)$/, "");
        return form;
      }

      function defaultForm(valueDate, dayIndex = "") {
        return {
          date: valueDate,
          dayIndex: String(dayIndex || ""),
          mood: "平静",
          weather: "",
          identityTitle: storedIdentityTitle(),
          bodyTags: [],
          images: [],
          "half-year-confidence": "5",
          habitDefinitions: habitDefinitions(),
          habitChecklistByLabel: {},
          frogDebt: [],
          todos: [],
          annualGoals: []
        };
      }

      function normaliseHabitDefinitions(definitions) {
        const seen = new Set();
        const result = (definitions || []).map((definition) => ({
          id: String(definition.id || "").trim(),
          label: String(definition.label || "").trim()
        })).filter((definition) => {
          if (!definition.id || !definition.label || seen.has(definition.id)) return false;
          seen.add(definition.id);
          return true;
        });
        return result.length ? result : habitDefinitions();
      }

      function activeHabitDefinitions(form = state.form) {
        return normaliseHabitDefinitions(form?.habitDefinitions || state.databases?.habit_definitions);
      }

      function applyHabitMarkdownFallback(form, definitions) {
        const byLabel = form.habitChecklistByLabel || {};
        normaliseHabitDefinitions(definitions).forEach((definition) => {
          if (form[definition.id] === undefined && Object.prototype.hasOwnProperty.call(byLabel, definition.label)) {
            form[definition.id] = Boolean(byLabel[definition.label]);
          }
        });
      }

      function normaliseFrogsForDatabase(frogs) {
        const bySlot = new Map((frogs || []).map((item) => [Number(item.slot), item]));
        return [1, 2, 3].map((slot) => {
          const item = bySlot.get(slot) || {};
          return {
            slot,
            text: String(item.text || "").trim(),
            done: Boolean(item.done)
          };
        });
      }

      function normaliseMonthlyForDatabase(items, month, now) {
        return (items || []).map((item, index) => ({
          id: item.id || `${month}-${index + 1}-${now}`,
          text: String(item.text || "").trim(),
          done: Boolean(item.done),
          created_at: item.created_at || now,
          updated_at: now
        })).filter((item) => item.text);
      }

      function createClientId(prefix) {
        if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }

      function extractFrontmatter(markdown) {
        const frontmatter = {};
        if (!markdown || !markdown.startsWith("---")) return frontmatter;
        const end = markdown.indexOf("\n---", 3);
        if (end === -1) return frontmatter;
        markdown.slice(3, end).split(/\r?\n/).forEach((line) => {
          const index = line.indexOf(":");
          if (index === -1) return;
          frontmatter[line.slice(0, index).trim()] = line.slice(index + 1).trim();
        });
        return frontmatter;
      }

      function stripFrontmatter(markdown) {
        if (!markdown || !markdown.startsWith("---")) return markdown || "";
        const end = markdown.indexOf("\n---", 3);
        return end === -1 ? markdown : markdown.slice(end + 4).trimStart();
      }

      function splitSections(markdown) {
        const sections = [];
        let current = null;
        markdown.split(/\r?\n/).forEach((line) => {
          if (line.startsWith("## ")) {
            if (current) sections.push(current);
            current = { title: line.slice(3).trim(), body: "" };
            return;
          }
          if (current) current.body += `${line}\n`;
        });
        if (current) sections.push(current);
        return sections.map((section) => ({ title: section.title, body: section.body.trim() }));
      }

      function findSection(sections, names) {
        const section = sections.find((item) => names.includes(item.title));
        return section ? section.body.trim() : "";
      }

      function parseNumberedList(text) {
        return splitLines(text).map((line) => line.replace(/^\d+[.、]\s*/, "").trim()).filter(Boolean);
      }

      function parseTodoLines(text) {
        return splitLines(text).map((line) => {
          const done = /^-\s+\[[xX]\]\s*/.test(line);
          const clean = line.replace(/^-\s+\[[ xX]\]\s*/, "").trim();
          return clean ? { text: clean, done } : null;
        }).filter(Boolean);
      }

      function parseStatusLines(text) {
        return splitLines(text).map((line) => {
          const clean = line.replace(/^-\s*/, "");
          const index = clean.indexOf("：");
          if (index === -1) return null;
          return [clean.slice(0, index).trim(), clean.slice(index + 1).trim()];
        }).filter(Boolean);
      }

      function parseChecklistLines(text) {
        return splitLines(text).map((line) => {
          const checked = /^-\s+\[[xX]\]\s*/.test(line);
          const label = line.replace(/^-\s+\[[ xX]\]\s*/, "").trim();
          return label ? { label, checked } : null;
        }).filter(Boolean);
      }

      function applyChecklistEntries(form, entries, map) {
        entries.forEach((entry) => {
          if (map[entry.label]) form[map[entry.label]] = entry.checked;
        });
      }

      function applyChecklist(form, text, map) {
        applyChecklistEntries(form, parseChecklistLines(text), map);
      }

      function splitLines(text) {
        return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      }

      function textOrBlank(value) {
        return String(value || "").trim();
      }

      function setStatus(text) {
        if (status) status.textContent = text;
      }
    })();
