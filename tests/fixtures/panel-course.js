"use strict";
// This shim uses the actual content runner; it never ships in the extension.
(() => {
  const listeners = [];
  const panel = document.querySelector("#lessonPanel");
  const video = document.querySelector("#panelVideo");
  const traced = new Set();
  const settings = { scrollIntervalSeconds: 1, scrollEnabled: true, muteVideo: true, selectors: { completed: "#panelCompleteMarker" } };
  let runId = "";
  let checkpoint = null;
  let active = false;
  let count = 0;
  let runSequence = 0;
  let expectedOuterY = 180;
  const trace = message => {
    const output = document.querySelector("#panelTrace");
    output.textContent = (output.textContent + `\n${new Date().toLocaleTimeString()} ${message}`).split("\n").slice(-12).join("\n");
  };
  const ask = message => new Promise(resolve => {
    for (const listener of listeners) listener(message, {}, resolve);
    if (!listeners.length) resolve({ ok: false, error: "Engine not ready" });
  });
  const positions = () => {
    const changed = Math.abs(scrollY - expectedOuterY) > 1;
    document.querySelector("#panelPositions").textContent = `外页 scrollY ${Math.round(scrollY)} / 预期 ${expectedOuterY}${changed ? "（外页已移动）" : "（保持不变）"} · 右侧面板 scrollTop ${Math.round(panel.scrollTop)} / ${Math.round(panel.scrollHeight - panel.clientHeight)}`;
  };
  globalThis.chrome = { runtime: {
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      if (message.type === "ENGINE_PROGRESS" && message.snapshot.runId === runId) {
        checkpoint = message.snapshot;
        document.querySelector("#panelState").textContent = `${checkpoint.phase} · ${checkpoint.detail}`;
        positions();
      }
      if (message.type === "ENGINE_DONE" && active && message.runId === runId) {
        active = false;
        count++;
        document.querySelector("#panelCount").textContent = `已完成任务：${count}`;
        trace("面板尾文走完 + 平台确认完成，任务 DONE");
      }
      return { ok: true };
    }
  } };
  async function start(resetPosition) {
    active = false;
    await ask({ type: "ENGINE_STOP" });
    runId = `panel-run-${++runSequence}`;
    settings.scrollIntervalSeconds = Math.max(1, Math.min(30, Number(document.querySelector("#panelInterval").value) || 1));
    if (resetPosition) { checkpoint = null; count = 0; traced.clear(); document.querySelector("#panelCount").textContent = "已完成任务：0"; document.querySelector("#panelTrace").textContent = "从课程面板顶部开始"; }
    active = true;
    const result = await ask({ type: "ENGINE_RUN", settings, runId, checkpoint, resetPosition });
    if (!result?.ok) { active = false; trace(result?.error || "启动失败"); }
    positions();
  }
  document.querySelector("#panelStart").addEventListener("click", () => void start(true));
  document.querySelector("#panelRestart").addEventListener("click", () => void start(true));
  document.querySelector("#panelResume").addEventListener("click", () => void start(false));
  document.querySelector("#panelPause").addEventListener("click", async () => {
    active = false;
    const result = await ask({ type: "ENGINE_PAUSE" });
    checkpoint = result.snapshot || checkpoint;
    trace("暂停，保留课程面板当前位置");
  });
  document.querySelector("#panelStop").addEventListener("click", async () => {
    active = false;
    await ask({ type: "ENGINE_STOP" });
    document.querySelector("#panelState").textContent = "已停止";
    trace("停止");
  });
  document.querySelector("#panelCompleteCheck").addEventListener("change", event => {
    document.querySelector("#panelCompleteMarker").hidden = !event.target.checked;
    trace(`平台确认完成：${event.target.checked}`);
  });
  panel.addEventListener("scroll", () => {
    positions();
    const bounds = panel.getBoundingClientRect();
    const center = (Math.max(0, bounds.top) + Math.min(innerHeight, bounds.bottom)) / 2;
    for (const region of panel.querySelectorAll("[data-read-order]")) {
      const rect = region.getBoundingClientRect();
      if (rect.top <= center && rect.bottom >= center && !traced.has(region)) { traced.add(region); trace(`${region.dataset.readOrder} 经过面板中间`); }
    }
  }, { passive: true });
  addEventListener("scroll", positions, { passive: true });
  video.addEventListener("play", () => {
    const media = video.getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const mediaCenter = media.top + media.height / 2;
    const paneCenter = (Math.max(0, bounds.top) + Math.min(innerHeight, bounds.bottom)) / 2;
    document.querySelector("#panelGeometry").textContent = `真实播放：视频中心 ${Math.round(mediaCenter)}px · 面板可见中心 ${Math.round(paneCenter)}px · 浏览器中心 ${Math.round(innerHeight / 2)}px`;
    trace(`真实 video play，面板中心差 ${Math.round(mediaCenter - paneCenter)}px`);
  });
  video.addEventListener("ended", () => trace("真实 video ended，继续面板尾文"));
  addEventListener("load", () => {
    window.scrollTo({ top: expectedOuterY, behavior: "instant" });
    expectedOuterY = scrollY;
    panel.scrollTop = 300;
    positions();
  });
  async function makeVideo() {
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 360;
    const drawing = canvas.getContext("2d");
    const stream = canvas.captureStream(15);
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    let frame = 0;
    const draw = setInterval(() => {
      drawing.fillStyle = "#101827"; drawing.fillRect(0, 0, 640, 360);
      drawing.fillStyle = "#a5caff"; drawing.font = "24px sans-serif"; drawing.fillText(`PANEL VIDEO · ${++frame}`, 190, 190);
    }, 60);
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => { clearInterval(draw); stream.getTracks().forEach(track => track.stop()); video.src = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType })); trace("本地 3 秒视频已就绪"); document.querySelector("#panelState").textContent = "视频已就绪，可从课程顶部开始"; };
    recorder.start();
    setTimeout(() => recorder.stop(), 3100);
  }
  makeVideo().catch(error => trace(`视频生成失败：${error.message}`));
})();
