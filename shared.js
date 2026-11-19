/* Shared, dependency-free configuration for the service worker and popup. */
(() => {
  "use strict";
  if (globalThis.StudyShared) return;
  const DEFAULTS = Object.freeze({
    theme: "system", scrollIntervalSeconds: 10, scrollEnabled: true, autoNext: true, muteVideo: true, nextDelaySeconds: 3, readingSpeed: "fast",
    selectors: Object.freeze({ video: "", document: "", scroll: "", next: "", task: "", activeTask: "", completed: "" })
  });
  function numberInRange(value, fallback, min, max) {
    if (value === null || value === "" || typeof value === "boolean") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(Math.min(max, Math.max(min, number))) : fallback;
  }
  function normalizeSettings(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    return {
      theme: ["system", "light", "dark"].includes(source.theme) ? source.theme : DEFAULTS.theme,
      scrollIntervalSeconds: numberInRange(source.scrollIntervalSeconds, DEFAULTS.scrollIntervalSeconds, 1, 3600),
      scrollEnabled: typeof source.scrollEnabled === "boolean" ? source.scrollEnabled : DEFAULTS.scrollEnabled,
      autoNext: typeof source.autoNext === "boolean" ? source.autoNext : DEFAULTS.autoNext,
      muteVideo: typeof source.muteVideo === "boolean" ? source.muteVideo : DEFAULTS.muteVideo,
      nextDelaySeconds: numberInRange(source.nextDelaySeconds, DEFAULTS.nextDelaySeconds, 0, 30),
      readingSpeed: ["standard", "fast"].includes(source.readingSpeed) ? source.readingSpeed : DEFAULTS.readingSpeed,
      selectors: Object.fromEntries(Object.keys(DEFAULTS.selectors).map(key => [key,
        typeof source.selectors?.[key] === "string" ? source.selectors[key].trim().slice(0, 1000) : ""
      ]))
    };
  }
  function formatTime(seconds = 0) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
  }
  function typeLabel(type) {
    return ({ video: "视频", document: "文档", text: "文本", unknown: "待识别" })[type] || "待识别";
  }
  globalThis.StudyShared = Object.freeze({ DEFAULTS, normalizeSettings, formatTime, typeLabel });
})();
