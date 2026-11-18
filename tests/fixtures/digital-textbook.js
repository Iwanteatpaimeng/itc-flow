"use strict";
(() => {
  const listeners = [];
  const info = document.querySelector("#informationPanel");
  const shell = document.querySelector("#multiContentShell");
  const bodyShell = document.querySelector("#mobileBody");
  const reader = document.querySelector("#reader-container");
  const tiny = document.querySelector("#tinyChapter");
  const long = document.querySelector("#longChapter");
  const videos = [...document.querySelectorAll("video.insertVideo")];
  const checks = [...document.querySelectorAll(".insertVideoCheck")];
  const traced = new Set();
  let sequence = 0;
  let runId = "";
  let checkpoint = null;
  let active = false;
  let completed = 0;
  let outerY = 180;
  const trace = detail => { const output = document.querySelector("#digitalTrace"); output.textContent = (output.textContent + `\n${new Date().toLocaleTimeString()} ${detail}`).split("\n").slice(-13).join("\n"); };
  const positions = () => {
    document.querySelector("#digitalPositions").textContent = `外页 ${Math.round(scrollY)} / ${outerY} · info ${Math.round(info.scrollTop)} · 大壳 ${Math.round(shell.scrollTop)} · main ${Math.round(bodyShell.scrollTop)} · 82px章节 ${Math.round(tiny.scrollTop)} (${tiny.clientHeight}/${tiny.scrollHeight}) · 长章节 ${Math.round(long.scrollTop)} · 正文reader ${Math.round(reader.scrollTop)} / ${Math.round(reader.scrollHeight-reader.clientHeight)}`;
    document.querySelector("#digitalVideos").textContent = videos.map((video,index) => `视频${index+1}：${checks[index].checked ? "已展开" : "折叠"} ${video.paused ? video.ended ? "已结束" : "暂停" : "播放中"} ${video.currentTime.toFixed(1)}s`).join(" · ");
  };
  const paragraph = "在这个虚构的数字教材中，学习者先阅读概念，再通过本地演示把现象和原理联系起来。数据从发送端到接收端会经过多种协议和设备，不同层分别处理地址、链路、转发以及可靠性。逐段阅读有助于理解每个步骤，而不是仅仅跳到视频。";
  for (const [id,label] of [["digitalIntro","前置"],["digitalMiddle","夹心"],["digitalTail","尾部"]]) {
    for (let index=0;index<5;index++) { const p=document.createElement("p");p.textContent=`${label}正文 ${index+1}. ${paragraph}`;document.querySelector(`#${id}`).append(p); }
  }
  const ask = message => new Promise(resolve => { listeners.forEach(listener=>listener(message,{},resolve));if(!listeners.length)resolve({ok:false,error:"内容引擎未就绪"}); });
  globalThis.chrome={runtime:{onMessage:{addListener(listener){listeners.push(listener);}},async sendMessage(message){
    if(message.type==="ENGINE_PROGRESS"&&message.snapshot.runId===runId){checkpoint=message.snapshot;document.querySelector("#digitalState").textContent=`${checkpoint.phase} · ${checkpoint.detail}`;positions();}
    if(message.type==="ENGINE_DONE"&&active&&message.runId===runId){active=false;completed++;document.querySelector("#digitalCount").textContent=`已完成任务：${completed}`;trace("本页全部处理完且平台确认，任务 DONE");}
    return {ok:true};
  }}};
  async function start(fresh){
    active=false;await ask({type:"ENGINE_STOP"});runId=`digital-fixture-${++sequence}`;
    if(fresh){checkpoint=null;completed=0;traced.clear();document.querySelector("#digitalCount").textContent="已完成任务：0";}
    active=true;
    const result=await ask({type:"ENGINE_RUN",runId,checkpoint,resetPosition:fresh,settings:{scrollIntervalSeconds:Math.max(1,Math.min(30,Number(document.querySelector("#digitalInterval").value)||1)),scrollEnabled:true,muteVideo:true,selectors:{completed:"#digitalCompleteMarker"}}});
    if(!result?.ok){active=false;trace(result?.error||"启动失败");}trace(fresh?"从教材正文顶部开始":"继续当前教材位置");positions();
  }
  document.querySelector("#digitalStart").addEventListener("click",()=>void start(true));
  document.querySelector("#digitalRestart").addEventListener("click",()=>void start(true));
  document.querySelector("#digitalResume").addEventListener("click",()=>void start(false));
  document.querySelector("#digitalPause").addEventListener("click",async()=>{active=false;const result=await ask({type:"ENGINE_PAUSE"});checkpoint=result.snapshot||checkpoint;trace("已暂停");});
  document.querySelector("#digitalStop").addEventListener("click",async()=>{active=false;await ask({type:"ENGINE_STOP"});trace("已停止");});
  document.querySelector("#digitalComplete").addEventListener("change",event=>{document.querySelector("#digitalCompleteMarker").hidden=!event.target.checked;trace(`平台确认完成：${event.target.checked}`);});
  document.querySelectorAll(".videoTitlepc-new").forEach((title,index)=>title.addEventListener("click",event=>{if(event.target.tagName!=="LABEL")checks[index].click();}));
  checks.forEach((check,index)=>check.addEventListener("change",()=>{trace(`视频 ${index+1} ${check.checked?"展开":"折叠"}（展开本身不播放）`);positions();}));
  videos.forEach((video,index)=>{
    video.addEventListener("play",()=>{trace(`视频 ${index+1} 真实 play`);positions();});
    video.addEventListener("pause",positions);
    video.addEventListener("ended",()=>{trace(`视频 ${index+1} ended，继续同页正文`);positions();});
    video.addEventListener("timeupdate",positions);
  });
  reader.addEventListener("scroll",()=>{positions();const bounds=reader.getBoundingClientRect();const center=(Math.max(0,bounds.top)+Math.min(innerHeight,bounds.bottom))/2;for(const section of reader.querySelectorAll("[data-read-order]")){const rect=section.getBoundingClientRect();if(rect.top<=center&&rect.bottom>=center&&!traced.has(section)){traced.add(section);trace(`${section.dataset.readOrder} 经过正文区域中间`);}}},{passive:true});
  [info,shell,bodyShell,tiny,long].forEach(node=>node.addEventListener("scroll",positions,{passive:true}));
  addEventListener("scroll",positions,{passive:true});
  addEventListener("load",()=>{scrollTo({top:outerY,behavior:"instant"});outerY=scrollY;positions();});
  async function makeVideo(){
    const canvas=document.createElement("canvas");canvas.width=640;canvas.height=360;const context=canvas.getContext("2d");const stream=canvas.captureStream(15);const chunks=[];const recorder=new MediaRecorder(stream);let tick=0;
    const draw=setInterval(()=>{context.fillStyle="#101827";context.fillRect(0,0,640,360);context.fillStyle="#a5caff";context.font="24px sans-serif";context.fillText(`LOCAL TEXTBOOK VIDEO · ${++tick}`,130,190);},60);
    recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};recorder.onstop=()=>{clearInterval(draw);stream.getTracks().forEach(track=>track.stop());const url=URL.createObjectURL(new Blob(chunks,{type:recorder.mimeType}));videos.forEach(video=>{video.src=url;});trace("两段本地 3 秒视频已就绪，默认保持折叠");positions();};recorder.start();setTimeout(()=>recorder.stop(),3100);
  }
  makeVideo().catch(error=>trace(`本地视频生成失败：${error.message}`));positions();
})();
