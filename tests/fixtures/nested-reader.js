"use strict";
(() => {
  const listeners = [];
  const shell = document.querySelector("#layoutShell");
  const surface = document.querySelector("#hiddenSurface");
  const reader = document.querySelector("#actualReader");
  const body = document.querySelector("#actualText");
  const paragraph = "计算机网络通过不同协议层把数据传递到目的设备。阅读时需要先理解地址、链路、路由和可靠性各自承担的职责，再把这些概念和实际故障排查联系起来。课程正文可能被多个布局元素包裹，而真正负责滚动的是最靠近正文的可滚容器。";
  for (let index = 0; index < 22; index++) {
    const p = document.createElement("p");
    p.textContent = `${index + 1}. ${paragraph}`;
    body.append(p);
  }
  let sequence = 0;
  let runId = "";
  let checkpoint = null;
  let active = false;
  let completed = 0;
  let expectedOuterY = 180;
  const trace = message => { const output = document.querySelector("#nestedTrace"); output.textContent = (output.textContent + `\n${new Date().toLocaleTimeString()} ${message}`).split("\n").slice(-12).join("\n"); };
  const positions = () => {
    document.querySelector("#nestedPositions").textContent = `外页 ${Math.round(scrollY)} / 预期 ${expectedOuterY} · 橙壳 ${Math.round(shell.scrollTop)} · 内隐藏壳 ${Math.round(surface.scrollTop)} · 蓝框正文 ${Math.round(reader.scrollTop)} / ${Math.round(reader.scrollHeight - reader.clientHeight)}`;
  };
  const ask = message => new Promise(resolve => { listeners.forEach(listener => listener(message, {}, resolve)); if (!listeners.length) resolve({ ok:false, error:"内容引擎未就绪" }); });
  globalThis.chrome = { runtime: { onMessage: { addListener(listener) { listeners.push(listener); } }, async sendMessage(message) {
    if (message.type === "ENGINE_PROGRESS" && message.snapshot.runId === runId) { checkpoint = message.snapshot; document.querySelector("#nestedState").textContent = `${checkpoint.phase} · ${checkpoint.detail}`; positions(); }
    if (message.type === "ENGINE_DONE" && active && message.runId === runId) { active = false; completed++; document.querySelector("#nestedCount").textContent = `已完成任务：${completed}`; trace("正文已到底且平台确认完成"); }
    return { ok:true };
  } } };
  async function start(fresh) {
    active = false;
    await ask({ type:"ENGINE_STOP" });
    runId = `nested-fixture-${++sequence}`;
    if (fresh) { checkpoint = null; completed = 0; document.querySelector("#nestedCount").textContent = "已完成任务：0"; }
    const selectors = { document:document.querySelector("#nestedCustomDocument").checked ? "#actualText" : "", completed:"#nestedCompleteMarker", scroll:document.querySelector("#nestedCustomRoot").checked ? "#layoutShell" : "" };
    active = true;
    const result = await ask({ type:"ENGINE_RUN", runId, checkpoint, resetPosition:fresh, settings:{ scrollIntervalSeconds:1, scrollEnabled:true, selectors } });
    if (!result?.ok) { active = false; trace(result?.error || "启动失败"); }
    trace(fresh ? "开始：仅正文回顶并向下滚动" : "继续：保留正文位置"); positions();
  }
  document.querySelector("#nestedStart").addEventListener("click", () => void start(true));
  document.querySelector("#nestedRestart").addEventListener("click", () => void start(true));
  document.querySelector("#nestedResume").addEventListener("click", () => void start(false));
  document.querySelector("#nestedPause").addEventListener("click", async () => { active=false; const result=await ask({type:"ENGINE_PAUSE"}); checkpoint=result.snapshot || checkpoint; trace("已暂停"); });
  document.querySelector("#nestedStop").addEventListener("click", async () => { active=false; await ask({type:"ENGINE_STOP"}); trace("已停止"); });
  document.querySelector("#nestedComplete").addEventListener("change", event => { document.querySelector("#nestedCompleteMarker").hidden=!event.target.checked; trace(`平台确认完成：${event.target.checked}`); });
  [shell,surface,reader].forEach(node => node.addEventListener("scroll", positions, {passive:true}));
  addEventListener("scroll", positions, {passive:true});
  addEventListener("load", () => { scrollTo({top:180,behavior:"instant"}); expectedOuterY=scrollY; positions(); });
})();
