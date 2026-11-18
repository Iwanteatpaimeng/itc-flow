"use strict";

// Development-only Chrome API shim. Never shipped in the extension.
(() => {
  const runtimeListeners = [];
  const storageListeners = [];
  const query = new URL(location.href).searchParams;
  const ownedMode=query.get("owned")==="1",ownedChannel=ownedMode?new BroadcastChannel("itc-owned-preview"):null,ownedRequests=new Map();
  let ownedSequence=0;
  let settings = {
    theme: query.get("theme") || "system", scrollIntervalSeconds: 10, scrollEnabled: true, autoNext: true,
    muteVideo: true, nextDelaySeconds: 3, selectors: { video: "", document: "", next: "", task: "", activeTask: "", completed: "" }
  };
  const initialPhase = query.get("phase") || "idle";
  let status = initialPhase === "idle" ? null : {
    phase: initialPhase, running: !["paused", "blocked", "completed", "error"].includes(initialPhase),
    taskType: ["playing", "centering"].includes(initialPhase) ? "video" : "document", title: "网络基础：理解数据如何抵达", detail: "按页面顺序学习，每次滚动后检测后续内容",
    remainingSeconds: null, elapsedSeconds: 36, videoCurrent: 36, videoDuration: 240,
    scroll: { enabled: true, state: query.get("scroll") || "scheduled", movements: 3, nextInSeconds: 7, intervalSeconds: 10, nextAt: Date.now() + 7000, sampledAt: Date.now() },
    flow: { playedMediaIds: ["fixture-first-video"], videosCompleted: 1, atEnd: initialPhase === "waiting_completion", taskCompleteConfirmed: false, embeddedActive: false, role: "owner" },
    completedCount: 2, history: [{ title: "认识计算机网络", type: "text", at: Date.now() - 240_000 }, { title: "数字世界的第一步", type: "video", at: Date.now() - 480_000 }],
    updatedAt: Date.now(), url: "https://e.huawei.com/cn/talent/ict-academy/"
  };
  if (status?.phase === "blocked") { status.detail = "浏览器阻止了自动播放，请在课程播放器中点击一次播放"; status.scroll.nextAt = null; }
  if (status?.phase === "centering") { status.detail = "正在将播放器移到屏幕中间，居中后开始播放"; status.scroll.state = "video"; status.scroll.nextAt = null; }
  if (status?.phase === "waiting_completion") { status.detail = "本项内容已读到底，等待平台确认当前任务完成"; status.scroll.state = "bottom"; status.scroll.nextInSeconds = 0; status.scroll.nextAt = null; }
  if (status?.scroll.state === "bottom") { status.detail = "已滚动到底，等待页面显示完成或手动切换"; status.scroll.nextInSeconds = null; status.scroll.nextAt = null; }
  const tab = { id: 7, url: "https://e.huawei.com/cn/talent/ict-academy/", title: "华为 ICT 学院" };
  const publish = () => runtimeListeners.forEach((listener) => listener({ type: "STATUS_UPDATED", tabId: 7, status: structuredClone(status) }));
  const response = () => ({ ok: true, settings: structuredClone(settings), status: structuredClone(status), permission: true, connection: { available: true, message: "已就绪" } });
  if(ownedMode){
    status=null;
    ownedChannel.addEventListener("message",event=>{
      const data=event.data;
      if(data?.kind==="status"){
        status=data.status?structuredClone(data.status):null;
        if(data.settings)settings={...settings,...data.settings,selectors:{...settings.selectors,...data.settings.selectors}};
        publish();
      }
      if(data?.kind==="command-result"){
        const pending=ownedRequests.get(data.requestId);if(!pending)return;
        ownedRequests.delete(data.requestId);clearTimeout(pending.timer);pending.resolve(data.ok?response():{ok:false,error:data.error});
      }
    });
    ownedChannel.postMessage({kind:"request-status"});
    addEventListener("unload",()=>ownedChannel.close(),{once:true});
  }
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      async sendMessage(message) {
        if (message.type === "POPUP_STATUS") return response();
        if (message.type === "SETTINGS_SAVE") {
          settings = structuredClone(message.settings);
          storageListeners.forEach((listener) => listener({ settings: { newValue: settings } }, "local"));
          return response();
        }
        if (message.type === "CONTROL") {
          if(ownedMode)return new Promise(resolve=>{
            const requestId=`popup-owned-${++ownedSequence}`,timer=setTimeout(()=>{ownedRequests.delete(requestId);resolve({ok:false,error:"请先打开真实 owner 委托教材验证页"});},10000);
            ownedRequests.set(requestId,{resolve,timer});ownedChannel.postMessage({kind:"command",requestId,action:message.action});
          });
          if (["start", "restart"].includes(message.action) || message.action === "rescan" && !status) {
            status = { phase: "reading", running: true, taskType: "text", title: "网络基础：理解数据如何抵达", detail: "已从本项顶部开始，按页面顺序学习", remainingSeconds: null, elapsedSeconds: 0, videoCurrent: 0, videoDuration: 0, scroll: { enabled: settings.scrollEnabled, state: settings.scrollEnabled ? "scheduled" : "disabled", movements: 0, nextInSeconds: settings.scrollIntervalSeconds, intervalSeconds: settings.scrollIntervalSeconds, nextAt: settings.scrollEnabled ? Date.now() + settings.scrollIntervalSeconds * 1000 : null, sampledAt: Date.now() }, flow: { playedMediaIds: [], videosCompleted: 0, atEnd: false, taskCompleteConfirmed: false, embeddedActive: false, role: "owner" }, completedCount: 0, history: [], updatedAt: Date.now(), url: tab.url };
          } else if (message.action === "pause" && status) {
            status.phase = "paused"; status.running = false; status.detail = "已暂停，可随时继续。"; status.scroll.nextInSeconds = status.scroll.nextAt ? Math.max(0, (status.scroll.nextAt - Date.now()) / 1000) : 0; status.scroll.nextAt = null;
          } else if (message.action === "stop" && status) {
            status.phase = "idle"; status.running = false; status.detail = "已停止；再次开始会创建新的学习会话。";
          } else if (status) {
            status.phase = status.taskType === "video" ? "playing" : "reading";
            status.running = true; status.detail = status.taskType === "video" ? "正在播放，结束后继续当前页后文" : "按页面顺序学习，每次滚动后检测后续内容";
            if (status.taskType !== "video" && status.scroll.state === "scheduled") status.scroll.nextAt = Date.now() + Math.max(0, status.scroll.nextInSeconds || settings.scrollIntervalSeconds) * 1000;
          }
          publish();
          return response();
        }
        return { ok: false, error: "Unknown preview message" };
      }
    },
    tabs: { async query() { return [tab]; } },
    permissions: { async contains() { return true; }, async request() { return true; } },
    storage: { local: { async get() { return { settings: structuredClone(settings) }; } }, onChanged: { addListener(listener) { storageListeners.push(listener); } } }
  };
  setInterval(() => {
    if(ownedMode)return;
    if (!status?.running || !["reading", "playing"].includes(status.phase)) return;
    status.elapsedSeconds += 1;
    if (status.taskType === "video") status.videoCurrent += 1;
    else if (status.scroll.state === "scheduled") {
      status.scroll.nextInSeconds = Math.max(0, (status.scroll.nextAt - Date.now()) / 1000);
      if (!status.scroll.nextInSeconds) {
        status.scroll.movements += 1;
        status.scroll.intervalSeconds = settings.scrollIntervalSeconds * (0.9 + Math.random() * 0.2);
        status.scroll.nextInSeconds = status.scroll.intervalSeconds;
        status.scroll.nextAt = Date.now() + status.scroll.intervalSeconds * 1000;
      }
    }
    status.updatedAt = Date.now();
    publish();
  }, 1000);
})();
