(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const shared = globalThis.StudyShared;
  const state = {
    settings: shared.normalizeSettings(shared.DEFAULTS),
    status: null,
    tab: null,
    permission: false,
    connection: { available: false, message: "正在连接当前页面" },
    ready: false,
    pending: false,
    polling: false,
    uiError: null,
    historyKey: "",
    modalAnimation: null,
    modalToken: 0,
    trigger: null
  };
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const phases = { idle: "准备就绪", detecting: "正在识别", reading: "阅读中", centering: "视频居中", playing: "播放中", waiting_completion: "等待平台确认", paused: "已暂停", waiting: "等待下一项", navigating: "正在切换", completed: "本轮已结束", blocked: "需要操作", error: "遇到问题" };
  const typeLabels = { video: "视频片段", document: "文档内容", text: "文字内容", unknown: "自动识别" };
  const selectorIds = { video: "selectorVideo", document: "selectorDocument", scroll: "selectorScroll", next: "selectorNext", task: "selectorTask", activeTask: "selectorActiveTask", completed: "selectorCompleted" };

  function validTab() {
    try { return Boolean(state.tab?.id && /^https?:$/.test(new URL(state.tab.url).protocol)); }
    catch { return false; }
  }

  async function request(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result || result.ok === false) throw new Error(result?.error || "无法连接学习引擎，请在扩展管理页重新加载插件。");
    return result;
  }

  function formatTime(value) {
    const seconds = Math.max(0, Math.ceil(Number(value) || 0));
    return shared.formatTime(seconds);
  }

  function setIcon(element, paths) {
    element.replaceChildren();
    paths.forEach((attributes) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", attributes.tag || "path");
      Object.entries(attributes).forEach(([name, value]) => { if (name !== "tag") path.setAttribute(name, value); });
      element.append(path);
    });
  }

  function applyTheme(theme = state.settings.theme) {
    document.documentElement.dataset.theme = theme === "system" ? (systemTheme.matches ? "dark" : "light") : theme;
    const label = { system: "跟随浏览器主题", light: "亮色主题", dark: "暗色主题" }[theme];
    $("#themeButton").setAttribute("aria-label", `当前${label}，点击切换`);
    $("#themeButton").title = label;
    if (theme === "system") setIcon($("#themeIcon"), [{ tag: "rect", x: 3, y: 4, width: 18, height: 13, rx: 3 }, { d: "M8 21h8m-4-4v4" }]);
    else if (theme === "light") setIcon($("#themeIcon"), [{ tag: "circle", cx: 12, cy: 12, r: 3.5 }, { d: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" }]);
    else setIcon($("#themeIcon"), [{ d: "M20.2 15.1A8.2 8.2 0 0 1 8.9 3.8 8.4 8.4 0 1 0 20.2 15.1Z" }]);
  }

  function renderHistory() {
    const history = Array.isArray(state.status?.history) ? state.status.history : [];
    const key = JSON.stringify(history);
    $("#completedCount").textContent = String(state.status?.completedCount || 0);
    if (key === state.historyKey) return;
    state.historyKey = key;
    const list = $("#historyList");
    list.replaceChildren();
    if (!history.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "下一段学习，从这里开始。";
      list.append(empty);
      return;
    }
    history.slice(0, 10).forEach((task) => {
      const row = document.createElement("div");
      row.className = "history-item";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.classList.add("icon");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      setIcon(icon, [{ d: "m5 12 4 4L19 6" }]);
      const title = document.createElement("span");
      title.textContent = task.title || "已处理任务";
      title.title = title.textContent;
      const type = document.createElement("small");
      type.textContent = ({ video: "视频", document: "文档", text: "文本" })[task.type] || "任务";
      row.append(icon, title, type);
      list.append(row);
    });
  }

  function scrollSeconds(status) {
    const scroll = status.scroll || {};
    const explicit = Number(scroll.nextAt);
    if (scroll.nextAt != null && Number.isFinite(explicit) && explicit > 0) return Math.max(0, (explicit - Date.now()) / 1000);
    const next = scroll.nextInSeconds == null ? NaN : Number(scroll.nextInSeconds);
    if (!Number.isFinite(next)) return NaN;
    const capturedAt = Number(scroll.sampledAt || status.updatedAt);
    if (Number.isFinite(capturedAt) && capturedAt > 0) return Math.max(0, next - (Date.now() - capturedAt) / 1000);
    // Repeated reads of the same cached snapshot must not restart its countdown.
    const key = JSON.stringify([status.phase, status.taskType, scroll.movements, scroll.intervalSeconds, next]);
    if (state.scrollClock?.key !== key) state.scrollClock = { key, deadline: Date.now() + Math.max(0, next) * 1000 };
    return Math.max(0, (state.scrollClock.deadline - Date.now()) / 1000);
  }

  function renderProgress() {
    const status = state.status;
    const phase = status?.phase || "idle";
    const video = status?.taskType === "video";
    const videosCompleted = Math.max(0, Math.floor(Number(status?.flow?.videosCompleted) || 0));
    const interTaskWaiting = phase === "waiting" && Boolean(status?.nextAt);
    const videoProgress = video && (["centering", "playing", "waiting"].includes(phase) ||
      ["paused", "blocked"].includes(phase) && status?.scroll?.state === "video");
    let percent = 0;
    let time = formatTime(state.settings.scrollIntervalSeconds);
    let caption = "滚动基准间隔";
    let textValue = false;
    let indeterminate = false;
    let progressLabel = "下次滚动等待进度";
    if (interTaskWaiting) {
      caption = "即将进入下一项";
      time = formatTime(Math.max(0, (Number(status.nextAt) - Date.now()) / 1000));
      percent = 100;
      progressLabel = "等待进入下一项";
    } else if (phase === "waiting" && ["loading_chapter", "loading_document"].includes(status?.scroll?.state)) {
      const documentLoading = status.scroll.state === "loading_document";
      caption = documentLoading ? "文档正在加载，保留阅读进度" : "下一章正在加载，保留阅读进度";
      time = "加载中";
      textValue = true;
      indeterminate = true;
      progressLabel = documentLoading ? "文档内容加载状态" : "章节内容加载状态";
    } else if (phase === "waiting" && status?.flow?.embeddedActive && !videoProgress) {
      caption = "正在连接内嵌课程";
      time = "连接中";
      textValue = true;
      indeterminate = true;
      progressLabel = "内嵌课程连接状态";
    } else if (phase === "waiting_completion") {
      caption = videosCompleted ? `已播 ${videosCompleted} 段 · 等待平台确认完成` : "已到任务底部 · 等待平台确认完成";
      time = "待确认";
      textValue = true;
      progressLabel = "当前任务完成确认状态";
    } else if (phase === "completed") {
      caption = "当前任务已完成";
      time = "已完成";
      textValue = true;
      percent = 100;
      progressLabel = "当前任务完成状态";
    } else if (phase === "centering" && video) {
      caption = "确认视频居中后开始播放";
      time = "确认中";
      textValue = true;
      indeterminate = true;
      progressLabel = "正在确认视频位于阅读区域中间";
    } else if (videoProgress) {
      const current = Math.max(0, Number(status.videoCurrent) || 0);
      const duration = Number(status.videoDuration) || 0;
      caption = `本页视频 · 已播 ${videosCompleted} 段`;
      time = `${formatTime(current)} / ${duration > 0 && Number.isFinite(duration) ? formatTime(duration) : "--:--"}`;
      percent = duration > 0 ? current / duration * 100 : 0;
      progressLabel = "视频播放进度";
    } else if (status && ["reading", "paused", "blocked"].includes(phase)) {
      const scroll = status.scroll || {};
      const movements = Math.max(0, Math.floor(Number(scroll.movements) || 0));
      const total = Number(scroll.intervalSeconds) || state.settings.scrollIntervalSeconds;
      const next = scrollSeconds(status);
      caption = `距下次滚动 · 已滚动 ${movements} 次`;
      if (videosCompleted) caption = `下次滚动 · 已滚 ${movements} 次 · 已播 ${videosCompleted} 段`;
      time = Number.isFinite(next) ? formatTime(next) : "--:--";
      percent = Number.isFinite(next) && total > 0 ? (1 - next / total) * 100 : 0;
      if (phase === "paused") {
        caption = `滚动已暂停 · 已滚动 ${movements} 次`;
        time = "已暂停";
        textValue = true;
      } else if (phase === "blocked") {
        caption = `已滚动 ${movements} 次 · 等待处理`;
        time = "待操作";
        textValue = true;
        percent = 0;
      } else if (scroll.state === "bottom") {
        caption = `已滚动 ${movements} 次 · 等待任务完成确认`;
        time = "已到底";
        textValue = true;
        percent = 0;
      } else if (scroll.state === "disabled" || !state.settings.scrollEnabled) {
        caption = "滚动已关闭 · 可在设置中开启";
        time = "已关闭";
        textValue = true;
        percent = 0;
      } else if (["no_target", "unresponsive"].includes(scroll.state)) {
        caption = `已滚动 ${movements} 次 · 请检查正文区域`;
        time = "待操作";
        textValue = true;
        percent = 0;
      } else if (scroll.state === "expanding") {
        caption = `正在展开视频 · 已滚动 ${movements} 次`;
        time = "展开中";
        textValue = true;
        indeterminate = true;
      } else if (scroll.state === "moving" || Number.isFinite(next) && next <= 0) {
        caption = `正在向下滚动 · 已滚动 ${movements} 次`;
        time = "滚动中";
        textValue = true;
        indeterminate = true;
      } else if (!Number.isFinite(next)) {
        caption = status.flow?.embeddedActive ? "正在同步内嵌课程进度" : "等待下一次滚动";
        time = status.flow?.embeddedActive ? "同步中" : "待滚动";
        textValue = true;
        indeterminate = true;
      }
    } else if (phase === "detecting" || phase === "navigating") {
      caption = phase === "detecting" ? "正在读取页面内容" : "正在加载后续任务";
      time = "--:--";
      indeterminate = true;
      progressLabel = caption;
    }
    percent = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
    $("#progressCaption").textContent = caption;
    $("#timeDisplay").textContent = time;
    $("#timeDisplay").classList.toggle("is-video", videoProgress && !interTaskWaiting && !textValue);
    $("#timeDisplay").classList.toggle("is-status", textValue);
    $("#progressFill").style.width = `${percent}%`;
    $("#taskProgress").classList.toggle("is-indeterminate", indeterminate);
    $("#taskProgress").setAttribute("aria-label", progressLabel);
    $("#taskProgress").setAttribute("aria-busy", String(indeterminate));
    if (indeterminate) $("#taskProgress").removeAttribute("aria-valuenow");
    else $("#taskProgress").setAttribute("aria-valuenow", String(Math.round(percent)));
    $("#taskProgress").setAttribute("aria-valuetext", `${caption}，${time}`);
  }

  function render() {
    const status = state.status;
    const phase = status?.phase || "idle";
    const video = status?.taskType === "video";
    const interTaskWaiting = phase === "waiting" && Boolean(status?.nextAt);
    const active = Boolean(status?.running) && !["paused", "blocked", "error", "completed", "idle"].includes(phase);
    const resumable = ["paused", "blocked"].includes(phase);
    $("#phaseText").textContent = phase === "waiting" && status?.scroll?.state === "loading_document" ? "加载文档" :
      phase === "waiting" && status?.scroll?.state === "loading_chapter" ? "加载下一章" :
      phase === "waiting" && video && !interTaskWaiting ? "视频缓冲中" : phases[phase] || "准备就绪";
    $("#phaseLabel").classList.toggle("is-active", active);
    $("#phaseLabel").classList.toggle("is-problem", ["blocked", "error"].includes(phase));
    $("#taskType").textContent = typeLabels[status?.taskType] || "自动识别";
    $("#taskTitle").textContent = status?.title || "等待识别当前任务";
    $("#taskTitle").title = status?.title || "等待识别当前任务";
    $("#taskDetail").textContent = state.uiError || status?.detail || (!validTab() && state.ready ? "请先打开华为 ICT 学院的课程学习页面。" : (state.connection.available ? "点击开始，自动识别当前课程中的文本、文档或视频。" : state.connection.message) || "打开华为 ICT 学院课程，点击下方开始。");
    $("#taskDetail").title = $("#taskDetail").textContent;
    const additionalOrigins = Array.isArray(state.connection.additionalOrigins) ? state.connection.additionalOrigins : [];
    const showFramePermission = additionalOrigins.length > 0;
    $("#framePermissionRow").hidden = !showFramePermission;
    $(".task-panel").classList.toggle("has-frame-permission", showFramePermission);
    $("#grantFramesButton").disabled = state.pending;
    $("#grantFramesButton").title = `允许连接当前页面的文档或播放器：${additionalOrigins.join("、")}`;
    renderProgress();
    $("#mainLabel").textContent = state.pending ? "请稍候" : !state.ready ? "连接中" : active ? "暂停学习" : resumable ? (phase === "blocked" ? "重试继续" : "继续学习") : "开始学习";
    const icon = $("#mainIcon");
    if (active) setIcon(icon, [{ d: "M9 6v12M16 6v12", "stroke-width": 2.6 }]);
    else setIcon(icon, [{ d: "m9 5 11 7-11 7Z" }]);
    icon.classList.toggle("play-icon", !active);
    $("#mainButton").disabled = !state.ready || !validTab() || state.pending;
    $("#mainButton").setAttribute("aria-busy", String(state.pending));
    $("#stopButton").disabled = state.pending || !status || ["idle", "completed"].includes(phase);
    $("#restartButton").disabled = !state.ready || !validTab() || state.pending;
    $("#rescanButton").disabled = state.pending || !state.ready || !validTab();
    $("#scrollSummary").textContent = state.settings.scrollEnabled
      ? `${state.settings.readingSpeed === "fast" ? "快速 · " : ""}${state.settings.scrollIntervalSeconds} 秒 ±10%`
      : "已关闭";
    $("#nextSummary").textContent = state.settings.autoNext ? "已开启" : "已关闭";
    let domain = "请打开课程页面";
    try { domain = new URL(state.tab.url).hostname; } catch { /* Current page may not expose a URL. */ }
    $("#domainLabel").textContent = domain || "请打开课程页面";
    $("#domainLabel").title = state.connection.message || domain;
    $("#connectionDot").classList.toggle("is-connected", Boolean(state.connection.available && validTab()));
    renderHistory();
  }

  function showToast(message) {
    $("#toast").textContent = message;
    $("#toast").classList.add("is-visible");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => $("#toast").classList.remove("is-visible"), 3500);
  }

  async function refresh() {
    if (!state.tab?.id || state.pending || state.polling) return;
    state.polling = true;
    try {
      const response = await request({ type: "POPUP_STATUS", tabId: state.tab.id });
      state.status = response.status || null;
      state.settings = shared.normalizeSettings(response.settings || state.settings);
      state.permission = Boolean(response.permission);
      state.connection = response.connection || state.connection;
      if ($("#modalBackdrop").hidden) applyTheme();
      else applyTheme($("input[name='theme']:checked").value);
      render();
    } catch (error) {
      state.connection = { available: false, message: error.message };
      if (!state.status?.running) state.uiError = error.message;
      render();
    } finally { state.polling = false; }
  }

  async function control(action, permissionRequest = null, permissionError = "尚未获得当前网站的访问权限，请允许后再次开始。") {
    state.pending = true;
    state.uiError = null;
    render();
    try {
      if (permissionRequest && !(await permissionRequest)) throw new Error(permissionError);
      const response = await request({ type: "CONTROL", tabId: state.tab.id, action });
      if (response.status) state.status = response.status;
      state.permission ||= Boolean(permissionRequest);
      if (action === "restart") showToast("已回到当前任务顶部，本轮状态已清空。");
    } catch (error) {
      showToast(error.message);
      state.uiError = error.message;
    } finally {
      state.pending = false;
      render();
      await refresh();
    }
  }

  function fillSettings() {
    const settings = state.settings;
    const themeInput = $(`input[name="theme"][value="${settings.theme}"]`);
    themeInput.checked = true;
    $("#scrollIntervalSeconds").value = settings.scrollIntervalSeconds;
    ["scrollEnabled", "autoNext", "muteVideo"].forEach((key) => { $(`#${key}`).checked = settings[key]; });
    $("#readingSpeed").checked = settings.readingSpeed === "fast";
    $("#nextDelaySeconds").value = settings.nextDelaySeconds;
    Object.entries(selectorIds).forEach(([key, id]) => { $(`#${id}`).value = settings.selectors[key] || ""; $(`#${id}`).setCustomValidity(""); });
    $("#settingsError").hidden = true;
    $(".advanced-settings").open = false;
    updatePresets();
  }

  function updatePresets() {
    $$("[data-seconds]").forEach((button) => {
      const selected = Number(button.dataset.seconds) === Number($("#scrollIntervalSeconds").value);
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const seconds = Number($("#scrollIntervalSeconds").value);
    const valid = Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600;
    const display = (value) => Number(value.toFixed(1)).toLocaleString("zh-CN");
    $("#intervalHint").textContent = valid ? `每次等待约 ${display(seconds * .9)}–${display(seconds * 1.1)} 秒，再向下滚动一段；不按时间完成任务。` : "请输入 1–3600 秒。每次等待会在基准间隔上浮动 ±10%。";
  }

  function modalTransform() {
    const start = (state.trigger || $("#settingsButton")).getBoundingClientRect();
    const end = $("#settingsDialog").getBoundingClientRect();
    const dx = start.left + start.width / 2 - (end.left + end.width / 2);
    const dy = start.top + start.height / 2 - (end.top + end.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${Math.max(.08, start.width / end.width)}, ${Math.max(.06, start.height / end.height)})`;
  }

  async function openSettings(trigger) {
    state.modalToken += 1;
    state.modalAnimation?.cancel();
    state.trigger = trigger;
    fillSettings();
    $("#modalBackdrop").hidden = false;
    $("#appShell").inert = true;
    $("#settingsButton").setAttribute("aria-expanded", "true");
    $(".settings-scroll").scrollTop = 0;
    $("#settingsDialog").focus({ preventScroll: true });
    if (!reducedMotion.matches) {
      state.modalAnimation = $("#settingsDialog").animate([
        { transform: modalTransform(), opacity: .12, borderRadius: "40px" },
        { transform: "translate(0, 0) scale(1.012, 1.012)", opacity: 1, offset: .8 },
        { transform: "translate(0, 0) scale(1, 1)", opacity: 1, borderRadius: "25px" }
      ], { duration: 420, easing: "cubic-bezier(.2,.8,.25,1)" });
    }
    $("input[name='theme']:checked").focus({ preventScroll: true });
  }

  async function closeSettings() {
    if ($("#modalBackdrop").hidden) return;
    const token = ++state.modalToken;
    state.modalAnimation?.cancel();
    if (!reducedMotion.matches) {
      state.modalAnimation = $("#settingsDialog").animate([
        { transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
        { transform: modalTransform(), opacity: 0 }
      ], { duration: 190, easing: "cubic-bezier(.4,0,.8,.3)" });
      try { await state.modalAnimation.finished; } catch { /* An opening animation can supersede a close. */ }
    }
    if (token !== state.modalToken) return;
    $("#modalBackdrop").hidden = true;
    $("#appShell").inert = false;
    $("#settingsButton").setAttribute("aria-expanded", "false");
    applyTheme();
    (state.trigger || $("#settingsButton")).focus({ preventScroll: true });
  }

  async function saveSettings(event) {
    event.preventDefault();
    const errorElement = $("#settingsError");
    errorElement.hidden = true;
    const selectors = {};
    for (const [key, id] of Object.entries(selectorIds)) {
      const input = $(`#${id}`);
      const value = input.value.trim();
      input.setCustomValidity("");
      try { if (value) document.querySelector(value); }
      catch {
        $(".advanced-settings").open = true;
        input.setCustomValidity("请输入有效的 CSS 选择器。");
        input.reportValidity();
        return;
      }
      selectors[key] = value;
    }
    const settings = shared.normalizeSettings({
      ...state.settings,
      theme: $("input[name='theme']:checked").value,
      scrollIntervalSeconds: Number($("#scrollIntervalSeconds").value),
      scrollEnabled: $("#scrollEnabled").checked,
      autoNext: $("#autoNext").checked,
      muteVideo: $("#muteVideo").checked,
      nextDelaySeconds: Number($("#nextDelaySeconds").value),
      readingSpeed: $("#readingSpeed").checked ? "fast" : "standard",
      selectors
    });
    $("#saveSettings").disabled = true;
    try {
      const response = await request({ type: "SETTINGS_SAVE", settings });
      state.settings = shared.normalizeSettings(response.settings || settings);
      applyTheme();
      render();
      await closeSettings();
      showToast("设置已保存，后续滚动按新间隔等待。");
    } catch (error) {
      errorElement.textContent = error.message;
      errorElement.hidden = false;
      errorElement.scrollIntoView({ block: "nearest" });
    } finally { $("#saveSettings").disabled = false; }
  }

  async function copyDiagnostics() {
    if (!validTab()) { showToast("请先打开课程页面。"); return; }
    const button = $("#copyDiagnostics");
    button.disabled = true;
    try {
      const response = await request({ type: "GET_DIAGNOSTICS", tabId: state.tab.id });
      const output = $("#diagnosticOutput");
      const report = JSON.stringify(response.diagnostics, null, 2);
      output.value = report;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(report);
        output.hidden = true;
        showToast("识别诊断已复制，可粘贴用于排查。");
      } catch {
        output.hidden = false;
        output.focus();
        output.select();
        showToast("诊断已生成，请复制下方已选中的文本。");
      }
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  }

  function controlWithPermission(action) {
    if (state.pending || !validTab()) return;
    // Request within the button's user gesture before awaiting any other work.
    let permissionRequest = null;
    if (action !== "pause" && !state.permission) {
      try { permissionRequest = chrome.permissions.request({ origins: [`${new URL(state.tab.url).origin}/*`] }); }
      catch (error) { showToast(error.message); return; }
    }
    void control(action, permissionRequest);
  }

  function bindEvents() {
    $("#mainButton").addEventListener("click", () => {
      if (state.pending || !validTab()) return;
      const phase = state.status?.phase;
      const active = state.status?.running && !["paused", "blocked", "error", "completed", "idle"].includes(phase);
      const action = active ? "pause" : ["paused", "blocked"].includes(phase) ? "resume" : "start";
      controlWithPermission(action);
    });
    $("#stopButton").addEventListener("click", () => void control("stop"));
    $("#restartButton").addEventListener("click", () => controlWithPermission("restart"));
    $("#grantFramesButton").addEventListener("click", () => {
      if (state.pending || !validTab()) return;
      const origins = Array.isArray(state.connection.additionalOrigins) ? [...state.connection.additionalOrigins] : [];
      if (!origins.length) return;
      // Only the actual visible frame origins supplied by the coordinator are requested.
      let permissionRequest;
      try { permissionRequest = chrome.permissions.request({ origins }); }
      catch (error) { showToast(error.message); return; }
      void control("rescan", permissionRequest, "尚未获得内嵌文档或播放器的访问权限，请允许后再试。");
    });
    $("#rescanButton").addEventListener("click", () => {
      const action = !state.status || ["idle", "completed"].includes(state.status.phase) ? "start" : "rescan";
      controlWithPermission(action);
    });
    $("#themeButton").addEventListener("click", async () => {
      const previous = state.settings.theme;
      const next = { system: "light", light: "dark", dark: "system" }[previous];
      const settings = { ...state.settings, theme: next };
      state.settings = settings;
      applyTheme();
      try { await request({ type: "SETTINGS_SAVE", settings }); }
      catch (error) { state.settings.theme = previous; applyTheme(); showToast(error.message); }
    });
    $("#settingsButton").addEventListener("click", (event) => void openSettings(event.currentTarget));
    $("#closeSettings").addEventListener("click", () => void closeSettings());
    $("#cancelSettings").addEventListener("click", () => void closeSettings());
    $("#modalBackdrop").addEventListener("click", (event) => { if (event.target === $("#modalBackdrop")) void closeSettings(); });
    $("#settingsForm").addEventListener("submit", (event) => void saveSettings(event));
    $("#copyDiagnostics").addEventListener("click", () => void copyDiagnostics());
    $$("input[name='theme']").forEach((input) => input.addEventListener("change", () => applyTheme(input.value)));
    $$("[data-seconds]").forEach((button) => button.addEventListener("click", () => { $("#scrollIntervalSeconds").value = button.dataset.seconds; updatePresets(); }));
    $("#scrollIntervalSeconds").addEventListener("input", updatePresets);
    $$(".selector-input").forEach((input) => input.addEventListener("input", () => input.setCustomValidity("")));
    document.addEventListener("keydown", (event) => {
      if ($("#modalBackdrop").hidden) return;
      if (event.key === "Escape") { event.preventDefault(); void closeSettings(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...$("#settingsDialog").querySelectorAll('button:not(:disabled),input:not(:disabled),summary,[tabindex="0"]')].filter((element) => element.getClientRects().length && !element.closest("[hidden]"));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === $("#settingsDialog"))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    systemTheme.addEventListener("change", () => {
      const preview = $("#modalBackdrop").hidden ? state.settings.theme : $("input[name='theme']:checked").value;
      if (preview === "system") applyTheme("system");
    });
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === "STATUS_UPDATED" && message.tabId === state.tab?.id) {
        state.status = message.status || null;
        state.uiError = null;
        render();
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings?.newValue) {
        state.settings = shared.normalizeSettings(changes.settings.newValue);
        if ($("#modalBackdrop").hidden) applyTheme();
        render();
      }
    });
  }

  async function init() {
    bindEvents();
    try {
      const saved = await chrome.storage.local.get("settings");
      state.settings = shared.normalizeSettings(saved.settings || state.settings);
      applyTheme();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      state.tab = tab || null;
      await refresh();
    } catch (error) {
      state.connection = { available: false, message: "连接失败：请重新加载插件后再试。" };
      showToast(error.message);
    } finally {
      state.ready = true;
      render();
    }
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 1200);
    const progressInterval = setInterval(() => { if (!document.hidden) renderProgress(); }, 250);
    addEventListener("unload", () => { clearInterval(interval); clearInterval(progressInterval); }, { once: true });
  }

  void init();
})();
