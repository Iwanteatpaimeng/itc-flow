"use strict";
(() => {
  const query = new URL(location.href).searchParams;
  const child = query.get("embedded") === "1";
  const mode = query.get("mode") === "plain" ? "plain" : "textbook";
  const listeners = [];
  const ask = message => new Promise(resolve => {
    for (const listener of listeners) listener(message, {}, resolve);
    if (!listeners.length) resolve({ ok: false, error: "内容脚本未加载" });
  });
  if (child) {
    document.body.className = "course-frame";
    const thumbnail = '<svg class="catalog-thumb" viewBox="0 0 260 170" aria-label="目录装饰缩略图"><rect width="260" height="170" fill="#e0eafa"/><text x="22" y="88" fill="#45658f" font-size="24">虚构教材目录</text></svg>';
    const intro = "本页用于验证正文和目录使用不同的滚动组件。应逐段阅读右侧正文，左侧章节目录保留位置，正文到底以后也不能转而滚动目录。";
    document.body.innerHTML = '<div class="reader-web"><div class="reader-left reader-catalog"><div class="catalog-heading">目录 · 已完成 15%</div><div id="catalogScroll" class="el-scrollbar__wrap">' + thumbnail +
      Array.from({ length: 48 }, (_, i) => `<p class="catalog-item-row">第 ${i + 1} 节 虚构数据知识与课程说明 ${i % 3 ? "○" : "✓"}</p>`).join("") +
      '</div></div><div class="reader-right"><div class="reader-toolbar">搜索书　　划线　　笔记　　书签</div><div id="reader-container"><div id="reader-chapter-box"><div class="reader-chapter-content w-e-text"><h1>正文：独立滚动组件的阅读顺序</h1>' +
      Array.from({ length: 16 }, (_, i) => `<p>正文段落 ${i + 1}。${intro}${intro}</p>`).join("") + '</div></div></div></div></div><output id="childDiagnostic">等待内嵌课程运行</output>';
    const catalog = document.querySelector("#catalogScroll");
    const reader = document.querySelector("#reader-container");
    if (mode === "plain") { reader.id = "plain-reader"; reader.className = "reader-content"; }
    let catalogEvents = 0, readerEvents = 0, initialCatalog = 180, latest = null;
    catalog.scrollTop = initialCatalog;
    initialCatalog = catalog.scrollTop;
    const post = data => parent.postMessage({ fixture: "catalog-fixture", ...data }, "*");
    const geometry = () => {
      const data = { kind: "geometry", mode, catalogPosition: Math.round(catalog.scrollTop), initialCatalog,
        catalogMaximum: catalog.scrollHeight - catalog.clientHeight, readerPosition: Math.round(reader.scrollTop),
        readerMaximum: reader.scrollHeight - reader.clientHeight, frameOuter: document.scrollingElement.scrollTop,
        catalogEvents, readerEvents };
      document.querySelector("#childDiagnostic").textContent = `目录 ${data.catalogPosition}/${initialCatalog} · 正文 ${data.readerPosition}/${data.readerMaximum}`;
      post(data);
    };
    globalThis.chrome = { runtime: { onMessage: { addListener(listener) { listeners.push(listener); } },
      async sendMessage(message) {
        if (message.type === "ENGINE_EMBEDDED_PROGRESS") latest = message.snapshot;
        post({ kind: "engine", message });
        return { ok: true };
      } } };
    addEventListener("message", event => {
      if (event.source !== parent || event.data?.fixture !== "catalog-command") return;
      void ask(event.data.message).then(result => { post({ kind: "reply", requestId: event.data.requestId, result }); geometry(); });
    });
    catalog.addEventListener("scroll", () => { catalogEvents++; geometry(); }, { passive: true });
    reader.addEventListener("scroll", () => { readerEvents++; geometry(); }, { passive: true });
    setInterval(geometry, 250);
    addEventListener("load", geometry, { once: true });
    geometry();
    return;
  }
  const frame = document.querySelector("#catalogCourseFrame"), requests = new Map(), ready = new Set(), entries = new Map();
  const settings = { scrollIntervalSeconds: 1, scrollEnabled: true, autoNext: false, selectors: {} };
  const counters = { ownerRuns: 0, childRuns: 0, returns: 0, changes: 0 };
  let active = false, latest = null, checkpoint = null, sequence = 0, requestSequence = 0, runId = "", geometry = null;
  const trace = message => { const out = document.querySelector("#catalogTrace"); out.textContent = (out.textContent + `\n${message}`).split("\n").slice(-32).join("\n"); };
  const update = () => {
    const outer = Math.round(document.scrollingElement.scrollTop), g = geometry;
    document.querySelector("#catalogState").textContent = latest ? `${latest.phase} · ${latest.detail}` : "等待开始";
    document.querySelector("#catalogGeometry").textContent = g ? `模式 ${mode} · 目录 ${g.catalogPosition}/${g.initialCatalog} · 正文 ${g.readerPosition}/${g.readerMaximum} · 外页 ${outer}/149 · 子页外层 ${g.frameOuter} · 目录事件 ${g.catalogEvents} · 正文事件 ${g.readerEvents}` : "等待课程布局";
    document.querySelector("#catalogIdentity").textContent = `owner RUN ${counters.ownerRuns} · child RUN ${counters.childRuns} · RETURN ${counters.returns} · CHANGE ${counters.changes} · run ${runId} · 已滚 ${latest?.scroll?.movements ?? 0} 次`;
    const deadline = latest?.scroll?.nextAt;
    document.querySelector("#catalogTiming").textContent = deadline ? `距下次滚动 ${Math.max(0, (deadline - Date.now()) / 1000).toFixed(1)} 秒` : `状态 ${latest?.scroll?.state ?? "idle"}`;
    const result = document.querySelector("#catalogResult");
    result.textContent = !g ? "等待验证" : g.catalogPosition !== g.initialCatalog || outer !== 149 || g.frameOuter !== 0 ? "失败：目录或外层页面发生移动" : g.readerPosition >= g.readerMaximum - 2 && counters.returns > 0 ? "通过：正文已到底，目录与外页保持不动" : g.readerPosition > 0 ? "验证中：只滚正文，目录与外页保持不动" : "等待正文首次滚动";
    if (g) Object.assign(result.dataset, { catalogPosition: String(g.catalogPosition), initialCatalog: String(g.initialCatalog),
      readerPosition: String(g.readerPosition), readerMaximum: String(g.readerMaximum), outerPosition: String(outer),
      catalogStable: String(g.catalogPosition === g.initialCatalog), ownerRuns: String(counters.ownerRuns),
      childRuns: String(counters.childRuns), returns: String(counters.returns), phase: latest?.phase || "idle" });
  };
  const callChild = message => new Promise(resolve => {
    const requestId = `catalog-${++requestSequence}`;
    const timer = setTimeout(() => { requests.delete(requestId); resolve({ ok: false, error: "子页面响应超时" }); }, 5000);
    requests.set(requestId, { resolve, timer });
    frame.contentWindow.postMessage({ fixture: "catalog-command", requestId, message }, "*");
  });
  async function startChild(token) {
    const entry = entries.get(token);
    if (!active || !entry || !ready.has(token) || entry.started) return;
    entry.started = true; counters.childRuns++;
    await callChild({ type: "ENGINE_PROBE", settings, viewportEnabled: true });
    const result = await callChild({ type: "ENGINE_EMBEDDED_RUN", token, runId, settings, resetPosition: entry.resetPosition });
    trace(`内嵌正文 RUN · reset ${entry.resetPosition} · ${result.ok ? "成功" : result.error}`); update();
  }
  async function route(owner, message) {
    if (message.type === "ENGINE_EMBEDDED_READY") { ready.add(message.token); await startChild(message.token); return; }
    if (message.runId && message.runId !== runId) return;
    if (message.type === "ENGINE_EMBEDDED_REQUEST" && active && owner === "owner") {
      entries.set(message.token, { resetPosition: message.resetPosition !== false }); await startChild(message.token);
    }
    if (message.type === "ENGINE_EMBEDDED_PROGRESS" && active && entries.get(message.token)?.started)
      await ask({ type: "ENGINE_EMBEDDED_STATUS", token: message.token, runId, snapshot: message.snapshot });
    if (message.type === "ENGINE_EMBEDDED_DONE" && active && entries.get(message.token)?.started) {
      entries.delete(message.token); counters.returns++; trace("正文读到底，返回外层课程；目录不可接管");
      await ask({ type: "ENGINE_EMBEDDED_RETURN", token: message.token, runId, ok: true, snapshot: message.snapshot });
    }
    if (message.type === "ENGINE_PROGRESS" && owner === "owner" && message.snapshot.runId === runId) latest = checkpoint = message.snapshot;
    if (message.type === "ENGINE_CHANGED") { counters.changes++; trace(`${owner} CHANGE · ${message.candidate?.type || "无候选"}`); }
    update();
  }
  globalThis.chrome = { runtime: { onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) { void route("owner", message); return { ok: true }; } } };
  addEventListener("message", event => {
    if (event.source !== frame.contentWindow || event.data?.fixture !== "catalog-fixture") return;
    const data = event.data;
    if (data.kind === "reply") { const pending = requests.get(data.requestId); if (pending) { clearTimeout(pending.timer); requests.delete(data.requestId); pending.resolve(data.result); } }
    else if (data.kind === "engine") void route("reader", data.message);
    else if (data.kind === "geometry") { geometry = data; update(); }
  });
  async function control(action) {
    active = false;
    const stopped = await Promise.all([ask({ type: "ENGINE_PAUSE" }), callChild({ type: "ENGINE_PAUSE" })]);
    checkpoint = stopped[0]?.snapshot || checkpoint;
    if (action === "pause") { latest = checkpoint; trace("暂停并保留正文位置"); update(); return; }
    if (action === "stop") { await Promise.all([ask({ type: "ENGINE_STOP" }), callChild({ type: "ENGINE_STOP" })]); trace("已停止"); update(); return; }
    const fresh = action !== "resume";
    if (fresh) checkpoint = null;
    entries.clear(); ready.clear(); active = true; runId = `catalog-run-${++sequence}`; counters.ownerRuns++;
    await ask({ type: "ENGINE_PROBE", settings, viewportEnabled: true });
    await callChild({ type: "ENGINE_PROBE", settings, viewportEnabled: true });
    const result = await ask({ type: "ENGINE_RUN", settings, checkpoint, runId, resetPosition: fresh });
    trace(`${fresh ? "从正文顶部开始" : "继续正文"} · ${result.ok ? "成功" : result.error}`); update();
  }
  for (const button of document.querySelectorAll("[data-action]")) button.addEventListener("click", () => void control(button.dataset.action));
  const source = new URL(location.href); source.searchParams.set("embedded", "1"); source.searchParams.set("mode", mode);
  frame.src = source.href;
  addEventListener("load", () => { scrollTo({ top: 149, behavior: "instant" }); update(); }, { once: true });
  setInterval(update, 200);
})();
