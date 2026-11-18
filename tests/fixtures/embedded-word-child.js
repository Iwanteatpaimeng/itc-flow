"use strict";
(() => {
  const query=new URL(location.href).searchParams, shell=query.get("layer")==="shell", id=shell?"word-shell":"word", listeners=[];
  const surface=document.querySelector("#surface");surface.style.height="100%";
  const post=data=>top.postMessage(data,"*");
  const trace=message=>post({fixture:"word-trace",message});
  globalThis.chrome={runtime:{onMessage:{addListener(listener){listeners.push(listener);}},async sendMessage(message){post({fixture:"word-engine",id,message});return {ok:true};}}};
  const ask=message=>new Promise(resolve=>{for(const listener of listeners)listener(message,{},resolve);if(!listeners.length)resolve({ok:false,error:"Word 内容脚本未就绪"});});
  addEventListener("message",event=>{
    if(event.source!==top || event.data?.fixture!=="word-command")return;
    void ask(event.data.message).then(result=>post({fixture:"word-reply",requestId:event.data.requestId,result}));
  });
  if(shell){
    const frame=document.createElement("iframe");frame.className="shell-frame";frame.title="Word 内部阅读器";
    const url=new URL(location.href);url.searchParams.set("layer","document");frame.src=url.href;surface.append(frame);
    trace("Word 中间壳已创建，等待内部阅读器");return;
  }
  if(query.get("variant")==="proxy"){
    // The visual document and actual scroll component are siblings, with no
    // document-viewer/reader-content class or known scrollbar library.
    surface.innerHTML='<div id="proxyToolbar" class="toolbar">本地 Word 代理滚动预览 · 固定顶部工具栏</div><div id="proxyStage" class="proxy-stage is-loading"><div id="proxyRender" class="proxy-renderer"><canvas id="proxyCanvas" aria-label="Word 四页文档画布渲染层"></canvas></div><div id="proxyScroll" class="proxy-scroll-rail" aria-label="文档滚动组件"><div id="proxySpace" class="proxy-space"></div></div><div id="proxyLoading" class="loading">Word 页面正在加载</div></div><div id="wordPosition" class="status proxy-status">固定底部状态栏 · 等待加载</div>';
    const stage=document.querySelector("#proxyStage"),renderer=document.querySelector("#proxyRender"),reader=document.querySelector("#proxyScroll"),spacer=document.querySelector("#proxySpace"),canvas=document.querySelector("#proxyCanvas"),footer=document.querySelector("#wordPosition");
    const pageCount=4,pageHeight=480,gap=24,padding=16,totalHeight=pageCount*pageHeight+(pageCount-1)*gap+padding*2;
    let loaded=false,scrollEvents=0;
    function render(){
      const width=Math.max(1,renderer.clientWidth),height=Math.max(1,renderer.clientHeight);
      if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
      const ctx=canvas.getContext("2d");ctx.fillStyle="#dae2ec";ctx.fillRect(0,0,width,height);
      if(!loaded)return;
      const pageWidth=Math.max(240,Math.min(760,width-32)),left=(width-pageWidth)/2;
      for(let index=0;index<pageCount;index++){
        const top=padding+index*(pageHeight+gap)-reader.scrollTop;
        if(top+pageHeight<0||top>height)continue;
        ctx.fillStyle="#fff";ctx.fillRect(left,top,pageWidth,pageHeight);ctx.strokeStyle="#a9bbd4";ctx.strokeRect(left+.5,top+.5,pageWidth-1,pageHeight-1);
        ctx.fillStyle="#172033";ctx.font="bold 23px sans-serif";ctx.fillText(`Word 第 ${index+1} 页`,left+28,top+52);ctx.font="16px sans-serif";
        const sentences=["渲染画布本身不具备滚动高度。","右侧窄滚动组件与画布是兄弟节点。","每次滚动只更新当前可见页面。","教材外层和上方工具栏应保持不动。","文档读完后继续原教材下方的文字。"];
        for(let line=0;line<10;line++)ctx.fillText(sentences[line%sentences.length],left+28,top+102+line*30);
        ctx.fillStyle="#52739b";ctx.font="13px sans-serif";ctx.fillText(`第 ${index+1} / ${pageCount} 页 · 本地虚构内容`,left+28,top+450);
      }
      canvas.dataset.page=String(Math.min(pageCount,Math.floor(reader.scrollTop/(pageHeight+gap))+1));
      canvas.dataset.position=String(Math.round(reader.scrollTop));
    }
    function geometry(){
      const position=Math.round(reader.scrollTop),maximum=Math.max(0,reader.scrollHeight-reader.clientHeight),pages=loaded?pageCount:0;
      const toolbar=document.querySelector("#proxyToolbar").getBoundingClientRect(),foot=footer.getBoundingClientRect();
      footer.textContent=`代理滚动 ${position}/${maximum} · 固定工具栏 · ${pages} 页 · 事件 ${scrollEvents}`;
      post({fixture:"word-geometry",variant:"proxy",position,maximum,pages,loaded,outer:document.scrollingElement.scrollTop,
        scrollEvents,renderPosition:Number(canvas.dataset.position)||0,page:Number(canvas.dataset.page)||0,
        proxyWidth:reader.clientWidth,proxyHeight:reader.clientHeight,renderHeight:renderer.scrollHeight,
        toolbarTop:Math.round(toolbar.top),toolbarBottom:Math.round(toolbar.bottom),footerTop:Math.round(foot.top)});
    }
    reader.addEventListener("scroll",()=>{scrollEvents++;render();geometry();},{passive:true});
    addEventListener("resize",()=>{render();geometry();});
    setTimeout(()=>{loaded=true;spacer.style.height=`${totalHeight}px`;document.querySelector("#proxyLoading").remove();stage.classList.remove("is-loading");render();geometry();trace("Word 四页代理滚动组件已加载：窄滚动条与独立画布为兄弟节点");},Math.max(0,Math.min(10000,Number(query.get("delay"))||0)));
    setInterval(geometry,500);render();geometry();return;
  }
  surface.innerHTML='<div class="toolbar">本地 Word 文档预览 · 四页虚构内容</div><div class="doc-outer"><div class="doc-shell"><div id="wordScroll" class="document-viewer"><div class="loading">Word 文档正在加载</div></div></div></div><div id="wordPosition" class="status">正在准备页面</div>';
  const reader=document.querySelector("#wordScroll");
  let loaded=false;
  function geometry(){
    const position=Math.round(reader.scrollTop),maximum=reader.scrollHeight-reader.clientHeight,pages=reader.querySelectorAll(".page").length;
    document.querySelector("#wordPosition").textContent=`Word 滚动 ${position}/${maximum} · ${pages} 页 · 文档外页 ${document.scrollingElement.scrollTop}`;
    post({fixture:"word-geometry",position,maximum,pages,loaded,outer:document.scrollingElement.scrollTop});
  }
  function load(){
    const text="这是一页本地虚构的 Word 文档。每一页都保留独立的版面和段落，以验证内容脚本只滚动文档内部的实际阅读组件。读完第四页后，应当返回原教材的位置并继续下方文字，整个任务标识不应变化。";
    reader.innerHTML=Array.from({length:4},(_,index)=>`<section class="page"><h1>Word 第 ${index+1} 页</h1>${Array.from({length:3},(_,paragraph)=>`<p>段落 ${paragraph+1}。${text}</p>`).join("")}</section>`).join("");
    if(query.get("variant")==="canvas")for(const page of reader.querySelectorAll(".page")){
      const canvas=document.createElement("canvas");canvas.width=760;canvas.height=480;const ctx=canvas.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,760,480);ctx.fillStyle="#172033";ctx.font="24px sans-serif";ctx.fillText(page.querySelector("h1").textContent,48,70);ctx.font="17px sans-serif";for(let line=0;line<9;line++)ctx.fillText(`本地文档渲染页 · 验证内部滚动连续性 ${line+1}`,48,120+line*32);page.replaceChildren(canvas);
    }
    loaded=true;geometry();trace(`Word 四页${query.get("variant")==="canvas"?"画布":"文本"}已加载`);
  }
  reader.addEventListener("scroll",geometry,{passive:true});
  setTimeout(load,Math.max(0,Math.min(10000,Number(query.get("delay"))||0)));
  setInterval(geometry,500);geometry();
})();
