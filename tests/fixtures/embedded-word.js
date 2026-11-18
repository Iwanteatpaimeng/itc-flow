"use strict";
(() => {
  const query = new URL(location.href).searchParams, frame = document.querySelector("#FKNBPCW33J"), reader = document.querySelector("#reader-container");
  const listeners = [], windows = new Map([["owner", window]]), requests = new Map(), ready = new Map(), entries = new Map(), snapshots = new Map();
  const allowed = new Set([location.origin, `http://localhost:${location.port}`, `http://127.0.0.1:${location.port}`]);
  const counters = { ownerRuns:0, childRuns:0, changes:0, returns:0, unexpectedOuter:0, hostMovedWhileWord:0 };
  const settings = { scrollIntervalSeconds:1, scrollEnabled:true, muteVideo:true, selectors:{completed:"#wordCompleteMarker"} };
  let active = false, runSequence = 0, requestSequence = 0, runId = "", checkpoint = null, latest = null, addressSequence = 0, initialOuter = null, enteredTop = null, sourceRenewed = false;
  const text = "这是用于验证嵌套文档阅读顺序的虚构教材。先逐段阅读说明，再查看文档里的几页内容，最后继续当前章节下方的总结。文档与教材各有独立滚动条，文档内部阅读期间应保持教材位置。";
  document.querySelector("#intro").innerHTML = Array.from({length:4}, (_,index) => `<p>前置正文 ${index+1}。${text}</p>`).join("");
  document.querySelector("#tail").innerHTML = `<h2>文档读完后继续本页文字</h2>` + Array.from({length:5}, (_,index) => `<p>后续正文 ${index+1}。${text}</p>`).join("");
  if(query.get("fit")==="0")document.documentElement.classList.add("not-fit");
  function trace(value) { const output = document.querySelector("#wordTrace"); output.textContent = (output.textContent+`\n${value}`).split("\n").slice(-45).join("\n"); }
  function source() {
    const url = new URL("embedded-word-child.html", location.href);
    if(query.get("cross")==="1")url.hostname = location.hostname === "localhost" ? "127.0.0.1" : "localhost";
    url.searchParams.set("layer", query.get("nested")==="1" ? "shell" : "document");
    url.searchParams.set("variant", query.get("variant") || "text");
    url.searchParams.set("delay", query.get("delay") || "0");
    url.searchParams.set("ticket", String(++addressSequence));
    frame.src = url.href;
    trace(`Word 页面加载，地址版本 ${addressSequence}`);
  }
  function updateGeometry() {
    const outer = Math.round(document.scrollingElement.scrollTop), stable = initialOuter===null || outer===initialOuter;
    document.querySelector("#wordGeometry").textContent = `外页 ${outer}/${initialOuter??"—"} ${stable?"保持":"移动"} · 教材 ${Math.round(reader.scrollTop)}/${reader.scrollHeight-reader.clientHeight} · owner RUN ${counters.ownerRuns} · child RUN ${counters.childRuns} · RETURN ${counters.returns} · CHANGE ${counters.changes} · Word期间教材移动 ${counters.hostMovedWhileWord}`;
    document.querySelector("#wordGeometry").dataset.outerStable = String(stable);
    document.querySelector("#wordGeometry").dataset.ownerRuns = String(counters.ownerRuns);
    document.querySelector("#wordGeometry").dataset.returns = String(counters.returns);
    const child = snapshots.get("word");
    if(child)document.querySelector("#wordChild").textContent = `Word ${child.phase} · 内部滚动 ${child.scroll?.movements??0} 次 · ${child.detail}`;
  }
  function localAsk(message) { return new Promise(resolve => { for(const listener of listeners)listener(message,{},resolve); if(!listeners.length)resolve({ok:false,error:"内容脚本未就绪"}); }); }
  function call(id, message) {
    if(id==="owner")return localAsk(message);
    const destination = windows.get(id);
    if(!destination)return Promise.resolve({ok:false,error:`missing ${id}`});
    return new Promise(resolve => { const requestId=`word-request-${++requestSequence}`, timer=setTimeout(()=>{requests.delete(requestId);resolve({ok:false,error:`timeout ${id}`});},5000); requests.set(requestId,{resolve,timer}); destination.postMessage({fixture:"word-command",requestId,message},"*"); });
  }
  async function startChild(token) {
    const entry=entries.get(token), id=ready.get(token);
    if(!active || !entry || !id || entry.started)return;
    entry.started=true;entry.child=id;counters.childRuns++;
    await call(id,{type:"ENGINE_PROBE",settings,viewportEnabled:true});
    trace(`委托 ${entry.owner} → ${id} · reset ${entry.resetPosition}`);
    const result=await call(id,{type:"ENGINE_EMBEDDED_RUN",token,runId,resetPosition:entry.resetPosition,settings});
    if(!result.ok)trace(`${id} 启动失败：${result.error}`);
    updateGeometry();
  }
  async function route(id,message) {
    if(message.type==="ENGINE_EMBEDDED_READY"){ready.set(message.token,id);await startChild(message.token);return;}
    if(message.runId && message.runId!==runId)return;
    if(message.type==="ENGINE_EMBEDDED_REQUEST" && active){
      entries.set(message.token,{owner:id,resetPosition:message.resetPosition!==false});
      if(id==="owner")enteredTop=reader.scrollTop;
      await startChild(message.token);
    }
    if(message.type==="ENGINE_EMBEDDED_PROGRESS" && active){
      snapshots.set(id,message.snapshot);
      const entry=entries.get(message.token);
      if(entry?.child===id)await call(entry.owner,{type:"ENGINE_EMBEDDED_STATUS",token:message.token,runId,snapshot:message.snapshot});
    }
    if(message.type==="ENGINE_EMBEDDED_DONE" && active){
      const entry=entries.get(message.token);
      if(entry?.child===id){
        entries.delete(message.token);counters.returns++;
        trace(`内部滚动到底：${id} → ${entry.owner}，教材位置 ${Math.round(reader.scrollTop)}`);
        await call(entry.owner,{type:"ENGINE_EMBEDDED_RETURN",token:message.token,runId,ok:true,snapshot:message.snapshot});
        if(entry.owner==="owner")enteredTop=null;
      }
    }
    if(message.type==="ENGINE_PROGRESS" && id==="owner" && message.snapshot.runId===runId){
      latest=checkpoint=message.snapshot;
      document.querySelector("#wordState").textContent=`${latest.phase} · ${latest.detail}`;
      document.querySelector("#wordIdentity").textContent=`key ${latest.key} · run ${latest.runId} · 显示滚动 ${latest.scroll?.movements??0} 次 · embedded ${latest.flow?.embeddedActive??false}`;
    }
    if(message.type==="ENGINE_CHANGED"){counters.changes++;trace(`${id} CHANGE · replaced ${message.elementReplaced} · key ${message.candidate?.key??"none"}`);}
    if(message.type==="ENGINE_DONE"){trace("全部教材结束，平台标记已确认");active=false;}
    updateGeometry();
  }
  globalThis.chrome={runtime:{onMessage:{addListener(listener){listeners.push(listener);}},async sendMessage(message){void route("owner",message);return {ok:true};}}};
  addEventListener("message",event=>{
    if(!allowed.has(event.origin))return;
    const data=event.data;
    if(data?.fixture==="word-reply"){const pending=requests.get(data.requestId);if(pending){requests.delete(data.requestId);clearTimeout(pending.timer);pending.resolve(data.result);}return;}
    if(data?.fixture==="word-engine" && ["word","word-shell"].includes(data.id)){windows.set(data.id,event.source);void route(data.id,data.message);}
    if(data?.fixture==="word-geometry"){
      document.querySelector("#wordChild").textContent=`Word 内层 ${data.position}/${data.maximum} · 文档外页 ${data.outer} · 页数 ${data.pages} · ${data.loaded?"已加载":"加载中"}`;
      document.querySelector("#wordChild").dataset.position=String(data.position);
      document.querySelector("#wordChild").dataset.maximum=String(data.maximum);
      if(data.variant==="proxy"){
        Object.assign(document.querySelector("#wordChild").dataset,{variant:data.variant,renderPosition:String(data.renderPosition),
          proxyWidth:String(data.proxyWidth),proxyHeight:String(data.proxyHeight),scrollEvents:String(data.scrollEvents),
          toolbarTop:String(data.toolbarTop),toolbarBottom:String(data.toolbarBottom),footerTop:String(data.footerTop),page:String(data.page)});
      }
    }
    if(data?.fixture==="word-trace")trace(data.message);
  });
  async function control(action) {
    if(action==="pause"){
      active=false;const results=await Promise.all([...windows.keys()].map(id=>call(id,{type:"ENGINE_PAUSE"})));checkpoint=results[0]?.snapshot||checkpoint;latest=checkpoint||latest;trace("全部页面暂停，保留 Word 位置");return;
    }
    active=false;await Promise.all([...windows.keys()].map(id=>call(id,{type:"ENGINE_STOP"})));
    if(action==="stop"){trace("全部页面停止");enteredTop=null;return;}
    const fresh=action!=="resume";if(fresh){checkpoint=null;sourceRenewed=false;document.querySelector("#complete").checked=false;document.querySelector("#wordCompleteMarker").hidden=true;}
    entries.clear();ready.clear();runId=`word-fixture-${++runSequence}`;active=true;counters.ownerRuns++;
    for(const id of windows.keys())await call(id,{type:"ENGINE_PROBE",settings,viewportEnabled:true});
    const result=await call("owner",{type:"ENGINE_RUN",settings,runId,checkpoint,resetPosition:fresh});
    trace(`教材 ${fresh?"从顶部开始":"原位置继续"} · ${result.ok?"成功":result.error}`);updateGeometry();
  }
  for(const button of document.querySelectorAll("[data-action]"))button.addEventListener("click",()=>void control(button.dataset.action));
  document.querySelector("#renewSource").addEventListener("click",source);
  document.querySelector("#complete").addEventListener("change",event=>{document.querySelector("#wordCompleteMarker").hidden=!event.target.checked;});
  reader.addEventListener("scroll",()=>{
    if(active && enteredTop!==null && Math.abs(reader.scrollTop-enteredTop)>2)counters.hostMovedWhileWord++;
    updateGeometry();
  },{passive:true});
  frame.addEventListener("load",()=>trace("Word iframe load 事件"));
  addEventListener("load",()=>{scrollTo({top:149,behavior:"instant"});initialOuter=Math.round(document.scrollingElement.scrollTop);updateGeometry();},{once:true});
  setInterval(()=>{
    const deadline=latest?.scroll?.nextAt;
    document.querySelector("#wordTiming").textContent=deadline?`下一次真实滚动 ${Math.max(0,(deadline-Date.now())/1000).toFixed(1)} 秒 · ${latest.scroll.state}`:`无待执行倒计时 · ${latest?.scroll?.state??"idle"}`;
    if(active && !sourceRenewed && document.querySelector("#reloadOnEnter").checked && latest?.flow?.embeddedActive){sourceRenewed=true;source();}
    updateGeometry();
  },200);
  source();
})();
