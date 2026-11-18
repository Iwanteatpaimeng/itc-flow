"use strict";
(() => {
  const ownedFrame = new URL(location.href).searchParams.get("owned") === "1";
  if(new URL(location.href).searchParams.get("embedded")==="1")document.documentElement.classList.add("embedded-mode");
  if(new URL(location.href).searchParams.get("tall")==="1")document.documentElement.classList.add("tall-reader");
  const listeners = [], reader = document.querySelector("#reader-container");
  const videos = [...document.querySelectorAll("video")], checks = [...document.querySelectorAll(".insertVideoCheck")];
  const read = new Set(), opening = new Map();
  let runId = "", checkpoint = null, active = false, sequence = 0;
  const emit = message => { if (parent !== window) parent.postMessage({ fixture:"desktop-textbook-state", message }, location.origin); };
  const trace = message => {
    const output = document.querySelector("#desktopTrace");
    output.textContent = (output.textContent + `\n${new Date().toLocaleTimeString()} ${message}`).split("\n").slice(-14).join("\n");
    emit({ trace:message });
  };
  const positions = () => {
    const wrapper = document.querySelector(".reader-wrapper"), chapter = document.querySelector(".reader-chapter-content");
    document.querySelector("#desktopPositions").textContent = `网页 ${document.scrollingElement.scrollTop} · app ${document.querySelector("#app").scrollTop} · wrapper ${Math.round(wrapper.scrollTop)} · chapter ${chapter.scrollTop} · reader ${Math.round(reader.scrollTop)} / ${reader.scrollHeight-reader.clientHeight}`;
    document.querySelector("#desktopVideos").textContent = videos.map((video,index)=>`视频${index+1} ${checks[index].checked?"已选展开":"折叠"} ${video.ended?"结束":video.paused?"暂停":"播放"} ${video.currentTime.toFixed(1)}s`).join(" · ");
    emit({ positions:document.querySelector("#desktopPositions").textContent, videos:document.querySelector("#desktopVideos").textContent });
  };
  const text = "这段虚构的桌面教材用于观察嵌套阅读器中的连续阅读。发送端把数据交给协议栈，设备根据地址和链路状态处理转发，接收端再还原完整内容。先逐段理解概念，再观察演示，最后阅读总结，可以确认插件没有跳过视频之间的文字。";
  for (const [id,label] of [["desktopIntro","前置"],["desktopMiddle","夹心"],["desktopTail","尾部"]]) for(let index=0;index<5;index++) { const p=document.createElement("p");p.textContent=`${label}文字 ${index+1}. ${text}`;document.querySelector(`#${id}`).append(p); }
  const ask = message => new Promise(resolve => { for(const listener of listeners) listener(message,{},resolve);if(!listeners.length)resolve({ok:false,error:"内容脚本未就绪"}); });
  globalThis.chrome = { runtime: {
    onMessage:{addListener(listener){listeners.push(listener);}},
    async sendMessage(message){
      if(ownedFrame)top.postMessage({fixture:"owned-textbook-engine",frameId:"reader",message},location.origin);
      if(message.type==="ENGINE_PROGRESS" && message.snapshot.runId===runId){
        checkpoint=message.snapshot;
        document.querySelector("#desktopState").textContent=`${checkpoint.phase} · ${checkpoint.detail}`;
        const next=checkpoint.scroll?.nextInSeconds;
        document.querySelector("#desktopCountdown").textContent=`下次滚动 ${next==null?"—":Number(next).toFixed(1)+"秒"} · 已滚动 ${checkpoint.scroll?.movements||0}次`;
        emit({ snapshot:checkpoint });positions();
      }
      if(message.type==="ENGINE_DONE" && active && message.runId===runId){active=false;trace("本项内容与视频全部结束，平台确认 DONE");}
      if(message.type==="ENGINE_CHANGED" && active){trace(`页面识别变化：${message.reason||"matched"}`);}
      return {ok:true};
    }
  }};
  async function control(action){
    if(action==="pause"){active=false;const result=await ask({type:"ENGINE_PAUSE"});checkpoint=result.snapshot||checkpoint;trace("已暂停，保留位置");return result;}
    if(action==="stop"){active=false;await ask({type:"ENGINE_STOP"});trace("已停止");return {ok:true};}
    active=false;await ask({type:"ENGINE_STOP"});runId=`desktop-fixture-${++sequence}`;
    const fresh=action!=="resume";if(fresh){checkpoint=null;read.clear();}
    active=true;
    const result=await ask({type:"ENGINE_RUN",runId,checkpoint,resetPosition:fresh,settings:{scrollIntervalSeconds:Math.max(1,Math.min(30,Number(document.querySelector("#desktopInterval").value)||1)),scrollEnabled:true,muteVideo:true,selectors:{completed:"#desktopCompleteMarker"}}});
    if(!result.ok){active=false;trace(result.error||"启动失败");}else trace(fresh?"从桌面阅读器顶部开始":"继续当前桌面阅读器位置");positions();return result;
  }
  for(const [id,action] of [["desktopStart","start"],["desktopPause","pause"],["desktopResume","resume"],["desktopRestart","restart"],["desktopStop","stop"]])document.querySelector(`#${id}`).addEventListener("click",()=>void control(action));
  document.querySelector("#desktopComplete").addEventListener("change",event=>{document.querySelector("#desktopCompleteMarker").hidden=!event.target.checked;});
  checks.forEach((input,index)=>input.addEventListener("change",()=>{
    clearTimeout(opening.get(input));const clip=input.parentElement.querySelector(".element-new");
    if(!input.checked){clip.classList.remove("is-open");positions();return;}
    trace(`视频 ${index+1} 请求展开`);
    const open=()=>{clip.classList.add("is-open");trace(`视频 ${index+1} 真实展开`);positions();};
    if(document.querySelector("#desktopDelay").checked)opening.set(input,setTimeout(open,1500));else open();
  }));
  videos.forEach((video,index)=>{
    video.addEventListener("play",()=>{const rect=video.getBoundingClientRect(),port=reader.getBoundingClientRect();trace(`视频 ${index+1} play，中点 ${Math.round(rect.top+rect.height/2)} / 阅读器 ${Math.round(port.top+port.height/2)}`);emit({playCenter:rect.top+rect.height/2});positions();});
    video.addEventListener("ended",()=>{trace(`视频 ${index+1} ended，继续正文`);positions();});video.addEventListener("timeupdate",positions);
  });
  reader.addEventListener("scroll",()=>{positions();const port=reader.getBoundingClientRect(),center=port.top+port.height/2;for(const section of reader.querySelectorAll("[data-reading]")){const rect=section.getBoundingClientRect();if(rect.top<=center&&rect.bottom>=center&&!read.has(section)){read.add(section);trace(`${section.dataset.reading} 经过阅读器中间`);}}},{passive:true});
  addEventListener("message",event=>{if(event.source!==parent||event.origin!==location.origin||event.data?.fixture!=="desktop-textbook-control")return;void control(event.data.action).then(result=>emit({controlResult:result.ok}));});
  addEventListener("message",event=>{
    if(!ownedFrame||event.source!==top||event.origin!==location.origin||event.data?.fixture!=="owned-textbook-command")return;
    void ask(event.data.message).then(result=>top.postMessage({fixture:"owned-textbook-reply",requestId:event.data.requestId,result},location.origin));
  });
  async function makeVideo(){
    const canvas=document.createElement("canvas");canvas.width=640;canvas.height=360;const ctx=canvas.getContext("2d"),stream=canvas.captureStream(15),chunks=[],recorder=new MediaRecorder(stream);let tick=0;
    const timer=setInterval(()=>{ctx.fillStyle="#101827";ctx.fillRect(0,0,640,360);ctx.fillStyle="#a5caff";ctx.font="24px sans-serif";ctx.fillText(`LOCAL DESKTOP VIDEO · ${++tick}`,105,190);},60);
    recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
    recorder.onstop=()=>{clearInterval(timer);stream.getTracks().forEach(track=>track.stop());const url=URL.createObjectURL(new Blob(chunks,{type:recorder.mimeType}));videos.forEach(video=>{video.src=url;});trace("两段本地 3 秒视频已就绪");positions();};recorder.start();setTimeout(()=>recorder.stop(),3100);
  }
  makeVideo().catch(error=>trace(`本地视频失败：${error.message}`));positions();
})();
