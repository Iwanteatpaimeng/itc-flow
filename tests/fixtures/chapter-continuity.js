"use strict";
(() => {
  const reader = document.querySelector("#reader-container"), box = document.querySelector("#reader-chapter-box");
  const listeners = [], counters = { run:0, change:0, stop:0, recycle:0, ended:0 }, seen = new Set();
  const settings = { scrollIntervalSeconds:1, scrollEnabled:true, muteVideo:true, selectors:{completed:"#completeMarker"} };
  let active = false, checkpoint = null, latest = null, sequence = 0, runId = "", mediaUrl = "", firstEnded = false, recycled = false, switchRoute = false;
  let recycleTop = null, minimumAfterRecycle = null, previousTop = 0, rewindCount = 0, leafHeight = 0;
  const text = "这段虚构教材用于观察章节之间的阅读连续性。数据通过本地演示完成发送与接收；先逐段理解文字，再观察视频，随后继续阅读下一章。这里没有平台账号或实际课程内容。";
  const trace = message => {
    const output = document.querySelector("#trace");
    output.textContent = (output.textContent + `\n${message}`).split("\n").slice(-35).join("\n");
  };
  const geometry = () => {
    if (recycled) minimumAfterRecycle = Math.min(minimumAfterRecycle ?? reader.scrollTop, reader.scrollTop);
    document.querySelector("#geometry").textContent = `网页 ${document.scrollingElement.scrollTop} · reader ${Math.round(reader.scrollTop)}/${reader.scrollHeight-reader.clientHeight} · 回收位置 ${recycleTop===null?"—":Math.round(recycleTop)} · 回收后最小 ${minimumAfterRecycle===null?"—":Math.round(minimumAfterRecycle)} · 非预期回退 ${rewindCount}`;
    document.querySelector("#counters").textContent = `RUN ${counters.run} · CHANGE ${counters.change} · STOP ${counters.stop} · 回收 ${counters.recycle} · 视频完成 ${counters.ended}`;
    document.querySelector("#geometry").dataset.rewindCount = String(rewindCount);
    document.querySelector("#counters").dataset.videoEnded = String(counters.ended);
    document.querySelector("#counters").dataset.runCount = String(counters.run);
  };
  const paragraph = (label, count) => Array.from({length:count}, (_,index) => `<p>${label} ${index+1}。${text}</p>`).join("");
  const video = (id,label) => `<p><span class="td" id="video_td_span_${id}"><input type="checkbox" class="insertVideoCheck" id="check_${id}"><span class="videoTitlepc-new" id="video_title_span_${id}"><label for="check_${id}">▶ ${label}</label></span><span class="element-new"><video id="${id}" class="insertVideo cres" controls playsinline></video></span></span></p>`;
  function fill() {
    firstEnded = false; recycled = false; recycleTop = null; minimumAfterRecycle = null; previousTop = 0; rewindCount = 0; seen.clear();
    box.innerHTML = `<div id="chapter-one" class="reader-chapter-content w-e-text"><h1>当前章：数据发送</h1><section data-reading="第一章前文">${paragraph("第一章前文",3)}</section>${video("local-one","本地短视频一：发送")}<section data-reading="第一章尾文">${paragraph("第一章尾文",2)}</section></div><div id="chapter-two" class="reader-chapter-content w-e-text"><h2>下一章：数据接收</h2><section data-reading="第二章前文">${paragraph("第二章前文",2)}</section>${video("local-two","本地短视频二：接收")}<section data-reading="第二章尾文">${paragraph("第二章尾文",4)}</section><strong id="completeMarker" hidden>本地平台完成标记</strong></div>`;
    document.querySelector("#complete").checked=false;
    document.querySelectorAll("nav .task-item").forEach((item,index) => item.classList.toggle("active",index===0));
    for (const input of box.querySelectorAll(".insertVideoCheck")) input.addEventListener("change", () => {
      const clip = input.parentElement.querySelector(".element-new");
      trace(`${input.id} 请求展开`);
      setTimeout(() => { if (!input.isConnected) return; clip.classList.toggle("is-open",input.checked); trace(`${input.id} 展开完成`); geometry(); },300);
    });
    for (const item of box.querySelectorAll("video")) {
      if (mediaUrl) item.src = mediaUrl;
      item.addEventListener("play", () => trace(`${item.id} play · reader ${Math.round(reader.scrollTop)}`));
      item.addEventListener("ended", () => { counters.ended++; if (item.id==="local-one") firstEnded=true; trace(`${item.id} ended`); geometry(); });
    }
    geometry();
  }
  function recycle() {
    const old = document.querySelector("#chapter-one");
    if (!old || recycled) return;
    leafHeight = old.getBoundingClientRect().height;
    const spacer = document.createElement("div"); spacer.className="reader-spacer"; spacer.style.height=`${leafHeight}px`; spacer.setAttribute("aria-hidden","true");
    recycleTop = reader.scrollTop; minimumAfterRecycle = recycleTop; recycled=true; counters.recycle++;
    old.replaceWith(spacer);
    document.querySelectorAll("nav .task-item").forEach((item,index) => item.classList.toggle("active",index===1));
    trace(`章节交界：旧章卸载，host 保留，位置 ${Math.round(reader.scrollTop)}`); geometry();
  }
  reader.addEventListener("scroll", () => {
    if (active && reader.scrollTop < previousTop-3) rewindCount++;
    previousTop=reader.scrollTop;
    const port=reader.getBoundingClientRect(), center=port.top+port.height/2;
    for (const section of box.querySelectorAll("[data-reading]")) {
      const rect=section.getBoundingClientRect();
      if (rect.top<=center && rect.bottom>=center && !seen.has(section.dataset.reading)) { seen.add(section.dataset.reading); trace(`${section.dataset.reading} 经过中心`); }
    }
    const chapterTwo=document.querySelector("#chapter-two");
    if (firstEnded && chapterTwo.getBoundingClientRect().top<=center) recycle();
    geometry();
  },{passive:true});
  const ask = message => new Promise(resolve => {
    if (message.type==="ENGINE_RUN") counters.run++;
    if (message.type==="ENGINE_STOP") counters.stop++;
    for(const listener of listeners) listener(message,{},resolve);
    if(!listeners.length)resolve({ok:false,error:"内容脚本未就绪"});
  });
  globalThis.chrome = {runtime:{onMessage:{addListener(listener){listeners.push(listener);}},async sendMessage(message){
    if(message.type==="ENGINE_PROGRESS" && message.snapshot.runId===runId){
      latest=checkpoint=message.snapshot;
      document.querySelector("#state").textContent=`${latest.phase} · ${latest.detail}`;
      document.querySelector("#identity").textContent=`key ${latest.key} · run ${latest.runId} · 滚动 ${latest.scroll?.movements??0} 次 · 已播 ${latest.flow?.videosCompleted??0}`;
      geometry();
    }
    if(message.type==="ENGINE_CHANGED"){
      counters.change++; trace(`CHANGE · replaced ${message.elementReplaced} · key ${message.candidate?.key||"none"}`); geometry();
      if(switchRoute){switchRoute=false;void control("start");}
    }
    if(message.type==="ENGINE_DONE"){trace("DONE：完整内容已处理且本地完成标记确认");active=false;}
    return {ok:true};
  }}};
  async function control(action) {
    if(action==="pause"){active=false;const result=await ask({type:"ENGINE_PAUSE"});checkpoint=result.snapshot||checkpoint;trace("暂停，保留位置");return;}
    active=false;await ask({type:"ENGINE_STOP"});
    const fresh=action!=="resume";
    if(fresh){checkpoint=null;fill();}
    runId=`chapter-fixture-${++sequence}`;active=true;
    const result=await ask({type:"ENGINE_RUN",settings,runId,checkpoint,resetPosition:fresh});
    trace(`${fresh?"顶部开始":"保留位置继续"} · ${result.ok?"成功":result.error}`);geometry();
  }
  for(const action of ["start","pause","resume","restart"])document.querySelector(`#${action}`).addEventListener("click",()=>void control(action));
  document.querySelector("#recycle").addEventListener("click",recycle);
  document.querySelector("#route").addEventListener("click",()=>{switchRoute=true;location.hash=`task-${Date.now()}`;trace("模拟整项路由变化");});
  document.querySelector("#complete").addEventListener("change",event=>{document.querySelector("#completeMarker").hidden=!event.target.checked;trace(`本地平台完成标记 ${event.target.checked?"显示":"隐藏"}`);});
  setInterval(()=>{
    const deadline=latest?.scroll?.nextAt;
    document.querySelector("#timing").textContent=deadline?`距下次滚动 ${Math.max(0,(deadline-Date.now())/1000).toFixed(1)} 秒 · ${latest.scroll.state}`:`无待执行倒计时 · ${latest?.scroll?.state||"idle"}`;
  },150);
  fill();
  async function makeVideo() {
    const canvas=document.createElement("canvas");canvas.width=640;canvas.height=360;
    const ctx=canvas.getContext("2d"), stream=canvas.captureStream(12), chunks=[], recorder=new MediaRecorder(stream);let tick=0;
    const timer=setInterval(()=>{ctx.fillStyle="#172033";ctx.fillRect(0,0,640,360);ctx.fillStyle="#a5caff";ctx.font="24px sans-serif";ctx.fillText(`LOCAL CHAPTER VIDEO ${++tick}`,100,180);},70);
    recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
    recorder.onstop=()=>{clearInterval(timer);stream.getTracks().forEach(track=>track.stop());mediaUrl=URL.createObjectURL(new Blob(chunks,{type:recorder.mimeType}));box.querySelectorAll("video").forEach(item=>item.src=mediaUrl);document.querySelector("#start").disabled=document.querySelector("#restart").disabled=false;document.querySelector("#state").textContent="本地短视频已准备，等待开始";trace("两段 2 秒本地视频准备完成");};
    recorder.start();setTimeout(()=>recorder.stop(),2100);
  }
  makeVideo().catch(error=>{document.querySelector("#state").textContent=`本地视频失败：${error.message}`;});
})();
