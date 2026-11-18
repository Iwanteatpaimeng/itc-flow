"use strict";
(() => {
  const middle=new URL(location.href).searchParams.get("layer")==="middle",listeners=[],frame=document.querySelector("#desktopFrame");
  if(middle){document.querySelector("#framesControls").remove();document.querySelector("#framesTrace").remove();}
  frame.src=middle?"desktop-textbook.html?embedded=1":"desktop-textbook-frames.html?layer=middle";
  globalThis.chrome={runtime:{onMessage:{addListener(listener){listeners.push(listener);}},async sendMessage(){return {ok:true};}}};
  const trace=message=>{if(middle)return;const output=document.querySelector("#framesTrace");output.textContent=(output.textContent+`\n${message}`).split("\n").slice(-12).join("\n");};
  addEventListener("message",event=>{
    if(event.origin!==location.origin)return;
    const data=event.data;
    if(event.source===parent&&parent!==window&&data?.fixture==="desktop-textbook-control")frame.contentWindow.postMessage(data,location.origin);
    if(event.source!==frame.contentWindow||data?.fixture!=="desktop-textbook-state")return;
    const forwarded={...data,message:{...data.message}};
    if(Number.isFinite(forwarded.message.playCenter))forwarded.message.playCenter+=frame.getBoundingClientRect().top;
    if(middle){parent.postMessage(forwarded,location.origin);return;}
    const message=forwarded.message;
    if(message.trace)trace(message.trace);
    if(message.snapshot)document.querySelector("#framesState").textContent=`${message.snapshot.phase} · 下次滚动 ${message.snapshot.scroll?.nextInSeconds==null?"—":Number(message.snapshot.scroll.nextInSeconds).toFixed(1)+"秒"} · ${message.snapshot.detail}`;
    if(Number.isFinite(message.playCenter))document.querySelector("#framesGeometry").textContent=`实际播放时投影中心 ${Math.round(message.playCenter)}px / 顶层浏览器中心 ${Math.round(innerHeight/2)}px`;
  });
  for(const button of document.querySelectorAll("[data-action]"))button.addEventListener("click",()=>frame.contentWindow.postMessage({fixture:"desktop-textbook-control",action:button.dataset.action},location.origin));
  addEventListener("load",()=>{for(const listener of listeners)listener({type:"ENGINE_PROBE",viewportEnabled:true},{},()=>{});});
})();
