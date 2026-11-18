"use strict";
(() => {
  const listeners = [];
  const video = document.querySelector("video");
  const report = (detail, extra = {}) => parent.postMessage({ fixture: "itc-frame-state", detail, ...extra }, location.origin);
  globalThis.chrome = { runtime: {
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      parent.postMessage({ fixture: "itc-frame-engine", message }, location.origin);
      return { ok: true };
    }
  } };
  addEventListener("message", event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.fixture !== "itc-frame-control") return;
    const { message, requestId } = event.data;
    if (!message || typeof requestId !== "string") return;
    let responded = false;
    const respond = result => { if (!responded) { responded = true; parent.postMessage({ fixture: "itc-frame-response", requestId, result }, location.origin); } };
    for (const listener of listeners) listener(message, {}, respond);
    if (!responded) respond({ ok: false, error: "Child engine not ready" });
  });
  video.addEventListener("play", () => { const rect = video.getBoundingClientRect(); report("真实 play 事件", { playCenter: rect.top + rect.height / 2 }); });
  video.addEventListener("ended", () => report("视频已结束，继续检查当前页面内容及平台完成状态"));
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
      drawing.fillStyle = "#a5caff"; drawing.font = "26px sans-serif"; drawing.fillText(`IFRAME VIDEO · ${++frame}`, 180, 190);
    }, 60);
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      clearInterval(draw); stream.getTracks().forEach(track => track.stop());
      video.src = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
      report("本地内嵌视频已就绪，可以开始");
    };
    recorder.start();
    setTimeout(() => recorder.stop(), 3100);
  }
  makeVideo().catch(error => report(`生成失败：${error.message}`));
})();
