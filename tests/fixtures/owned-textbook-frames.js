"use strict";
(() => {
  const query=new URL(location.href).searchParams, middle=query.get("layer")==="middle", tall=query.get("tall")==="1", frameId=middle?"middle":"owner",frame=document.querySelector("#ownedFrame"),listeners=[];
  const offset=Math.max(0,Math.min(180,Number(query.get("offset")??120)));
  if(middle){document.documentElement.classList.add("middle");frame.style.top=`${offset}px`;}
  if(tall)document.documentElement.classList.add(middle?"tall-middle":"tall-owner");
  frame.src=middle?`desktop-textbook.html?embedded=1&owned=1${tall?"&tall=1":""}`:`owned-textbook-frames.html?layer=middle&offset=${offset}${tall?"&tall=1":""}`;
  const localAsk=message=>new Promise(resolve=>{for(const listener of listeners)listener(message,{},resolve);if(!listeners.length)resolve({ok:false,error:"engine not ready"});});
  globalThis.chrome={runtime:{onMessage:{addListener(listener){listeners.push(listener);}},async sendMessage(message){top.postMessage({fixture:"owned-textbook-engine",frameId,message},location.origin);return {ok:true};}}};
  addEventListener("message",event=>{
    if(event.origin!==location.origin)return;
    if(middle&&event.source===top&&event.data?.fixture==="owned-textbook-command")void localAsk(event.data.message).then(result=>top.postMessage({fixture:"owned-textbook-reply",requestId:event.data.requestId,result},location.origin));
    if(event.source===frame.contentWindow&&event.data?.fixture==="desktop-textbook-state"&&middle)top.postMessage({fixture:"owned-textbook-reader-detail",message:event.data.message},location.origin);
  });
  if(middle)return;
  const fitButton=document.querySelector("#ownedFitReader");
  function fitReader(enabled){
    document.documentElement.classList.toggle("fit-reader",enabled);
    fitButton.setAttribute("aria-pressed",String(enabled));
    fitButton.textContent=enabled?"恢复原始教材尺寸（测试）":"显示完整教材（测试）";
  }
  fitReader(query.get("fit")==="1");
  fitButton.addEventListener("click",()=>fitReader(!document.documentElement.classList.contains("fit-reader")));
  const windows=new Map([["owner",window]]),requests=new Map(),ready=new Map(),entries=new Map();
  let requestSequence=0,runSequence=0,runId="",running=false,checkpoint=null,latest=null;
  let initialRootTop=null;
  const previewChannel=new BroadcastChannel("itc-owned-preview");
  const trace=message=>{const output=document.querySelector("#ownedTrace");output.textContent=(output.textContent+`\n${message}`).split("\n").slice(-20).join("\n");};
  const settings={scrollIntervalSeconds:1,scrollEnabled:true,muteVideo:true,selectors:{completed:"#desktopCompleteMarker"}};
  const geometry=()=>{
    const root=document.scrollingElement,middleRoot=frame.contentDocument?.scrollingElement,readerFrame=frame.contentDocument?.querySelector("#ownedFrame"),reader=readerFrame?.contentDocument?.querySelector("#reader-container");
    const stable=initialRootTop===null||Math.abs(root.scrollTop-initialRootTop)<1;
    document.querySelector("#ownedGeometry").textContent=`${tall?"高视口诊断布局 · ":""}网页 ${Math.round(root.scrollTop)} / 初始 ${initialRootTop===null?"—":initialRootTop} ${stable?"保持":"发生移动"} · 窗口 ${innerHeight} · 外 iframe ${Math.round(frame.getBoundingClientRect().height)} · middle ${middleRoot?.clientHeight??"—"}/${middleRoot?.scrollHeight??"—"} top ${Math.round(middleRoot?.scrollTop??0)} · reader ${reader?.clientHeight??"—"} top ${Math.round(reader?.scrollTop??0)}`;
    document.querySelector("#ownedGeometry").dataset.outerStable=String(stable);
  };
  addEventListener("load",()=>{if(tall)scrollTo({top:116,behavior:"instant"});initialRootTop=Math.round(document.scrollingElement.scrollTop);geometry();},{once:true});
  function broadcast(){previewChannel.postMessage({kind:"status",status:latest?{...latest,running,updatedAt:Date.now(),completedCount:0,history:[],url:"https://e.huawei.com/cn/talent/outPage/"}:null,settings});}
  function call(id,message){
    if(id==="owner")return localAsk(message);
    const destination=windows.get(id);if(!destination)return Promise.resolve({ok:false,error:`missing frame ${id}`});
    return new Promise(resolve=>{const requestId=`owned-${++requestSequence}`,timer=setTimeout(()=>{requests.delete(requestId);resolve({ok:false,error:`frame timeout ${id}`});},5000);requests.set(requestId,{resolve,timer});destination.postMessage({fixture:"owned-textbook-command",requestId,message},location.origin);});
  }
  async function startChild(token){const entry=entries.get(token),child=ready.get(token);if(!running||!entry||!child||entry.started)return;entry.started=true;entry.child=child;trace(`委托 ${entry.owner} → ${child}`);const result=await call(child,{type:"ENGINE_EMBEDDED_RUN",token,runId,resetPosition:entry.resetPosition,settings});if(!result.ok)trace(`启动失败 ${result.error}`);}
  async function route(id,message){
    if(message.type==="ENGINE_EMBEDDED_READY"){ready.set(message.token,id);await startChild(message.token);return;}
    if(message.runId&&message.runId!==runId)return;
    if(message.type==="ENGINE_EMBEDDED_REQUEST"&&running){entries.set(message.token,{owner:id,resetPosition:message.resetPosition!==false});await startChild(message.token);}
    if(message.type==="ENGINE_EMBEDDED_PROGRESS"&&running){const entry=entries.get(message.token);if(entry?.child===id)await call(entry.owner,{type:"ENGINE_EMBEDDED_STATUS",token:message.token,runId,snapshot:message.snapshot});if(id==="reader")document.querySelector("#ownedReader").textContent=`reader ${message.snapshot.phase} · 滚动 ${message.snapshot.scroll?.movements} 次 · ${message.snapshot.detail}`;}
    if(message.type==="ENGINE_EMBEDDED_DONE"&&running){const entry=entries.get(message.token);if(entry?.child===id){entries.delete(message.token);trace(`返回 ${id} → ${entry.owner}`);await call(entry.owner,{type:"ENGINE_EMBEDDED_RETURN",token:message.token,runId,ok:true,snapshot:message.snapshot});}}
    if(message.type==="ENGINE_PROGRESS"&&id==="owner"&&message.snapshot.runId===runId){latest=message.snapshot;checkpoint=latest;document.querySelector("#ownedState").textContent=`owner ${latest.phase} · 滚动 ${latest.scroll?.movements} 次 · ${latest.detail}`;broadcast();}
    if(message.type==="ENGINE_CHANGED")trace(`${id} 内容识别变化`);
    if(message.type==="ENGINE_DONE")trace("owner 完成整项任务");
  }
  addEventListener("message",event=>{
    if(event.origin!==location.origin)return;const data=event.data;
    if(data?.fixture==="owned-textbook-reply"){const pending=requests.get(data.requestId);if(pending){requests.delete(data.requestId);clearTimeout(pending.timer);pending.resolve(data.result);}return;}
    if(data?.fixture==="owned-textbook-engine"&&["owner","middle","reader"].includes(data.frameId)){windows.set(data.frameId,event.source);void route(data.frameId,data.message);}
    if(data?.fixture==="owned-textbook-reader-detail"&&data.message?.trace)trace(data.message.trace);
  });
  async function control(action){
    if(action==="pause"){running=false;const results=await Promise.all([...windows.keys()].map(id=>call(id,{type:"ENGINE_PAUSE"})));checkpoint=results[0]?.snapshot||checkpoint;latest=checkpoint||latest;broadcast();trace("全部 frame 暂停");return;}
    running=false;await Promise.all([...windows.keys()].map(id=>call(id,{type:"ENGINE_STOP"})));
    if(action==="stop"){latest=latest?{...latest,phase:"idle",detail:"全部 frame 已停止"}:null;broadcast();trace("全部 frame 停止");return;}
    const fresh=action!=="resume";if(fresh)checkpoint=null;runId=`owned-run-${++runSequence}`;entries.clear();ready.clear();running=true;
    for(const id of windows.keys())await call(id,{type:"ENGINE_PROBE",viewportEnabled:true,settings});
    const result=await call("owner",{type:"ENGINE_RUN",runId,settings,checkpoint,resetPosition:fresh});trace(`owner 启动 ${result.ok?"成功":result.error}`);
  }
  for(const button of document.querySelectorAll("[data-action]"))button.addEventListener("click",()=>void control(button.dataset.action));
  previewChannel.addEventListener("message",event=>{
    const data=event.data;
    if(data?.kind==="request-status")broadcast();
    if(data?.kind==="command"&&["start","pause","resume","restart","stop","rescan"].includes(data.action))void control(data.action==="rescan"?(latest?"resume":"start"):data.action).then(()=>{broadcast();previewChannel.postMessage({kind:"command-result",requestId:data.requestId,ok:true});}).catch(error=>previewChannel.postMessage({kind:"command-result",requestId:data.requestId,ok:false,error:error.message}));
  });
  addEventListener("unload",()=>previewChannel.close(),{once:true});
  setInterval(()=>{const scroll=latest?.scroll;const remaining=scroll?.nextAt?Math.max(0,(scroll.nextAt-Date.now())/1000):null;document.querySelector("#ownedTiming").textContent=`owner 倒计时 ${remaining===null?"无待执行计时":remaining.toFixed(1)+" 秒"} · state ${scroll?.state||"idle"}`;geometry();},200);
})();
