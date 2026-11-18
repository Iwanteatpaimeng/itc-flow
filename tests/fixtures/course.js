"use strict";

(() => {
  let current = 0;
  let videoUrl = "";
  let readerRevision = 0;
  const tasks = [...document.querySelectorAll(".task-item")];
  const names = ["认识计算机网络", "数据传输演示", "网络学习讲义", "图文课程：先读正文再看演示", "顺序课程：两段视频与夹心、尾部文字", "章节测验"];
  let observedReadBlocks = new Set();
  const paragraphs = [
    "计算机网络通过通信链路连接不同设备，让数据能够在设备之间可靠传递。网络学习从理解物理连接、地址、路由和传输开始。在实际工作中，理解每层职责可以帮助定位故障，并建立清晰的排查顺序。",
    "数据在发送端被分段和封装，经过交换设备和路由设备后到达接收端。每一跳都会根据对应的信息选择下一步的路径。观察这些过程，可以把抽象的协议概念与真实的设备操作联系起来。",
    "阅读本节时，可以记录三个问题：数据从哪里来、如何找到目的地、遇到传输失败会发生什么。之后通过实验验证每个问题，比单纯记住术语更容易形成稳定的知识结构。"
  ];

  function log(message) {
    const entry = `${new Date().toLocaleTimeString()} ${message}`;
    document.querySelector("#fixtureLog").textContent += entry + "\n";
    if (/read region|video \d|platform completed|task changed/.test(message)) {
      const trace = document.querySelector("#readingOrderTrace");
      trace.textContent = (trace.textContent + "\n" + entry).split("\n").slice(-8).join("\n");
    }
  }

  function render(index) {
    current = index;
    document.querySelectorAll("video").forEach(video => video.pause());
    observedReadBlocks = new Set();
    tasks.forEach((task, taskIndex) => {
      task.classList.toggle("active", taskIndex === index);
      if (taskIndex === index) task.setAttribute("aria-current", "true");
      else task.removeAttribute("aria-current");
    });
    document.title = names[index] + " · ICT 本地课程";
    history.replaceState(null, "", `#task=${tasks[index].dataset.taskId}`);
    document.querySelector("#courseTitle").textContent = names[index];
    document.querySelector("#taskType").textContent = ["文本阅读", "视频播放", "文档阅读", "文字 + 下方视频", "同页两段视频 + 三段正文", "章节测验"][index];
    const body = document.querySelector("#courseBody");
    body.style.paddingBottom = "";
    body.replaceChildren();
    if (index === 1 || index === 3) {
      if (index === 3) {
        const article = document.createElement("article");
        article.className = "reader-content";
        article.style.cssText = "height:auto;overflow:visible;margin-bottom:24px";
        for (let item = 0; item < 10; item++) {
          const p = document.createElement("p");
          p.textContent = `正文 ${item + 1}. ${paragraphs[item % paragraphs.length]}`;
          article.append(p);
        }
        body.append(article);
        body.style.paddingBottom = "70vh";
      }
      const video = document.createElement("video");
      video.controls = true;
      video.playsInline = true;
      video.dataset.courseVideo = "true";
      if (videoUrl) video.src = videoUrl;
      video.addEventListener("play", () => log("video play"));
      video.addEventListener("pause", () => log(`video pause @ ${video.currentTime.toFixed(2)}`));
      video.addEventListener("ended", () => log("video ended; still on the current task"));
      body.append(video);
    } else if (index === 4) {
      for (const [order, label] of [[0, "前置文字"], [1, "夹心文字"], [2, "尾部文字"]]) {
        const section = document.createElement("article");
        section.className = "reader-content";
        section.dataset.readOrder = label;
        section.style.cssText = "height:auto;overflow:visible;margin:24px 0";
        const heading = document.createElement("h3");
        heading.textContent = label;
        section.append(heading);
        for (let item = 0; item < 4; item++) {
          const p = document.createElement("p");
          p.textContent = `${label} ${item + 1}. ${paragraphs[(order + item) % paragraphs.length]}`;
          section.append(p);
        }
        body.append(section);
        if (order < 2) {
          const video = document.createElement("video");
          video.controls = true;
          video.playsInline = true;
          video.dataset.courseVideo = "true";
          video.dataset.sequence = String(order + 1);
          if (videoUrl) video.src = videoUrl;
          video.addEventListener("play", () => log(`video ${order + 1} play`));
          video.addEventListener("pause", () => log(`video ${order + 1} pause @ ${video.currentTime.toFixed(2)}`));
          video.addEventListener("ended", () => log(`video ${order + 1} ended; continue the same page`));
          body.append(video);
        }
      }
    } else if (index === 5) {
      const section = document.createElement("section");
      section.className = "quiz-content";
      section.innerHTML = '<p>请手动完成本节测验：IP 地址用于什么目的？</p><label><input type="radio" name="quiz"> 标识网络中的设备</label>';
      body.append(section);
    } else {
      const article = document.createElement("article");
      article.className = index === 2 ? "reader-content document-viewer" : "reader-content";
      if (index === 2) article.dataset.document = "true";
      for (let item = 0; item < 18; item++) {
        const p = document.createElement("p");
        p.textContent = `${item + 1}. ${paragraphs[item % paragraphs.length]}`;
        article.append(p);
      }
      article.addEventListener("scroll", () => log(`reader scroll ${Math.round(article.scrollTop)}`), { passive: true });
      body.append(article);
    }
    const platformCompleted = tasks[index].getAttribute("data-completed") === "true";
    document.querySelector("#platformCompleteCheck").checked = platformCompleted;
    document.querySelector("#platformComplete").hidden = !platformCompleted;
    document.querySelector("#nextTask").disabled = index === tasks.length - 1;
    log(`task changed: ${tasks[index].dataset.taskId}`);
  }

  tasks.forEach((task, index) => task.addEventListener("click", () => render(index)));
  document.querySelector("#nextTask").addEventListener("click", () => {
    if (current < tasks.length - 1) {
      log("next-task click");
      render(current + 1);
    }
  });
  document.querySelector("#platformCompleteCheck").addEventListener("change", event => {
    const complete = event.target.checked;
    tasks[current].setAttribute("data-completed", String(complete));
    tasks[current].classList.toggle("is-completed", complete);
    document.querySelector("#platformComplete").hidden = !complete;
    log(`platform completed signal ${complete}; task=${tasks[current].dataset.taskId}`);
  });
  addEventListener("scroll", () => {
    for (const section of document.querySelectorAll("[data-read-order]")) {
      const rect = section.getBoundingClientRect();
      const key = section.dataset.readOrder;
      if (rect.top <= innerHeight / 2 && rect.bottom >= innerHeight / 2 && !observedReadBlocks.has(key)) {
        observedReadBlocks.add(key);
        log(`read region in viewport: ${key}`);
      }
    }
  }, { passive: true });
  document.querySelector("#readerBottom").addEventListener("click", () => {
    const reader = document.querySelector(".reader-content");
    if (reader) { reader.scrollTop = reader.scrollHeight; log("manually reached reader bottom; no task completion is inferred"); }
  });
  document.querySelector("#videoOffscreen").addEventListener("click", () => {
    const video = document.querySelector("video");
    if (!video) return;
    video.style.marginTop = "110vh";
    document.querySelector("#courseBody").style.paddingBottom = "65vh";
    window.scrollTo({ top: 0, behavior: "instant" });
    log("player moved below viewport for centering validation");
  });
  document.querySelector("#videoCentered").addEventListener("click", () => {
    const video = document.querySelector("video");
    if (video) { video.scrollIntoView({ block: "center", behavior: "instant" }); log("player centered manually"); }
  });
  document.querySelector("#reuseReaderPage").addEventListener("click", () => {
    const reader = document.querySelector(".reader-content");
    if (!reader) return;
    readerRevision++;
    const title = `复用正文的手动页面 ${readerRevision}`;
    reader.replaceChildren();
    for (let item = 0; item < 18; item++) {
      const p = document.createElement("p");
      p.textContent = `第 ${readerRevision} 页，第 ${item + 1} 段。${paragraphs[item % paragraphs.length]}`;
      reader.append(p);
    }
    reader.scrollTop = 0;
    document.querySelector("#courseTitle").textContent = title;
    document.title = title + " · ICT 本地课程";
    location.hash = `manual-reader-${readerRevision}`;
    log(`same reader node reused; manual route ${readerRevision}`);
  });

  // Record a three-second, silent HTML5 clip in-browser. This avoids remote
  // media/network dependencies while exercising real play/ended events.
  async function makeVideo() {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      document.querySelector("#fixtureNotice").textContent = "当前浏览器无法生成测试视频，可手动指定 video.src。";
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(20);
    const supportedType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, supportedType ? { mimeType: supportedType } : undefined);
    const chunks = [];
    const start = performance.now();
    let animation;
    function draw() {
      const seconds = (performance.now() - start) / 1000;
      context.fillStyle = "#0f172a";
      context.fillRect(0, 0, 960, 540);
      context.fillStyle = "#93c5fd";
      context.font = "40px sans-serif";
      context.fillText("LOCAL COURSE VIDEO", 220, 225);
      context.fillStyle = "#ffffff";
      context.font = "28px sans-serif";
      context.fillText(`Network packet demo · ${seconds.toFixed(1)} s`, 245, 290);
      context.fillStyle = "#2563eb";
      context.fillRect(120, 370, Math.min(720, seconds * 240), 8);
      animation = requestAnimationFrame(draw);
    }
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      cancelAnimationFrame(animation);
      stream.getTracks().forEach((track) => track.stop());
      videoUrl = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
      document.querySelectorAll("video").forEach(video => { if (!video.src) video.src = videoUrl; });
      document.querySelector("#fixtureNotice").textContent = "本地 3 秒视频已就绪。第 5 项可验证同页顺序学习，只有开启平台完成信号且内容遍历结束才可自动切换。";
      log("local clip ready");
    };
    draw();
    recorder.start();
    setTimeout(() => recorder.stop(), 3100);
  }

  render(0);
  makeVideo().catch((error) => {
    document.querySelector("#fixtureNotice").textContent = `测试视频生成失败：${error.message}`;
  });
})();
