"use strict";
// Development-only coordinator for the actual owner and embedded content runners.
(() => {
  const listeners = [];
  const frame = document.querySelector("#lessonFrame");
  const childResponses = new Map();
  const readyTokens = new Set();
  const tracedRegions = new Set();
  let ownerRunId = "";
  let ownerSnapshot = null;
  let checkpoint = null;
  let pending = null;
  let active = false;
  let sequence = 0;
  let completedCount = 0;
  const settings = { scrollIntervalSeconds: 1, scrollEnabled: true, muteVideo: true, selectors: { completed: "#frameCompleteMarker" } };
  const trace = detail => {
    const output = document.querySelector("#frameTrace");
    output.textContent = (output.textContent + `\n${new Date().toLocaleTimeString()} ${detail}`).split("\n").slice(-9).join("\n");
  };
  const render = () => {
    if (ownerSnapshot) document.querySelector("#frameState").textContent = `${ownerSnapshot.phase} · ${ownerSnapshot.detail} · 已处理视频 ${ownerSnapshot.flow?.videosCompleted || 0}`;
    document.querySelector("#frameCount").textContent = `已完成任务：${completedCount}`;
  };
  const ask = message => new Promise(resolve => {
    for (const listener of listeners) listener(message, {}, resolve);
    if (!listeners.length) resolve({ ok: false, error: "Owner engine not ready" });
  });
  const askChild = message => new Promise(resolve => {
    const requestId = `fixture-control-${++sequence}`;
    const timer = setTimeout(() => { childResponses.delete(requestId); resolve({ ok: false, error: "子框架响应超时" }); }, 5000);
    childResponses.set(requestId, { resolve, timer });
    frame.contentWindow.postMessage({ fixture: "itc-frame-control", requestId, message }, location.origin);
  });
  async function pairEmbedded() {
    if (!active || !pending || pending.started || !readyTokens.has(pending.token)) return;
    const current = pending;
    current.started = true;
    current.childRunId = `${ownerRunId}:embedded:${++sequence}`;
    trace("REQUEST + READY 已配对，启动内嵌片段");
    const result = await askChild({ type: "ENGINE_EMBEDDED_RUN", token: current.token, runId: current.childRunId, resetPosition: current.resetPosition, settings });
    if (pending !== current || !active) return;
    if (!result?.ok) {
      trace(`内嵌片段启动失败：${result?.error || "未知原因"}`);
      await ask({ type: "ENGINE_EMBEDDED_RETURN", token: current.token, runId: ownerRunId, ok: false, detail: result?.error });
    }
  }
  globalThis.chrome = { runtime: {
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      if (message.type === "ENGINE_PROGRESS" && message.snapshot.runId === ownerRunId) {
        ownerSnapshot = message.snapshot;
        checkpoint = message.snapshot;
        render();
      }
      if (message.type === "ENGINE_EMBEDDED_REQUEST" && active && message.runId === ownerRunId) {
        pending = { ...message, started: false };
        trace("父页面已逐步读到 iframe，发送 REQUEST");
        void pairEmbedded();
      }
      if (message.type === "ENGINE_DONE" && active && message.runId === ownerRunId) {
        active = false;
        completedCount++;
        trace("父页面尾文已读完 + 平台确认完成，任务 DONE");
        render();
      }
      return { ok: true };
    }
  } };
  addEventListener("message", event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.fixture === "itc-frame-response") {
      const response = childResponses.get(data.requestId);
      if (response) { clearTimeout(response.timer); childResponses.delete(data.requestId); response.resolve(data.result); }
      return;
    }
    if (data?.fixture === "itc-frame-state") {
      if (data.detail) trace(data.detail);
      if (data.playCenter !== undefined) {
        const bounds = frame.getBoundingClientRect();
        const projected = bounds.top + frame.clientTop + data.playCenter;
        document.querySelector("#frameGeometry").textContent = `真实播放时播放器中心 ${Math.round(projected)}px；浏览器中心 ${Math.round(innerHeight / 2)}px`;
      }
      return;
    }
    if (data?.fixture !== "itc-frame-engine") return;
    const message = data.message;
    if (message.type === "ENGINE_EMBEDDED_READY") { readyTokens.add(message.token); void pairEmbedded(); return; }
    if (!active || !pending || message.token !== pending.token || message.runId !== pending.childRunId) return;
    const current = pending;
    if (message.type === "ENGINE_EMBEDDED_PROGRESS") {
      void ask({ type: "ENGINE_EMBEDDED_STATUS", token: current.token, runId: ownerRunId, snapshot: message.snapshot });
    }
    if (message.type === "ENGINE_EMBEDDED_DONE") {
      pending = null;
      trace("子框架 DONE，RETURN 归还父页面继续尾文");
      void ask({ type: "ENGINE_EMBEDDED_RETURN", token: current.token, runId: ownerRunId, ok: true, snapshot: message.snapshot });
    }
  });
  async function start(resetPosition) {
    active = false; pending = null;
    await askChild({ type: "ENGINE_STOP" });
    await ask({ type: "ENGINE_STOP" });
    ownerRunId = `fixture-owner-${++sequence}`;
    settings.scrollIntervalSeconds = Math.max(1, Math.min(30, Number(document.querySelector("#frameInterval").value) || 1));
    if (resetPosition) { checkpoint = null; ownerSnapshot = null; completedCount = 0; readyTokens.clear(); tracedRegions.clear(); document.querySelector("#frameTrace").textContent = "从当前任务顶部开始"; }
    active = true;
    const result = await ask({ type: "ENGINE_RUN", settings, runId: ownerRunId, resetPosition, checkpoint });
    if (!result?.ok) { active = false; trace(result?.error || "启动失败"); }
    render();
  }
  document.querySelector("#frameStart").addEventListener("click", () => void start(true));
  document.querySelector("#frameRestart").addEventListener("click", () => void start(true));
  document.querySelector("#frameResume").addEventListener("click", () => void start(false));
  document.querySelector("#framePause").addEventListener("click", async () => {
    active = false;
    const paused = await ask({ type: "ENGINE_PAUSE" });
    checkpoint = paused.snapshot || checkpoint;
    await askChild({ type: "ENGINE_PAUSE" });
    pending = null;
    trace("父页面和内嵌片段已暂停，保留位置与已处理记录");
  });
  document.querySelector("#frameStop").addEventListener("click", async () => {
    active = false; pending = null;
    await ask({ type: "ENGINE_STOP" });
    await askChild({ type: "ENGINE_STOP" });
    trace("已停止");
  });
  document.querySelector("#frameCompleteCheck").addEventListener("change", event => {
    document.querySelector("#frameCompleteMarker").hidden = !event.target.checked;
    trace(`平台确认当前任务完成：${event.target.checked}`);
  });
  addEventListener("scroll", () => {
    for (const region of document.querySelectorAll("[data-read-order]")) {
      const bounds = region.getBoundingClientRect();
      if (bounds.top <= innerHeight / 2 && bounds.bottom >= innerHeight / 2 && !tracedRegions.has(region)) {
        tracedRegions.add(region);
        trace(`${region.dataset.readOrder} 已经过屏幕中间`);
      }
    }
  }, { passive: true });
})();
