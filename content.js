/* Runs in the isolated extension world. All course progress comes from normal page events. */
(() => {
  "use strict";
  if (globalThis.__ITC_ENGINE__) return;
  globalThis.__ITC_ENGINE__ = true;

  const DEFAULTS = {
    scrollIntervalSeconds: 10, scrollEnabled: true, autoNext: true, muteVideo: true,
    nextDelaySeconds: 3, selectors: { video: "", document: "", scroll: "", next: "", task: "", activeTask: "", completed: "" }
  };
  const ACTIVE_SELECTORS = [
    "[data-task-id][aria-current='page']", "[data-task-id].active", "[data-task-id].is-active",
    ".task-item.active", ".task-item.current", ".catalog-item.active", ".catalog-item.current",
    ".chapter-item.active", ".lesson-item.active", ".course-item.active", ".section-item.active",
    ".course-catalog [aria-selected='true']", ".course-catalog .active", ".catalog-list .active",
    ".chapter-list .active", ".lesson-list .active", ".el-tree-node.is-current > .el-tree-node__content",
    ".ant-tree-treenode-selected .ant-tree-node-content-wrapper", "[data-testid='current-task']"
  ];
  const TASK_SELECTORS = [
    "[data-task-id]", ".task-item", ".catalog-item", ".lesson-item", ".section-item",
    ".chapter-item[data-id]", ".course-catalog li", ".catalog-list li", ".lesson-list li",
    ".el-tree-node__content", ".ant-tree-node-content-wrapper"
  ];
  const DOC_SELECTORS = [
    "[data-task-type='document']", "[data-task-type='pdf']", "[data-content-type='document']", "[data-type='document']",
    ".document-viewer", ".document-content", ".doc-viewer", ".word-viewer", ".word-content", ".docx-wrapper", ".docx", ".pdf-viewer", ".pdfViewer",
    ".pdf-content", ".ppt-viewer", ".ppt-content", "#viewerContainer", "[data-testid='document-viewer']",
    "embed[type='application/pdf']", "object[type='application/pdf']", "iframe[src*='.pdf']",
    "iframe[src*='pdfjs']", "iframe[src*='pdf-viewer']", "iframe[src*='document-viewer']",
    "iframe[src*='/pdf/']", "iframe[src*='/preview/'][title*='文档']", "iframe[src*='/preview/'][title*='课件']",
    "iframe[src*='/preview/'][title*='document' i]", "iframe[src*='/preview/'][title*='pdf' i]",
    ".viewer-container:has(canvas[data-page-number])", ".viewer-container:has(.pdfViewer)", ".viewer-container:has(embed[type='application/pdf'])"
  ];
  const TEXT_SELECTORS = [
    ".reader-mobile__body #reader-container .reader-chapter-content.w-e-text",
    ".reader-web #reader-container .reader-chapter-content.w-e-text",
    "etextbook-reader-web #reader-container .reader-chapter-content.w-e-text",
    "[data-task-type='text']", "[data-content-type='text']", "[data-type='text']", ".text-content", ".rich-text-content",
    ".lesson-content", ".course-content .article-content", ".learning-content", ".reader-content",
    ".markdown-body", ".article-content", ".courseware-content", ".ql-editor", ".rich-text",
    ".ue-content", ".read-content", ".text-task-content", ".text-viewer", ".reading-content", ".tinymce-content",
    ".course-content", ".content-body", "article", "main [role='document']",
    "[role='main'] [role='document']"
  ];
  const SHORT_READER_SELECTORS = new Set([
    ".reader-mobile__body #reader-container .reader-chapter-content.w-e-text",
    ".reader-web #reader-container .reader-chapter-content.w-e-text",
    "etextbook-reader-web #reader-container .reader-chapter-content.w-e-text",
    "[data-task-type='text']", "[data-content-type='text']", "[data-type='text']", ".reader-content",
    ".text-viewer", ".reading-content", ".ql-editor", ".tinymce-content", ".text-task-content"
  ]);
  const CATALOG_SELECTOR = "nav,aside,[role='navigation'],[role='tree'],.course-catalog,.catalog-list,.chapter-list,.reader-catalog,.reader-left,.catalog-tree,.book-catalog,.book-menu,.toc,.toc-container,.document-outline,.el-tree,.ant-tree";
  const MANUAL_TASK = /(?:考试|测验|测试题|章节测试|随堂测试|随堂练习|章节练习|习题|练习题|考核|实操|实验任务|实验指导|在线实验|直播|问卷|quiz|exam|assessment|live\s*(?:class|session)|hands.on\s*lab)/i;
  const NEXT_TEXT = /^(?:下一(?:个)?(?:项(?:任务)?|节|课|章|讲|任务|章节|视频|课时|单元)|下(?:一)?节(?:课)?|下一个|继续学习|next(?:\s+(?:lesson|task|chapter|video|unit))?)[\s›»→>]*$/i;
  let settings = { ...DEFAULTS, selectors: { ...DEFAULTS.selectors } };
  let current = null;
  let running = false;
  let paused = false;
  let completed = false;
  let watching = false;
  let timerId = null;
  let scrollTimer = null;
  let scrollVerifyTimer = null;
  let scrollMovements = 0;
  let scrollState = "idle";
  let nextScrollAt = 0;
  let currentScrollInterval = 0;
  let observerTimer = null;
  let watchTimer = null;
  let elapsed = 0;
  let lastTick = 0;
  let phase = "idle";
  let detail = "";
  let cleanupMedia = null;
  let seenPlaying = false;
  let lastIdentity = null;
  let lastFrameOrigins = null;
  let lastReportAt = 0;
  let lastNavigationAt = -Infinity;
  let mediaOriginalMuted = null;
  let shadowRoots = [];
  let shadowScanAt = 0;
  let mediaGateTimer = null;
  let mediaGateGeneration = 0;
  let alignmentAllowed = false;
  let readingScrollVerified = false;
  let activeRunId = null;
  let lastContextKey = null;
  let lastCandidateMode = null;
  let flow = null;
  let activeMedia = null;
  let embeddedBinding = null;
  let embeddedCheckpoint = null;
  let pendingEmbeddedToken = null;
  const documentScrollHosts = new WeakMap();
  const documentScrollProxies = new WeakSet();
  let flowGuardCleanup = null;
  let suppressMediaPause = false;
  const viewportRequests = new Map();
  const ancestorTimers = new Set();
  const activeScrollTargets = new Set();
  const VIEWPORT_PROTOCOL = "itc-flow-viewport-v1";

  function send(type, extra = {}) {
    // Never await the worker from a message handler: the worker may be awaiting this frame.
    try { const pending = chrome.runtime.sendMessage({ type, ...extra }); pending?.catch?.(() => {}); }
    catch { /* Extension reload invalidates old isolated worlds. */ }
  }

  function configure(value) {
    const previousMuteSetting = settings.muteVideo;
    const merged = { ...settings, ...(value || {}) };
    merged.selectors = { ...DEFAULTS.selectors, ...settings.selectors, ...(value?.selectors || {}) };
    merged.scrollIntervalSeconds = Math.max(1, Math.min(3600, Number(merged.scrollIntervalSeconds) || DEFAULTS.scrollIntervalSeconds));
    delete merged.readSeconds;
    settings = merged;
    if (previousMuteSetting !== merged.muteVideo && activeMedia && mediaOriginalMuted !== null) {
      activeMedia.muted = merged.muteVideo ? true : mediaOriginalMuted;
    }
  }

  function roots() {
    const now = performance.now();
    if (now - shadowScanAt > 4000 || !shadowScanAt) {
      shadowScanAt = now || 1;
      shadowRoots = [];
      const queue = [document];
      let visited = 0;
      while (queue.length && visited < 6000) {
        const root = queue.shift();
        for (const el of root.querySelectorAll("*")) {
          if (++visited > 6000) break;
          if (el.shadowRoot) { shadowRoots.push(el.shadowRoot); queue.push(el.shadowRoot); }
        }
      }
    }
    return [document, ...shadowRoots.filter(root => root.host?.isConnected)];
  }

  function queryAll(selector, within) {
    if (!selector) return [];
    const result = [];
    for (const root of within ? [within] : roots()) {
      try { result.push(...root.querySelectorAll(selector)); } catch { return []; }
    }
    return [...new Set(result)];
  }

  function invalidSelector() {
    for (const [name, selector] of Object.entries(settings.selectors)) {
      if (!selector) continue;
      try { document.querySelector(selector); }
      catch { return `“${name}”选择器无效，请在设置中检查 CSS 选择器。`; }
    }
    return null;
  }

  function visible(el, minimum = 1) {
    if (!el?.isConnected || el.hidden || el.closest?.("[hidden],[inert],[aria-hidden='true']")) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < minimum || rect.height < minimum) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number(style.opacity) !== 0;
  }

  function text(el) {
    return String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function firstVisible(selectors) {
    for (const selector of selectors) {
      const found = queryAll(selector).find(el => visible(el));
      if (found) return found;
    }
    return null;
  }

  function embeddedFrameOrigins() {
    const origins = new Set();
    for (const frame of queryAll("iframe[src]")) {
      if (!visible(frame)) continue;
      const source = frame.getAttribute("src");
      if (!source) continue;
      try {
        const url = new URL(source, location.href);
        if (/^https?:$/.test(url.protocol) && url.origin !== location.origin) origins.add(url.origin);
      } catch { /* Invalid and opaque sources do not represent grantable hosts. */ }
      if (origins.size >= 8) break;
    }
    return [...origins];
  }

  function frameDiagnostic(frame) {
    const source = frame.getAttribute("src") || "";
    const result = { origin: "", visible: visible(frame), sourceType: "other" };
    if (!source || /^about:(?:blank|srcdoc)(?:$|[#?])/i.test(source) || frame.getAttribute("srcdoc") !== null) {
      result.sourceType = "blank";
      return result;
    }
    try {
      const url = new URL(source, location.href);
      if (/^https?:$/.test(url.protocol)) { result.sourceType = "http"; result.origin = url.origin; }
      else if (/^(?:blob|data):$/.test(url.protocol)) result.sourceType = "opaque";
    } catch { /* Keep malformed/opaque source contents out of exported diagnostics. */ }
    return result;
  }

  function probeDiagnostics(result) {
    const videos = queryAll("video");
    const frames = queryAll("iframe");
    const documents = new Set();
    for (const selector of DOC_SELECTORS) {
      for (const element of queryAll(selector)) {
        if (!element.closest(CATALOG_SELECTOR) && !element.matches("button,a,input,[role='button'],[role='treeitem']")) documents.add(element);
      }
    }
    const regions = new Set();
    const readerCandidates = [];
    for (const selector of TEXT_SELECTORS) {
      for (const element of queryAll(selector)) {
        if (regions.has(element) || element.closest(CATALOG_SELECTOR)) continue;
        regions.add(element);
        if (readerCandidates.length < 8) readerCandidates.push({ selector, textLength: text(element).length, visible: visible(element) });
      }
    }
    let path = "";
    try {
      const page = new URL(location.href);
      if (/^https?:$/.test(page.protocol)) path = page.origin + page.pathname;
    } catch { /* Opaque frames have no shareable path. */ }
    return {
      title: String(document.title || "").slice(0, 180), path,
      readyState: document.readyState || "unknown", reason: result.reason || "matched",
      videoCount: videos.length, visibleVideoCount: videos.filter(video => visible(video, 50)).length,
      iframeCount: frames.length, visibleIframeCount: frames.filter(frame => visible(frame)).length,
      documentCount: documents.size, textRegionCount: regions.size,
      frames: frames.slice(0, 12).map(frameDiagnostic), readerCandidates,
      scrollChains: candidateScrollChains(result.candidate),
      scroll: scrollDiagnostic(result.candidate),
      runtime: { running, paused, phase, scrollState, movements: scrollMovements,
        scrollScheduled: scrollTimer !== null, verifyingScroll: scrollVerifyTimer !== null,
        nextInSeconds: nextScrollAt ? Math.max(0, (nextScrollAt - performance.now()) / 1000) : null,
        expandingVideo: Boolean(flow?.expandingMedia), needsReadingStep: Boolean(flow?.expansionNeedsStep),
        activeVideo: Boolean(activeMedia), delegated: Boolean(flow?.embedded) },
      media: videos.slice(0, 8).map((media, index) => {
        const rect = plainRect(media.getBoundingClientRect());
        const disclosure = textbookDisclosure(media);
        return { index, paused: Boolean(media.paused), ended: Boolean(media.ended), readyState: media.readyState || 0,
          errorCode: media.error?.code || null, rect, viewport: courseViewport(media),
          centered: centeredRect(rect, media), unclipped: unclippedRect(media, rect),
          collapsed: Boolean(disclosure), expansionRequested: Boolean(disclosure?.input.checked) };
      })
    };
  }

  function activeTask() {
    return firstVisible([settings.selectors.activeTask, ...ACTIVE_SELECTORS].filter(Boolean));
  }

  function taskName(active, el) {
    const explicit = el?.getAttribute?.("data-title") || el?.getAttribute?.("aria-label");
    const label = active?.querySelector(".task-title,.lesson-title,.catalog-label,.chapter-name,.el-tree-node__label,.ant-tree-title,[data-task-title],.name,.title");
    const selected = text(label || active);
    if (selected) return selected.slice(0, 180);
    const heading = firstVisible([
      ".lesson-title", ".task-title", ".courseware-title", ".learning-title", ".video-title",
      "main h1", "main h2", "article h1", "[role='main'] h1", "h1"
    ]);
    return (explicit || text(heading) || document.title || "当前课程任务").slice(0, 180);
  }

  function taskContextKey() {
    const active = activeTask();
    if (!active) return "";
    const identity = active.getAttribute("data-task-id") || active.getAttribute("data-id") || active.getAttribute("href") || taskName(active, null);
    return identity ? hash(identity) : "";
  }

  function hash(value) {
    let output = 2166136261;
    for (let i = 0; i < value.length; i++) output = Math.imul(output ^ value.charCodeAt(i), 16777619);
    return (output >>> 0).toString(36);
  }

  function sourceIdentity(el) {
    const raw = el?.getAttribute?.("src") || el?.getAttribute?.("data-src") || el?.querySelector?.("source")?.getAttribute("src") || el?.currentSrc || "";
    if (raw.startsWith("blob:")) return "blob-media";
    try { const url = new URL(raw, location.href); return url.origin + url.pathname; }
    catch { return raw.slice(0, 500); }
  }

  function candidate(type, element, active, score, description) {
    const title = taskName(active, element);
    const textbook = digitalTextbookHost(element);
    // The textbook updates its active chapter as the shared reader scrolls. That
    // chapter selection is a reading position, not a new course task.
    const selectedIdentity = textbook ? "textbook:reader-container" : pendingEmbeddedToken && ["text", "document"].includes(type) ? "embedded-document" : active &&
      (active.getAttribute("data-task-id") || active.getAttribute("data-id") || active.getAttribute("href") || text(active));
    // Selected task identity is stronger than an expiring media URL or player source replacement.
    const key = hash([location.pathname, location.search, location.hash, selectedIdentity || "", selectedIdentity ? "" : title].join("|"));
    // A frame is a document placeholder. Prefer the actual reader in an accessible child frame.
    if (type !== "video" && /^(?:IFRAME|EMBED|OBJECT)$/.test(element.tagName) && !scrollTarget(element)) score = Math.min(score, 40);
    return { type, title, key, score, detail: description, ready: type !== "video" || element.readyState >= 1, element };
  }

  function expose(found) {
    if (!found) return null;
    const { element, nextMedia, flowElement, ...publicCandidate } = found;
    return publicCandidate;
  }

  function readingRegions(activeDoc = false, includeMain = false) {
    const readers = [];
    for (const selector of TEXT_SELECTORS) {
      for (const el of queryAll(selector)) {
        const body = text(el);
        const threshold = activeDoc || SHORT_READER_SELECTORS.has(selector) ? 80 : 100;
        if (!visible(el, 30) || body.length < threshold || el.closest(CATALOG_SELECTOR) || el.matches("button,a,input,[role='button'],[role='treeitem']")) continue;
        if ([".course-content", ".content-body"].includes(selector) && !activeDoc &&
            (!el.querySelector("p,pre,blockquote,[role='document']") || body.length < 160)) continue;
        if (el.querySelector("input[type='password'],form[action*='login']")) continue;
        readers.push({ el, length: body.length });
      }
    }
    if (!readers.length && includeMain) {
      const main = firstVisible(["main", "[role='main']", ".study-content", ".content-container"]);
      if (main && text(main).length >= 160 && main.querySelector("p,pre,blockquote,[role='document']")) readers.push({ el: main, length: text(main).length });
    }
    const unique = [...new Map(readers.map(item => [item.el, item])).values()];
    // Course layout shells often match before their actual editor. Keep the accepted
    // content leaves so a hidden shell cannot become the only scrolling anchor.
    return unique.filter(item => !unique.some(other => item.el !== other.el && item.el.contains(other.el)))
      .sort((left, right) => documentOrder(left.el, right.el));
  }

  function beforeMediaText(region, media) {
    if (!region || region === media || region.closest(CATALOG_SELECTOR)) return 0;
    const readerRect = region.getBoundingClientRect();
    const mediaRect = media.getBoundingClientRect();
    if (!region.contains(media)) {
      const order = region.compareDocumentPosition?.(media);
      if (order !== undefined && !(order & 4)) return 0;
      return readerRect.top < mediaRect.top - 24 ? text(region).length : 0;
    }
    if (typeof document.createRange === "function") {
      try {
        const range = document.createRange();
        range.selectNodeContents(region);
        range.setEndBefore(media);
        const length = String(range.toString()).replace(/\s+/g, " ").trim().length;
        range.detach?.();
        return length;
      } catch { /* A replaced/shadow-root media element can have a different range root. */ }
    }
    let node = media;
    let length = 0;
    while (node && node !== region) {
      const parent = node.parentElement || node.getRootNode?.()?.host;
      if (!parent) break;
      for (const sibling of Array.from(parent.children || [])) {
        if (sibling === node) break;
        if (!sibling.closest?.(CATALOG_SELECTOR) && !sibling.matches?.("video,iframe,button,a,script,style")) length += text(sibling).length;
      }
      node = parent;
    }
    // Direct text nodes in a custom reader may not expose separate block elements.
    return length || (readerRect.top < mediaRect.top - 80 ? text(region).length : 0);
  }

  function readerBeforeMedia(media, readers, doc = null) {
    const mediaScope = media.closest("main,[role='main'],.learning-content,.lesson-content,.course-content");
    const choices = [...(doc ? [{ el: doc, type: "document" }] : []), ...readers.map(item => ({ ...item, type: "text" }))];
    for (const item of choices) {
      if (/^(?:IFRAME|EMBED|OBJECT)$/.test(item.el.tagName)) continue;
      const scope = item.el.closest("main,[role='main'],.learning-content,.lesson-content,.course-content");
      if (mediaScope && scope && mediaScope !== scope && !scope.contains(mediaScope) && !mediaScope.contains(scope)) continue;
      if (beforeMediaText(item.el, media) >= 80 ||
          (item.type === "document" && !item.el.contains(media) && item.el.getBoundingClientRect().top < media.getBoundingClientRect().top - 24)) return item;
    }
    return null;
  }

  function mixedMediaCandidate(media, readers, doc, active) {
    const intro = readerBeforeMedia(media, readers, doc);
    if (!intro) return null;
    // Keep an accepted player active when the user scrolls while it plays or while its next-task delay runs.
    if (activeMedia === media && candidate("video", media, active, 0, "").key === current?.key) return { naturalPlayback: true };
    const rect = plainRect(media.getBoundingClientRect());
    const readerTarget = scrollTarget(intro.el);
    const unreadIndependentReader = readerTarget && !readerTarget.contains(media) && readerTarget.scrollTop < readerTarget.scrollHeight - readerTarget.clientHeight - 2;
    const holdingScroll = current?.readingBeforeVideo && current.nextMedia === media && !readingScrollVerified;
    if (centeredRect(rect, media) && unclippedRect(media, rect) && !holdingScroll && !unreadIndependentReader) return { naturalPlayback: true };
    const found = candidate(intro.type, intro.el, active, 200, "先按间隔阅读前置文字，滚动确认后再检测视频位置");
    return { ...found, readingBeforeVideo: true, nextMedia: media };
  }

  function detectSurface() {
    // A hidden same-origin iframe can retain a fully laid-out video from the previous task.
    try {
      const containingFrame = globalThis.frameElement;
      if (containingFrame && !visible(containingFrame)) return { candidate: null, reason: "hidden_frame" };
    } catch { /* A cross-origin frame exposes no parent DOM. */ }
    const error = invalidSelector();
    if (error) return { candidate: null, reason: "invalid_selector", error };
    const active = activeTask();
    const selectedText = text(active);
    const selectedType = active?.getAttribute("data-type") || active?.getAttribute("data-task-type") || active?.getAttribute("data-content-type") || "";
    if (active && (MANUAL_TASK.test(selectedText) || /^(?:quiz|exam|test|assessment|exercise|lab|live)$/i.test(selectedType))) {
      return { candidate: null, reason: "manual_action", detail: `“${selectedText.slice(0, 80)}”需要手动处理，请完成后继续。` };
    }
    const activeDoc = /(?:文本|文档|课件|阅读|教材|pdf|ppt|document|reading)/i.test(selectedText) || /^(?:text|document|pdf|ppt|reading)$/i.test(selectedType);
    // A task entry may carry data-type="document" too. Only a content surface can be a reader.
    let doc = settings.selectors.document ? firstVisible([settings.selectors.document]) : null;
    if (!doc) {
      for (const selector of DOC_SELECTORS) {
        doc = queryAll(selector).find(el => visible(el) && !el.closest(CATALOG_SELECTOR) && !el.matches("button,a,input,[role='button'],[role='treeitem']"));
        if (doc) break;
      }
    }
    if (!doc && activeDoc) doc = firstVisible(["iframe[src*='/preview/']"]);
    if (doc && pendingEmbeddedToken && !/^(?:IFRAME|EMBED|OBJECT)$/.test(doc.tagName) &&
        !queryAll("iframe", doc).some(frame => visible(frame, 50) && !frame.closest(CATALOG_SELECTOR))) {
      const proxyScope = embeddedDocumentProxy(doc);
      if (proxyScope) documentScrollHosts.set(doc, documentScrollHosts.get(proxyScope));
    }
    const videoElements = queryAll(settings.selectors.video || "video")
      .flatMap(el => el.tagName === "VIDEO" ? [el] : queryAll("video", el))
      .filter(el => visible(el, 50) && !el.loop && !el.closest("[data-ad],.advertisement,.advert,.ad-player,.preview-player,[data-preview='true']"));
    const videos = videoElements.map(el => {
      const rect = el.getBoundingClientRect();
      const scoped = Boolean(el.closest("main,[role='main'],.video-player,.course-player,.lesson-player,.player-container,.learning-content"));
      const score = 100 + Math.min(20, rect.width * rect.height / 20000) + (scoped ? 8 : 0) - (activeDoc ? 45 : 0);
      return candidate("video", el, active, score, "已识别 HTML5 视频");
    }).sort((a, b) => b.score - a.score);
    const readers = readingRegions(activeDoc);
    const media = videos[0]?.element || queryAll("iframe").find(frame => visible(frame, 50) && !frame.closest(CATALOG_SELECTOR) &&
      !frame.closest("[data-ad],.advertisement,.advert,.ad-player"));
    if (media) {
      const mixed = mixedMediaCandidate(media, readers.length ? readers : readingRegions(activeDoc, true), doc, active);
      if (mixed?.readingBeforeVideo) return { candidate: mixed };
      if (mixed?.naturalPlayback && videos.length) videos[0].naturalPlayback = true;
    }
    if (doc && (activeDoc || !videos.length)) {
      return { candidate: candidate("document", doc, active, activeDoc ? 95 : 80, "已识别文档 / 课件阅读区域") };
    }
    if (videos.length) return { candidate: videos[0] };
    if (doc) return { candidate: candidate("document", doc, active, 80, "已识别文档 / 课件阅读区域") };
    // Recognized textbook/content readers always outrank the generic embedded
    // document fallback. An iframe binding does not make the whole app Word.
    if (readers.length) {
      return { candidate: candidate("text", readers[0].el, active, 55, "已识别正文阅读区域") };
    }

    // Some embedded Office previews render pages as images/canvases and expose
    // no article text or conventional viewer class. Only inspect these after
    // their actual parent has handed over this frame, never a site-wide shell.
    if (pendingEmbeddedToken && !queryAll("iframe").some(frame => visible(frame, 50) && !frame.closest(CATALOG_SELECTOR))) {
      const surface = queryAll("*").slice(0, 2000).filter(el => {
        if (!canScroll(el) || el.clientWidth < 240 || el.clientHeight < 160 || el.closest(CATALOG_SELECTOR)) return false;
        return queryAll("canvas,img,svg", el).some(page => !page.closest(CATALOG_SELECTOR) && visible(page, 80) &&
          page.getBoundingClientRect().width >= 240 && page.getBoundingClientRect().height >= 160) ||
          queryAll("p,pre,blockquote,[role='document']", el).some(block =>
            !block.closest(CATALOG_SELECTOR) && !block.querySelector(CATALOG_SELECTOR) && visible(block, 30) && text(block).length >= 160);
      }).sort((left, right) => Number(left === document.scrollingElement) - Number(right === document.scrollingElement) ||
        Number(right.contains(left)) - Number(left.contains(right)) || documentOrder(left, right))[0];
      if (surface) return { candidate: candidate("document", surface, active, 85, "已识别内嵌文档的独立滚动阅读区域") };
      const proxy = embeddedDocumentProxy();
      if (proxy) return { candidate: candidate("document", proxy, active, 85, "已识别内嵌文档的渲染层与独立滚动组件") };
    }

    // A named text task may use a custom div, but a title alone never counts as a reader.
    if (activeDoc) {
      const main = firstVisible(["main", "[role='main']", ".course-content", ".study-content", ".content-container"]);
      if (main && text(main).length >= 160) return { candidate: candidate("text", main, active, 50, "已识别课程阅读内容") };
    }
    const visibleFrames = queryAll("iframe").filter(el => visible(el));
    if (visibleFrames.length) return { candidate: null, reason: "not_found", detail: `检测到 ${visibleFrames.length} 个内嵌页面，正文或播放器可能在其中；请检查内嵌页面访问权限后重新识别。` };
    const allVideos = queryAll("video");
    if (allVideos.length && !allVideos.some(el => visible(el, 50))) {
      return { candidate: null, reason: "not_found", detail: "页面存在视频元素，但播放器尚未显示。请先打开具体视频课时，再重新识别。" };
    }
    const hasShortReader = TEXT_SELECTORS.some(selector => queryAll(selector).some(el => visible(el, 30) && text(el).length > 0 && !el.closest(CATALOG_SELECTOR)));
    return { candidate: null, reason: "not_found", detail: hasShortReader
      ? "已找到可能的正文，但内容过短或尚未加载完整；请等待页面加载，或在网站适配中指定正文区域。"
      : "当前页面没有匹配到视频、文档或正文。请进入具体课时；若内容已显示，可复制识别诊断以适配此页面。" };
  }

  function detect() {
    const result = detectSurface();
    let found = result.candidate;
    if (!found && result.reason === "not_found" && flow?.root?.isConnected &&
        digitalTextbookHost(flow.root) === flow.root && visible(flow.root, 30)) {
      const pending = candidate("text", flow.root, activeTask(), 160, "等待下一章节内容加载，保留当前阅读进度");
      if (pending.key === current?.key) found = { ...pending, chapterLoading: true };
    }
    if (!found && result.reason === "not_found" && embeddedBinding && current?.type === "document" &&
        flow?.root?.isConnected && visible(flow.root, 30)) {
      const pending = candidate("document", flow.root, activeTask(), 85, "等待内嵌文档更新，保留当前阅读进度");
      if (pending.key === current.key) found = { ...pending, documentLoading: true };
    }
    if (!found && result.reason === "not_found") {
      const frame = queryAll("iframe").find(item => visible(item, 50) && !item.closest(CATALOG_SELECTOR) && !item.closest("[data-ad],.advertisement,.advert"));
      if (frame) found = candidate("document", frame, activeTask(), 70, "已识别内嵌课程内容，将按页面顺序处理");
    }
    if (!found) return result;
    const scope = taskContentScope(found.element);
    let frameDepth = 0;
    try {
      let ancestor = globalThis;
      while (ancestor.parent && ancestor.parent !== ancestor && frameDepth < 20) { ancestor = ancestor.parent; frameDepth += 1; }
    } catch { frameDepth = 20; }
    return { ...result, candidate: { ...found, flowRoot: true, flowElement: scope,
      frameTransport: isFrameTransport(found.element),
      frameDepth, taskCompleteConfirmed: platformComplete(scope), score: Math.max(found.score, 160) } };
  }

  function isFrameTransport(element) {
    if (element?.tagName !== "IFRAME") return false;
    if (readingRegions(false, true).length || queryAll("video").some(item => visible(item, 30))) return false;
    // A shell that only embeds the lesson has no reading position of its own.
    // Keep pages with substantive surrounding text in the normal ordered flow.
    return !queryAll("p,pre,blockquote,article,[role='document']").some(item =>
      visible(item, 30) && !item.closest(CATALOG_SELECTOR) && text(item).length >= 80);
  }

  function taskContentScope(element) {
    const textbook = digitalTextbookHost(element);
    if (textbook) return textbook;
    if (pendingEmbeddedToken && documentScrollHosts.has(element)) return element;
    const scope = element.closest("main,[role='main'],.lesson-content,.learning-content,.course-content,.study-content") || element;
    const explicit = queryAll(settings.selectors.scroll).filter(item => visible(item, 30) && !item.closest(CATALOG_SELECTOR) && item.contains(element)).sort(documentOrder);
    if (explicit.length) return explicit.find(item => !explicit.some(other => item !== other && item.contains(other))) || explicit[0];
    const landmark = scope.matches?.("main,[role='main']") ? scope : scope.closest?.("main,[role='main']");
    if (!landmark || landmark === scope) return scope;
    const related = [...readingRegions(false, true).map(item => item.el), ...queryAll("video"), ...queryAll("iframe")]
      .filter(item => visible(item, 30) && !item.closest(CATALOG_SELECTOR) && !item.closest("[data-ad],.advertisement,.advert,.preview-player,[data-preview='true']"));
    let ancestor = scope.parentElement || scope.getRootNode?.()?.host;
    const seen = new Set();
    while (ancestor && !seen.has(ancestor) && landmark.contains(ancestor)) {
      seen.add(ancestor);
      if (preferredScrollHost(ancestor) && related.some(item => ancestor.contains(item) && !scope.contains(item))) return ancestor;
      if (ancestor === landmark) break;
      ancestor = ancestor.parentElement || ancestor.getRootNode?.()?.host;
    }
    return scope;
  }

  function platformComplete(scope = flow?.root) {
    if (settings.selectors.completed) return queryAll(settings.selectors.completed).some(item => visible(item));
    const selected = activeTask();
    if (selected && finishedItem(selected)) return true;
    if (!scope) return false;
    const marker = "[data-current-task-completed='true'],[data-task-completed='true']";
    return scope.matches?.(marker) || queryAll(marker, scope).some(item => visible(item) && !item.closest(CATALOG_SELECTOR));
  }

  function inFlowScope(element) {
    if (!flow?.root || !element) return false;
    return flow.root === element || flow.root.contains(element);
  }

  function pageMedia() {
    const videos = queryAll(settings.selectors.video || "video").flatMap(item => item.tagName === "VIDEO" ? [item] : queryAll("video", item));
    const frames = queryAll("iframe");
    return [...new Set([...videos, ...frames])].filter(item => inFlowScope(item) && visible(item, 30) && !item.loop &&
      !item.closest(CATALOG_SELECTOR) && !item.closest("[data-ad],.advertisement,.advert,.ad-player,.preview-player,[data-preview='true']"))
      .sort((left, right) => {
        const relation = left.compareDocumentPosition?.(right);
        if (relation !== undefined && relation & 4) return -1;
        if (relation !== undefined && relation & 2) return 1;
        return left.getBoundingClientRect().top - right.getBoundingClientRect().top;
      });
  }

  function mediaId(element, items = pageMedia()) {
    const textbook = digitalTextbookHost(element);
    const explicit = element.getAttribute?.("data-video-id") || element.getAttribute?.("data-media-id") || element.getAttribute?.("id") || "";
    if (textbook && explicit) {
      const chapter = element.closest?.(".reader-chapter-content.w-e-text");
      // Virtual chapters may recreate a video with a fresh temporary URL.
      return hash(`textbook|${chapter?.getAttribute?.("id") || ""}|${element.tagName}|${explicit}`);
    }
    const identity = item => {
      const raw = item.currentSrc || item.getAttribute?.("src") || "";
      return raw.startsWith("blob:") ? `blob-${hash(raw)}` : sourceIdentity(item);
    };
    const source = identity(element);
    const ordinal = items.filter(item => item.tagName === element.tagName && identity(item) === source).indexOf(element);
    return hash(`${element.tagName}|${source}|${explicit || ordinal}`);
  }

  function nextFlowMedia() {
    const items = pageMedia();
    return items.find(item => !flow.played.has(mediaId(item, items))) || null;
  }

  function flowReaders() {
    if (!flow) return [];
    const selected = readingRegions(false, true).map(item => item.el).filter(inFlowScope);
    const documentReaders = DOC_SELECTORS.flatMap(selector => queryAll(selector)).filter(item => inFlowScope(item) && !item.closest(CATALOG_SELECTOR) && !/^(?:IFRAME|EMBED|OBJECT)$/.test(item.tagName) && visible(item, 30));
    const readers = [...new Set([...(current?.type !== "video" ? [current?.element] : []), ...selected, ...documentReaders]
      .filter(item => item && !/^(?:IFRAME|EMBED|OBJECT)$/.test(item.tagName)))];
    return readers.filter(item => !readers.some(other => item !== other && item.contains(other))).sort(documentOrder);
  }

  function documentOrder(left, right) {
    if (left === right) return 0;
    const relation = left.compareDocumentPosition?.(right);
    if (relation !== undefined && !(relation & 1)) {
      if (relation & 4) return -1;
      if (relation & 2) return 1;
    }
    return left.getBoundingClientRect().top - right.getBoundingClientRect().top;
  }

  function localReadingTarget(element) {
    if (!element || /^(?:IFRAME|EMBED|OBJECT)$/.test(element.tagName)) return null;
    const boundary = flow?.scrollRoot;
    const allowed = item => !boundary || item === boundary || boundary.contains(item);
    const textbook = digitalTextbookHost(element);
    if (textbook && allowed(textbook) && canScroll(textbook)) return textbook;
    const documentHost = documentScrollHosts.get(element);
    if (documentHost?.isConnected && allowed(documentHost) && canScroll(documentHost)) return documentHost;
    const inside = queryAll("*", element).slice(0, 1400).filter(item => allowed(item) && canScroll(item)).sort(documentOrder);
    const ancestors = [];
    let parent = element.parentElement || element.getRootNode?.()?.host;
    const seen = new Set();
    while (parent && !seen.has(parent) && allowed(parent)) {
      seen.add(parent);
      if (canScroll(parent)) ancestors.push(parent);
      if (parent === boundary) break;
      parent = parent.parentElement || parent.getRootNode?.()?.host;
    }
    if (allowed(element) && canScroll(element) && preferredScrollHost(element)) return element;
    const nestedHost = inside.find(knownScrollHost);
    if (nestedHost) return nestedHost;
    if (allowed(element) && canScroll(element) && getComputedStyle(element).overflowY === "hidden" && !inside.some(preferredScrollHost)) return element;
    // Native scrollbar hosts and recognized custom hosts are stronger than broad
    // overflow-hidden application shells. Retain generic hidden readers as a fallback.
    return ancestors.find(preferredScrollHost) || inside.find(preferredScrollHost) ||
      (allowed(element) && canScroll(element) ? element : null) || inside[0] || ancestors[0] || null;
  }

  function knownScrollHost(element) {
    const classes = String(element?.className?.baseVal || element?.className || "").split(/\s+/);
    return classes.some(name => ["el-scrollbar__wrap", "simplebar-content-wrapper", "ps"].includes(name));
  }

  function preferredScrollHost(element) {
    if (!element || element === document.scrollingElement || viewportScrollAlias(element)) return false;
    const overflow = getComputedStyle(element).overflowY;
    return /^(?:auto|scroll|overlay)$/.test(overflow) || overflow !== "clip" && knownScrollHost(element);
  }

  function digitalTextbookHost(element) {
    const host = element?.closest?.("#reader-container");
    return host && host.closest(".reader-mobile__body,.reader-web,.reader-ehep-web,etextbook-reader-web") ? host : null;
  }

  function digitalTextbookLeaf(element) {
    return Boolean(element?.matches?.(".reader-chapter-content.w-e-text") && digitalTextbookHost(element));
  }

  function textbookDisclosure(media) {
    const host = digitalTextbookHost(media);
    if (!host || !media.matches?.("video.insertVideo")) return null;
    const wrapper = media.closest(".element-new");
    const row = wrapper?.closest("span.td");
    if (!wrapper || !row || !host.contains(row) || wrapper.clientHeight > 2 || getComputedStyle(wrapper).overflowY !== "hidden") return null;
    const input = queryAll("input.insertVideoCheck", row).find(item => {
      const id = item.getAttribute("id") || "";
      return id.startsWith("check_") && !disabled(item) && row.contains(item);
    });
    if (!input) return null;
    const suffix = input.getAttribute("id").slice(6);
    const title = queryAll(".videoTitlepc-new", row).find(item => item.getAttribute("id") === `video_title_span_${suffix}`);
    if (!title || !visible(title)) return null;
    return { input, anchor: title, wrapper };
  }

  function flowMediaAnchor(media) {
    return textbookDisclosure(media)?.anchor || media;
  }

  function isScrollPort(element) {
    if (!element || element === document.scrollingElement || viewportScrollAlias(element) || !visible(element, 30) || element.closest?.(CATALOG_SELECTOR) || digitalTextbookLeaf(element)) return false;
    const overflow = getComputedStyle(element).overflowY;
    return /^(?:auto|scroll|overlay)$/.test(overflow) || overflow === "hidden" &&
      (element === flow?.root || knownScrollHost(element) || significantHiddenRange(element));
  }

  function significantHiddenRange(element) {
    return element.scrollHeight - element.clientHeight > Math.max(8, element.clientHeight * 0.03);
  }

  function courseScrollRoot() {
    const scope = flow.root;
    const documentHost = documentScrollHosts.get(scope);
    if (documentHost?.isConnected && scope.contains(documentHost) && canScroll(documentHost)) return documentHost;
    // Use the common content ancestor so a text-only reader can own its scrolling,
    // while text and sibling videos share their enclosing lesson panel.
    const portFor = anchors => {
      let shared = anchors[0] || scope;
      const seen = new Set();
      while (shared && !seen.has(shared) && anchors.some(item => !shared.contains(item))) {
        seen.add(shared); shared = shared.parentElement || shared.getRootNode?.()?.host;
      }
      seen.clear();
      let ancestor = shared || scope;
      while (ancestor && !seen.has(ancestor)) {
        seen.add(ancestor);
        if (isScrollPort(ancestor)) return ancestor;
        ancestor = ancestor.parentElement || ancestor.getRootNode?.()?.host;
      }
      return null;
    };
    const identified = [...new Set([...flowReaders(), ...pageMedia()])];
    const explicit = queryAll(settings.selectors.scroll).filter(item => visible(item, 30) && !item.closest(CATALOG_SELECTOR) &&
      identified.length && identified.every(anchor => item === anchor || item.contains(anchor))).sort(documentOrder);
    if (explicit.length) return explicit.find(item => !explicit.some(other => item !== other && item.contains(other))) || explicit[0];
    const textbook = [...new Set(identified.map(digitalTextbookHost).filter(Boolean))].find(item => visible(item, 30) && identified.length &&
      identified.every(anchor => item === anchor || item.contains(anchor)));
    if (textbook) return textbook;
    const identifiedPort = portFor(identified);
    if (identifiedPort) return identifiedPort;
    // Generic help text outside a recognized reader cannot widen its boundary.
    const blocks = queryAll("p,pre,blockquote,article,[role='document']", scope)
      .filter(item => visible(item, 30) && !item.closest(CATALOG_SELECTOR));
    const anchors = [...new Set([...identified, ...blocks])];
    const leaves = anchors.filter(item => !anchors.some(other => item !== other && item.contains(other)));
    return portFor(leaves) || document.scrollingElement;
  }

  function flowTargets() {
    if (flow?.frameTransport) return [];
    const targets = [];
    const boundary = flow?.scrollRoot || document.scrollingElement;
    const add = element => {
      if (element && (element === boundary || boundary?.contains(element)) && canScroll(element) && !targets.includes(element)) targets.push(element);
    };
    const addChain = anchor => {
      let host = localReadingTarget(anchor);
      const seen = new Set();
      while (host && !seen.has(host) && (host === boundary || boundary?.contains(host))) {
        seen.add(host); add(host);
        if (host === boundary) break;
        host = host.parentElement || host.getRootNode?.()?.host;
      }
    };
    for (const reader of flowReaders()) addChain(reader);
    if (!targets.length) addChain(flow?.root);
    add(boundary);
    return targets.sort((left, right) => left.contains(right) ? 1 : right.contains(left) ? -1 : documentOrder(left, right));
  }

  function hasUnreadReaderBefore(media) {
    return flowReaders().some(reader => beforeMediaText(reader, media) >= 80 &&
      (() => { const target = localReadingTarget(reader); return target && !target.contains(media) && target.scrollTop < target.scrollHeight - target.clientHeight - 2; })());
  }

  function nextFlowTarget(media = nextFlowMedia()) {
    const targets = flowTargets().filter(item => item.scrollTop < item.scrollHeight - item.clientHeight - 2);
    if (!targets.length) return null;
    const reached = target => {
      if (target === flow?.scrollRoot || target === document.scrollingElement) return true;
      const port = viewportBounds(target);
      const rect = target.getBoundingClientRect();
      return port.height > 0 && rect.top < port.top + port.height && rect.top + rect.height > port.top;
    };
    // An independent reader earlier in the lesson must finish before moving its surrounding page.
    if (media) {
      for (const reader of flowReaders()) {
        const target = localReadingTarget(reader);
        if (target && targets.includes(target) && reached(target) && !target.contains(media) && beforeMediaText(reader, media) >= 80) return target;
      }
    }
    return targets.find(reached) || targets[0];
  }

  function resetFlowPosition() {
    for (const target of flowTargets()) {
      if (target.scrollTop <= 0) continue;
      try { target.scrollTo({ top: 0, behavior: "instant" }); } catch { target.scrollTop = 0; }
    }
    for (const media of pageMedia()) {
      if (media.tagName !== "VIDEO") continue;
      try { media.pause(); media.currentTime = 0; } catch { /* Not seekable until loaded. */ }
    }
  }

  function flowSnapshot() {
    if (!flow) return null;
    return { playedMediaIds: [...flow.played], videosCompleted: flow.videosCompleted,
      atEnd: !nextFlowTarget() && !nextFlowMedia(), taskCompleteConfirmed: platformComplete(),
      embeddedActive: Boolean(flow.embedded), embeddedMediaId: flow.embedded?.id || null, role: embeddedBinding ? "embedded" : "owner" };
  }

  function flowDetail() {
    if (!settings.scrollEnabled) return "自动滚动已关闭，保留当前进度";
    if (nextFlowMedia()) return flow.videosCompleted ? "视频已结束，继续按页面顺序阅读后文并检测下一段视频" : "正在按页面顺序阅读，每次滚动完成后检测视频";
    if (!nextFlowTarget()) return "本项内容已读到底，等待平台确认当前任务完成";
    return "继续按设定间隔向下阅读本项后续内容";
  }

  function finishEmbedded() {
    if (!embeddedBinding || !running || completed) return;
    completed = true; running = false; clearTimers();
    phase = "waiting"; detail = "内嵌内容已处理，继续外层页面后文";
    embeddedCheckpoint = snapshot();
    send("ENGINE_EMBEDDED_DONE", { token: embeddedBinding.token, runId: activeRunId, snapshot: embeddedCheckpoint });
    if (flowGuardCleanup) { flowGuardCleanup(); flowGuardCleanup = null; }
  }

  function startEmbedded(frame) {
    if (!flow || flow.embedded) return;
    clearTimeout(scrollTimer); scrollTimer = null; nextScrollAt = 0;
    clearTimeout(scrollVerifyTimer); scrollVerifyTimer = null;
    for (const target of activeScrollTargets) {
      try { target.scrollTo({ top: target.scrollTop, behavior: "instant" }); } catch { /* Detached reader. */ }
    }
    activeScrollTargets.clear();
    const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${mediaGateGeneration}`;
    flow.embedded = { element: frame, token, id: mediaId(frame), deadline: performance.now() + 12000 };
    const embedded = flow.embedded;
    const rebind = () => {
      if (!running || paused || flow?.embedded !== embedded) return;
      // Navigating a document iframe replaces its content script. Reconnect
      // that segment without restarting the surrounding textbook.
      embedded.cleanup();
      flow.resumeEmbeddedId = embedded.id;
      flow.embedded = null;
      startEmbedded(frame);
    };
    embedded.cleanup = () => frame.removeEventListener("load", rebind);
    frame.addEventListener("load", rebind);
    phase = "waiting"; scrollState = "video"; detail = "正在连接位于阅读区域中间的内嵌课程内容";
    send("ENGINE_EMBEDDED_REQUEST", { key: current.key, runId: activeRunId, token,
      frameOrigin: frameDiagnostic(frame).origin, resetPosition: flow.resumeEmbeddedId !== flow.embedded.id });
    try { frame.contentWindow.postMessage({ protocol: VIEWPORT_PROTOCOL, kind: "flow-bind", token }, "*"); }
    catch { phase = "blocked"; detail = "无法连接内嵌内容，请检查访问权限后继续，当前阅读位置已保留"; }
    report(true);
  }

  function evaluateFlow() {
    if (!running || paused || completed || !flow || activeMedia || flow.embedded) return;
    if (embeddedBinding && current.type === "document" && (!current.element.isConnected || !flow.root.isConnected)) {
      // Rendering can replace the viewer before the mutation debounce runs.
      // Rebind now so the missing old surface cannot look like end-of-document.
      checkIdentity();
      if (!current?.element.isConnected || !flow?.root?.isConnected) {
        phase = "waiting"; scrollState = "loading_document";
        detail = "等待内嵌文档更新，保留当前阅读进度";
        report();
      }
      return;
    }
    guardFlowMedia();
    if (digitalTextbookHost(flow.root) === flow.root) {
      // Recheck synchronously at a reading step: a retained chapter node can be
      // emptied before the debounced identity observer has seen its mutation.
      const found = detect().candidate;
      if (!found || found.key !== current.key || found.flowElement !== flow.root) {
        scheduleIdentityCheck(); return;
      }
      current = found;
    }
    if (!ensureReadingViewport()) return;
    const loadingSelector = "[aria-busy='true'],.loading,.el-loading-mask,.ant-spin-spinning";
    if (embeddedBinding && current.type === "document" && !flow.frameTransport &&
        (current.documentLoading || !nextFlowTarget() && (flow.root.matches?.(loadingSelector) && visible(flow.root) || queryAll(loadingSelector, flow.root).some(item => visible(item))) ||
        text(current.element).length < 40 && !queryAll("canvas,img,svg,iframe", flow.root).some(item => visible(item, 30)))) {
      clearTimeout(scrollTimer); scrollTimer = null; nextScrollAt = 0;
      flow.documentLoading = true;
      phase = "waiting"; scrollState = "loading_document";
      detail = "内嵌文档正在加载，保留教材位置，加载后继续阅读";
      report(); return;
    }
    if (flow.documentLoading) {
      flow.documentLoading = false;
      scheduleScroll();
    }
    if (current.chapterLoading || !current.element.isConnected && digitalTextbookHost(flow.root) === flow.root) {
      clearTimeout(scrollTimer); scrollTimer = null; nextScrollAt = 0;
      phase = "waiting"; scrollState = "loading_chapter";
      detail = "等待下一章节内容加载，保留当前阅读位置和已播放记录";
      report(); return;
    }
    const media = nextFlowMedia();
    if (flow.frameTransport && media?.tagName === "IFRAME") {
      const rect = plainRect(media.getBoundingClientRect());
      const port = viewportBounds(media);
      const overlapWidth = Math.min(rect.left + rect.width, port.left + port.width) - Math.max(rect.left, port.left);
      const overlapHeight = Math.min(rect.top + rect.height, port.top + port.height) - Math.max(rect.top, port.top);
      if (overlapWidth >= Math.min(rect.width, port.width) * 0.5 &&
          overlapHeight >= Math.min(120, rect.height, port.height) && port.width > 0 && port.height > 0) {
        startEmbedded(media);
      } else {
        phase = "blocked"; scrollState = "no_target";
        detail = "内嵌教材尚未出现在可见阅读区域，请手动显示课程区域后继续";
        report(true);
      }
      return;
    }
    const disclosure = media && textbookDisclosure(media);
    if (flow.expandingMedia) {
      if (!flow.expandingMedia.isConnected) { flow.expandingMedia = null; }
      else if (textbookDisclosure(flow.expandingMedia)) {
        phase = performance.now() > flow.expansionDeadline ? "blocked" : "reading";
        scrollState = "expanding";
        detail = phase === "blocked" ? "教材视频未能展开，请手动点击该视频标题后继续" : "正在展开当前教材视频，展开后继续逐步滚动";
        report(true); return;
      } else {
        flow.expandingMedia = null;
        if (!scrollTimer) scheduleScroll();
      }
    }
    if (disclosure && !hasUnreadReaderBefore(media)) {
      const rect = plainRect(disclosure.anchor.getBoundingClientRect());
      if (centeredRect(rect, disclosure.anchor) && unclippedRect(disclosure.anchor, rect)) {
        if (disclosure.input.checked || !flow.disclosures.has(disclosure.input)) {
          const alreadyRequested = disclosure.input.checked;
          flow.disclosures.add(disclosure.input);
          flow.expandingMedia = media; flow.expansionDeadline = performance.now() + 3000;
          flow.expansionNeedsStep = true;
          clearTimeout(scrollTimer); scrollTimer = null; nextScrollAt = 0;
          scrollState = "expanding";
          if (!alreadyRequested) disclosure.input.click();
          phase = "reading"; detail = alreadyRequested ? "正在等待当前教材视频展开，保留阅读位置" : "已展开当前教材视频，继续小步滚动至阅读区域中间";
          report(true); return;
        }
      }
    }
    if (media && !disclosure && !flow.expansionNeedsStep && !hasUnreadReaderBefore(media)) {
      const rect = plainRect(media.getBoundingClientRect());
      if (centeredRect(rect, media) && unclippedRect(media, rect)) {
        clearTimeout(scrollTimer); scrollTimer = null; nextScrollAt = 0;
        if (media.tagName === "IFRAME") startEmbedded(media);
        else { activeMedia = media; phase = "centering"; scrollState = "video"; watchMedia(media); }
        report(true);
        return;
      }
    }
    const target = nextFlowTarget();
    if (media && !target) {
      phase = "blocked"; scrollState = "no_target";
      detail = "课程区域已无可继续向下滚动的空间，尚未处理的视频无法位于阅读区域中间；请手动调整页面或播放器位置后重新识别";
      report(true); return;
    }
    if (!media && !target) {
      const host = digitalTextbookHost(flow.scrollRoot), visiblePort = flow.visibleReadingPort;
      const nativePort = host && viewportBounds(host, true);
      if (host && host.scrollHeight > host.clientHeight + 2 && validRect(visiblePort) &&
          visiblePort.top + visiblePort.height < nativePort.top + nativePort.height - 2) {
        flow.readingPortReady = false; flow.readingPortRetryAt = performance.now() + 3000;
        clearTimeout(scrollTimer); scrollTimer = null; nextScrollAt = 0;
        phase = "blocked"; scrollState = "no_target";
        detail = "教材已滚到底，但末尾仍被外层窗口遮挡；请手动显示完整教材区域后继续";
        report(true); return;
      }
      scrollState = "bottom";
      if (embeddedBinding) { finishEmbedded(); return; }
      if (platformComplete()) { finish(); return; }
      phase = "waiting_completion"; detail = flowDetail(); report(true); return;
    }
    phase = "reading"; detail = flowDetail();
  }

  function videoFinished(media) {
    if (!flow || !running || paused || activeMedia !== media || !media.isConnected || completed) return;
    flow.played.add(mediaId(media)); flow.videosCompleted += 1;
    if (cleanupMedia) { cleanupMedia({ pauseVideo: false, restoreMute: true }); cleanupMedia = null; }
    activeMedia = null; seenPlaying = false; scrollState = "scheduled";
    phase = "reading"; detail = "视频已结束，继续阅读同一页面下方的内容";
    report(true);
    // Do not infer task completion from a single ended event; resume the same page traversal.
    scheduleScroll();
  }

  function guardFlowMedia() {
    if (!flow?.guards) return;
    for (const [media, listener] of flow.guards) {
      if (media.isConnected) continue;
      media.removeEventListener("playing", listener); flow.guards.delete(media);
    }
    for (const media of pageMedia()) {
      if (media.tagName !== "VIDEO" || flow.guards.has(media)) continue;
      const holdPlayback = () => {
        if (running && !paused && activeMedia !== media && !media.paused) { try { media.pause(); } catch { /* Replaced player. */ } }
      };
      flow.guards.set(media, holdPlayback);
      media.addEventListener("playing", holdPlayback);
      holdPlayback();
    }
  }

  function snapshot() {
    const media = activeMedia;
    const delegated = flow?.embedded?.snapshot;
    const videoCurrent = media && Number.isFinite(media.currentTime) ? media.currentTime : delegated?.videoCurrent || 0;
    const videoDuration = media && Number.isFinite(media.duration) ? media.duration : delegated?.videoDuration || 0;
    const sampledAt = Date.now();
    const scrollRemaining = nextScrollAt ? Math.max(0, nextScrollAt - performance.now()) : null;
    let scroll = { enabled: settings.scrollEnabled && !media && !flow?.embedded, state: scrollState, movements: scrollMovements,
      nextInSeconds: scrollRemaining === null ? null : scrollRemaining / 1000,
      nextAt: scrollRemaining === null ? null : sampledAt + scrollRemaining, sampledAt,
      intervalSeconds: currentScrollInterval || settings.scrollIntervalSeconds };
    if (delegated?.scroll) {
      const child = delegated.scroll;
      const deadline = child.nextAt != null && Number.isFinite(Number(child.nextAt)) ? Number(child.nextAt) :
        child.nextInSeconds != null && Number.isFinite(Number(child.nextInSeconds)) && Number.isFinite(Number(child.sampledAt))
          ? Number(child.sampledAt) + Number(child.nextInSeconds) * 1000 : null;
      const remaining = deadline === null ? null : Math.max(0, deadline - sampledAt) / 1000;
      // The child owns the current reading step. Keep its absolute deadline rather
      // than replacing it with the owner's intentionally stopped iframe timer.
      scroll = { enabled: settings.scrollEnabled && running && !paused && child.enabled !== false,
        state: child.state || "waiting", movements: Math.max(0, Number(child.movements) || 0),
        nextInSeconds: remaining, nextAt: running && !paused ? deadline : null, sampledAt,
        intervalSeconds: Number(child.intervalSeconds) || settings.scrollIntervalSeconds };
    }
    return {
      phase, taskType: delegated?.taskType || (media ? "video" : current ? current.type === "document" ? "document" : "text" : "unknown"), title: current?.title || "", key: current?.key || "", runId: activeRunId,
      detail, elapsedSeconds: media ? videoCurrent : elapsed,
      remainingSeconds: media || delegated?.taskType === "video" ? Math.max(0, videoDuration - videoCurrent) : 0,
      videoCurrent, videoDuration, flow: flowSnapshot(), taskCompleteConfirmed: platformComplete(),
      scroll
    };
  }

  function report(force = false) {
    const now = performance.now();
    if (!force && now - lastReportAt < 900) return;
    lastReportAt = now;
    const state = snapshot();
    if (embeddedBinding) send("ENGINE_EMBEDDED_PROGRESS", { token: embeddedBinding.token, runId: activeRunId, snapshot: state });
    else send("ENGINE_PROGRESS", { snapshot: state });
  }

  function clearTimers() {
    clearInterval(timerId); timerId = null;
    clearTimeout(scrollTimer); scrollTimer = null;
    clearTimeout(scrollVerifyTimer); scrollVerifyTimer = null;
    nextScrollAt = 0;
    clearTimeout(mediaGateTimer); mediaGateTimer = null;
    mediaGateGeneration += 1;
    cancelViewportRequests();
    for (const target of activeScrollTargets) {
      try { target.scrollTo({ top: target.scrollTop, behavior: "instant" }); } catch { /* Reader detached. */ }
    }
    activeScrollTargets.clear();
  }

  function stop({ pauseVideo = true, restoreMute = true, clearCurrent = true } = {}) {
    clearTimers();
    flow?.embedded?.cleanup?.();
    running = false;
    paused = false;
    alignmentAllowed = false;
    if (cleanupMedia) { cleanupMedia({ pauseVideo, restoreMute }); cleanupMedia = null; }
    if (flowGuardCleanup) { flowGuardCleanup(); flowGuardCleanup = null; }
    activeMedia = null;
    if (clearCurrent) current = null;
  }

  function finish() {
    if (!running || paused || completed || !current || activeMedia || nextFlowMedia() || nextFlowTarget() || !platformComplete()) return;
    completed = true;
    running = false;
    clearTimers();
    phase = "waiting";
    detail = "本项全部内容已读完，平台已确认任务完成";
    report(true);
    send("ENGINE_DONE", { key: current.key, title: current.title, taskType: current.type, runId: activeRunId, completionReason: "platform" });
    if (cleanupMedia) { cleanupMedia({ pauseVideo: false, restoreMute: true }); cleanupMedia = null; }
    if (flowGuardCleanup) { flowGuardCleanup(); flowGuardCleanup = null; }
  }

  function embeddedDocumentProxy(within) {
    // Virtualized Office viewers can paint pages beside a separate, narrow
    // native scroll rail. Only pair siblings inside the nearest bounded viewer.
    const pages = queryAll("canvas,img,svg,p,pre,blockquote,[role='document']", within).filter(page =>
      !page.closest(CATALOG_SELECTOR) && !page.querySelector(CATALOG_SELECTOR) && visible(page, 30) &&
      page.getBoundingClientRect().width >= 240 && page.getBoundingClientRect().height >= 160 &&
      (page.matches("canvas,img,svg") || text(page).length >= 160));
    for (const page of pages) {
      let scope = page.parentElement;
      for (let depth = 0; scope && depth < 2; depth++, scope = scope.parentElement) {
        if (within && scope !== within && !within.contains(scope)) break;
        if (scope === document.scrollingElement || /^(?:HTML|BODY)$/.test(scope.tagName) ||
            scope.closest(CATALOG_SELECTOR) || scope.querySelector(CATALOG_SELECTOR)) break;
        const rendered = plainRect(page.getBoundingClientRect());
        const scroller = queryAll("*", scope).slice(0, 600).find(item => {
          if (item === page || item.contains(page) || page.contains(item) || item.closest(CATALOG_SELECTOR) ||
              !visible(item) || item.clientWidth < 4 || item.clientHeight < 160 ||
              item.scrollHeight <= item.clientHeight + 2 || !/^(?:auto|scroll|overlay)$/.test(getComputedStyle(item).overflowY)) return false;
          const rect = plainRect(item.getBoundingClientRect());
          const overlap = intersectRects(rect, rendered);
          const gap = Math.max(rect.left - (rendered.left + rendered.width), rendered.left - (rect.left + rect.width), 0);
          return overlap.height >= Math.min(rect.height, rendered.height) * 0.8 &&
            (overlap.width >= Math.min(rect.width, rendered.width) * 0.5 || gap <= 40);
        });
        if (scroller) {
          documentScrollProxies.add(scroller);
          documentScrollHosts.set(scope, scroller);
          return scope;
        }
      }
    }
    return null;
  }

  function canScroll(element) {
    const proxy = documentScrollProxies.has(element);
    if (!visible(element, proxy ? 1 : 30) || element.scrollHeight <= element.clientHeight + 2 || element.closest?.(CATALOG_SELECTOR)) return false;
    if (digitalTextbookLeaf(element) || viewportScrollAlias(element)) return false;
    const root = element.ownerDocument?.scrollingElement || document.scrollingElement;
    if (element !== root && getComputedStyle(element).overflowY === "hidden" && !knownScrollHost(element) && !significantHiddenRange(element)) return false;
    // overflow:hidden can be moved programmatically; overflow:clip cannot.
    return element === root || /^(?:auto|scroll|overlay|hidden)$/.test(getComputedStyle(element).overflowY);
  }

  function largestReader(elements) {
    return elements.filter(canScroll).sort((left, right) =>
      right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight)[0] || null;
  }

  function embeddedScrollTarget(element, visited = new Set(), depth = 0) {
    if (depth > 4) return null;
    const frames = element.tagName === "IFRAME" ? [element] : queryAll("iframe", element).slice(0, 12);
    for (const frame of frames) {
      if (!visible(frame, 30)) continue;
      try {
        const embedded = frame.contentDocument;
        if (!embedded?.documentElement || visited.has(embedded)) continue;
        visited.add(embedded);
        const known = [...embedded.querySelectorAll("#viewerContainer,.document-viewer,.reader-content,.pdf-viewer,[role='document'],article")];
        const target = known.find(canScroll) || largestReader([...embedded.querySelectorAll("*")].slice(0, 1400));
        if (target) return target;
        const nested = embeddedScrollTarget(embedded.documentElement, visited, depth + 1);
        if (nested) return nested;
        if (canScroll(embedded.scrollingElement)) return embedded.scrollingElement;
      } catch { /* Cross-origin and browser PDF frames require their own accessible content script. */ }
    }
    return null;
  }

  function scrollTarget(element = current?.element) {
    if (!element) return null;
    const textbook = digitalTextbookHost(element);
    if (textbook && canScroll(textbook)) return textbook;
    if (canScroll(element)) return element;
    const embedded = embeddedScrollTarget(element);
    if (embedded) return embedded;
    const inside = largestReader(queryAll("*", element).slice(0, 1400));
    if (inside) return inside;
    // Moving an iframe's outer page does not move the document displayed inside it.
    if (/^(?:IFRAME|EMBED|OBJECT)$/.test(element.tagName)) return null;
    const seen = new Set([element]);
    let parent = element.parentElement || element.getRootNode?.()?.host;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (canScroll(parent)) return parent;
      parent = parent.parentElement || parent.getRootNode?.()?.host;
    }
    return canScroll(document.scrollingElement) ? document.scrollingElement : null;
  }

  function readingScrollTarget(found = current) {
    if (flow && found === current) return nextFlowTarget();
    const primary = scrollTarget(found?.element);
    if (!found?.readingBeforeVideo || !found.nextMedia || !primary || primary.scrollTop < primary.scrollHeight - primary.clientHeight - 2) return primary;
    // Finish an independently scrollable text reader before moving its surrounding page toward a following player.
    let parent = found.element.parentElement || found.element.getRootNode?.()?.host;
    const seen = new Set();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (parent !== primary && parent.contains(found.nextMedia) && canScroll(parent) && parent.scrollTop < parent.scrollHeight - parent.clientHeight - 2) return parent;
      parent = parent.parentElement || parent.getRootNode?.()?.host;
    }
    const root = document.scrollingElement;
    return root && root !== primary && canScroll(root) && root.scrollTop < root.scrollHeight - root.clientHeight - 2 ? root : primary;
  }

  function scrollDiagnostic(found = current) {
    if (!found || found.type === "video") return { state: "not_applicable", movements: scrollMovements };
    const target = scrollTarget(found.element);
    return {
      state: !settings.scrollEnabled ? "disabled" : target ? "available" : "no_scroll_target",
      movements: scrollMovements,
      target: target ? { tag: target.tagName, viewportHeight: target.clientHeight, contentHeight: target.scrollHeight, position: Math.round(target.scrollTop) } : null
    };
  }

  function scrollNodeDiagnostic(element) {
    const identifier = value => String(value || "").split(/\s+/).slice(0, 8).map(part =>
      /(?:https?:|@|[?=&])|(?:token|password|secret|authorization)|[a-z0-9_-]{48,}/i.test(part)
        ? "[redacted]" : part.replace(/[^\w:.-]/g, "_").slice(0, 80)).join(" ").slice(0, 240);
    const style = getComputedStyle(element);
    return { tag: element.tagName, id: identifier(element.getAttribute?.("id") || element.id),
      class: identifier(element.className?.baseVal || element.className),
      overflow: { x: style.overflowX || "visible", y: style.overflowY || "visible" },
      clientHeight: Number(element.clientHeight) || 0, scrollHeight: Number(element.scrollHeight) || 0,
      position: Math.round(Number(element.scrollTop) || 0) };
  }

  function candidateScrollChains(found) {
    if (!found?.element) return [];
    const scope = found.flowElement || found.element;
    const readers = readingRegions(false, true).map(item => item.el).filter(item => item === scope || scope.contains(item));
    const anchors = [...new Set([...(readers.length ? readers : [found.element]), ...queryAll("video,iframe", scope)])].slice(0, 8);
    return anchors.map(anchor => {
      const chain = [];
      const seen = new Set();
      let node = anchor;
      while (node && !seen.has(node) && chain.length < 18) {
        seen.add(node); chain.push(scrollNodeDiagnostic(node));
        if (node === document.scrollingElement) break;
        node = node.parentElement || node.getRootNode?.()?.host;
      }
      return { chain };
    });
  }

  function readingScrollDetail(target = readingScrollTarget()) {
    if (flow) return flowDetail();
    if (!settings.scrollEnabled) return "自动滚动已关闭，等待手动切换";
    if (current?.readingBeforeVideo && target && target.scrollTop < target.scrollHeight - target.clientHeight - 2) return "正在逐步阅读前置文字，每次滚动完成后检测视频位置";
    if (target && target.scrollTop >= target.scrollHeight - target.clientHeight - 2) return "已滚到底部，等待手动切换";
    if (target) return scrollMovements ? `已向下滚动 ${scrollMovements} 次，等待下一次滚动` : "按设定间隔向下滚动，每次等待时间小幅随机浮动";
    if (/^(?:IFRAME|EMBED|OBJECT)$/.test(current?.element?.tagName || "")) return "内嵌文档未找到可控制的滚动区域；请检查阅读器权限或复制识别诊断";
    return "当前内容无需滚动或尚未找到可滚动区域，等待手动切换";
  }

  function scheduleScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = null;
    nextScrollAt = 0;
    if (!running || paused || activeMedia || flow?.embedded || flow?.expandingMedia || flow?.documentLoading || current?.chapterLoading || flow?.readingPortReady === false || !settings.scrollEnabled) return;
    const delay = settings.scrollIntervalSeconds * 1000 * (0.9 + Math.random() * 0.2);
    currentScrollInterval = delay / 1000;
    nextScrollAt = performance.now() + delay;
    if (!["bottom", "no_target", "unresponsive"].includes(scrollState)) scrollState = "scheduled";
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      nextScrollAt = 0;
      if (!running || paused || activeMedia || flow?.embedded || !settings.scrollEnabled) return;
      if (ensureReadingViewport(true, performReadingStep)) performReadingStep();
    }, delay);
  }

  function performReadingStep() {
    if (!running || paused || activeMedia || flow?.embedded || !settings.scrollEnabled) return;
    evaluateFlow();
    if (!running || activeMedia || flow?.embedded || flow?.expandingMedia || flow?.documentLoading || current?.chapterLoading ||
        !current?.element.isConnected || flow?.readingPortReady === false) return;
    const target = readingScrollTarget();
    scrollState = target ? "scheduled" : flow && !nextFlowMedia() ? "bottom" : "no_target";
    detail = readingScrollDetail(target);
    if (target) {
      const max = Math.max(0, target.scrollHeight - target.clientHeight);
      const before = target.scrollTop;
      if (before >= max - 2) {
        scrollState = "bottom";
        scheduleScroll();
        report(true);
        return;
      }
      const distance = Math.max(48, Math.min(240, target.clientHeight * (0.16 + Math.random() * 0.12)));
      let next = Math.min(max, before + distance);
      const nextMedia = flow ? nextFlowMedia() : current.nextMedia;
      if (nextMedia && target.contains?.(nextMedia)) {
        const anchor = flowMediaAnchor(nextMedia);
        const mediaRect = anchor.getBoundingClientRect();
        const port = courseViewport(anchor);
        const remainingToCenter = mediaRect.top + mediaRect.height / 2 - (port.top + port.height / 2);
        const targetRect = target.getBoundingClientRect();
        const scaleY = targetRect.height / (Number(target.offsetHeight) || targetRect.height || 1);
        // DOM rectangles use visual pixels; scrollTop uses the host's layout units.
        if (remainingToCenter > 0) next = Math.min(next, before + remainingToCenter / scaleY);
      }
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const taskKey = current.key;
      readingScrollVerified = false;
      scrollState = "moving";
      activeScrollTargets.add(target);
      try { target.scrollTo({ top: next, behavior: reduced || document.hidden ? "instant" : "smooth" }); }
      catch { target.scrollTop = next; }
      clearTimeout(scrollVerifyTimer);
      scrollVerifyTimer = setTimeout(() => {
        scrollVerifyTimer = null;
        if (!running || paused || current?.key !== taskKey) return;
        // Some embedded viewers ignore smooth scrolling; try their actual scroll position once.
        if (Math.abs(target.scrollTop - before) < 1) target.scrollTop = next;
        if (target.scrollTop - before >= 1) {
          scrollMovements += 1;
          readingScrollVerified = true;
          if (flow) flow.expansionNeedsStep = false;
          scrollState = target.scrollTop >= target.scrollHeight - target.clientHeight - 2 ? "bottom" : "scheduled";
          detail = readingScrollDetail(target);
        } else {
          scrollState = "unresponsive";
          detail = "该阅读器未响应滚动；请复制识别诊断以适配当前文档";
        }
        report(true);
        // Media may take over only after the actual downward movement has been verified.
        evaluateFlow();
      }, 350);
    }
    report(true);
    scheduleScroll();
  }

  function tick() {
    if (!running || paused || !current) return;
    guardFlowMedia();
    const now = performance.now();
    if (activeMedia) {
      if (!activeMedia.isConnected) { checkIdentity(); return; }
      report();
      return;
    }
    elapsed += Math.max(0, (now - lastTick) / 1000);
    lastTick = now;
    if (flow?.embedded && flow.embedded.deadline < now) {
      phase = "blocked"; detail = "内嵌内容连接超时，请连接内嵌内容后点击继续，当前阅读位置已保留"; report(true); return;
    }
    if (!scrollVerifyTimer) evaluateFlow();
    report();
  }

  function viewportSize() {
    return { width: Number(globalThis.innerWidth) || document.documentElement.clientWidth,
      height: Number(globalThis.innerHeight) || document.documentElement.clientHeight };
  }

  function plainRect(rect) {
    return { left: Number(rect.left) || 0, top: Number(rect.top) || 0, width: Number(rect.width) || 0, height: Number(rect.height) || 0 };
  }

  function validRect(rect) {
    return rect && [rect.left, rect.top, rect.width, rect.height].every(value => Number.isFinite(value) && Math.abs(value) < 1000000) && rect.width > 0 && rect.height > 0;
  }

  function intersectRects(...rects) {
    const left = Math.max(...rects.map(rect => rect.left)), top = Math.max(...rects.map(rect => rect.top));
    return { left, top, width: Math.max(0, Math.min(...rects.map(rect => rect.left + rect.width)) - left),
      height: Math.max(0, Math.min(...rects.map(rect => rect.top + rect.height)) - top) };
  }

  function centeredInPort(rect, port, visiblePort = port) {
    if (!validRect(port) || !validRect(visiblePort)) return false;
    const overlap = intersectRects(rect, visiblePort);
    const tolerance = Math.min(Math.max(24, Math.min(80, port.height * 0.1)),
      rect.height <= port.height ? Math.max(2, (port.height - rect.height) / 2) : Infinity);
    return Math.abs(rect.top + rect.height / 2 - (port.top + port.height / 2)) <= tolerance &&
      overlap.width >= Math.min(rect.width, port.width) * 0.5 && overlap.height >= Math.min(rect.height, port.height) * 0.6;
  }

  function viewportScrollAlias(element) {
    const doc = element?.ownerDocument || document;
    const root = doc.scrollingElement;
    if (!root || element === root || element?.tagName !== "BODY" || root.tagName !== "HTML" || element.parentElement !== root) return false;
    const overflow = getComputedStyle(root).overflowY;
    // With a visible HTML overflow, a viewport-sized BODY's overflow is propagated
    // to the viewport. Its computed auto/hidden style does not create another port.
    return (!overflow || overflow === "visible") && element.clientHeight >= root.clientHeight - 2 &&
      Math.abs(element.scrollHeight - root.scrollHeight) <= 2;
  }

  function viewportBounds(element, includeSelf = false) {
    const size = viewportSize();
    let left = 0, top = 0, right = size.width, bottom = size.height;
    let ancestor = includeSelf ? element : element?.parentElement || element?.getRootNode?.()?.host;
    const seen = new Set();
    while (ancestor && ancestor !== document.scrollingElement && !seen.has(ancestor)) {
      seen.add(ancestor);
      const style = getComputedStyle(ancestor);
      const rect = ancestor.getBoundingClientRect();
      const scaleX = rect.width / (Number(ancestor.offsetWidth) || rect.width || 1);
      const scaleY = rect.height / (Number(ancestor.offsetHeight) || rect.height || 1);
      const x = rect.left + (Number(ancestor.clientLeft) || 0) * scaleX;
      const y = rect.top + (Number(ancestor.clientTop) || 0) * scaleY;
      if (!viewportScrollAlias(ancestor) && /^(?:auto|scroll|hidden|clip|overlay)$/.test(style.overflowY || "")) {
        top = Math.max(top, y); bottom = Math.min(bottom, y + ancestor.clientHeight * scaleY);
      }
      if (!viewportScrollAlias(ancestor) && /^(?:auto|scroll|hidden|clip|overlay)$/.test(style.overflowX || "")) {
        left = Math.max(left, x); right = Math.min(right, x + ancestor.clientWidth * scaleX);
      }
      ancestor = ancestor.parentElement || ancestor.getRootNode?.()?.host;
    }
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  function courseViewport(element) {
    let ancestor = element?.parentElement || element?.getRootNode?.()?.host;
    const seen = new Set();
    while (ancestor && ancestor !== document.scrollingElement && !seen.has(ancestor)) {
      seen.add(ancestor);
      // A fitted player crop is not the course reading viewport.
      if (ancestor === flow?.scrollRoot || isScrollPort(ancestor)) {
        const port = viewportBounds(ancestor, true);
        return ancestor === flow?.scrollRoot && flow.visibleReadingPort ? intersectRects(port, flow.visibleReadingPort) : port;
      }
      ancestor = ancestor.parentElement || ancestor.getRootNode?.()?.host;
    }
    return viewportBounds();
  }

  function centeredRect(rect, element) {
    const viewport = courseViewport(element);
    const visiblePort = viewportBounds(element);
    return centeredInPort(rect, viewport, visiblePort);
  }

  function ensureReadingViewport(force = false, afterConfirmation = null) {
    const host = digitalTextbookHost(flow?.scrollRoot);
    if (!host) return true;
    if (globalThis.parent === globalThis || globalThis.top === globalThis) {
      flow.readingPortReady = true;
      return true;
    }
    const port = viewportBounds(host, true);
    const geometry = JSON.stringify(port);
    if (!force && flow.readingPortGeometry === geometry && flow.readingPortReady) return true;
    if (afterConfirmation) flow.afterReadingPort = afterConfirmation;
    if (flow.readingPortPending || performance.now() < (flow.readingPortRetryAt || 0)) return false;
    const owner = flow, generation = mediaGateGeneration;
    owner.readingPortPending = true; owner.readingPortReady = false;
    clearTimeout(scrollTimer); scrollTimer = null; nextScrollAt = 0;
    phase = "reading"; scrollState = "checking_viewport"; detail = "正在确认内层教材的实际可见阅读区域";
    topViewportConfirmed(port, 0, host, port).then(result => {
      if (flow !== owner || generation !== mediaGateGeneration || !running || paused) return;
      owner.readingPortPending = false;
      owner.visibleReadingPort = result.readingPort;
      owner.readingPortGeometry = geometry;
      owner.readingPortReady = validRect(result.readingPort);
      if (!owner.readingPortReady) {
        owner.afterReadingPort = null;
        owner.readingPortRetryAt = performance.now() + 3000;
        phase = "blocked"; scrollState = "no_target";
        detail = "内层教材未处于可见区域，请手动显示课程区域后继续；插件保留外层页面位置";
      } else {
        scrollState = "scheduled";
        const resumeStep = owner.afterReadingPort;
        owner.afterReadingPort = null;
        if (resumeStep) resumeStep();
        else { evaluateFlow(); scheduleScroll(); }
      }
      report(true);
    });
    return false;
  }

  function unclippedRect(element, rect) {
    const centerY = rect.top + rect.height / 2;
    const centerX = Math.max(0, Math.min(viewportSize().width, rect.left + rect.width / 2));
    let parent = element.parentElement || element.getRootNode?.()?.host;
    const seen = new Set();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const style = getComputedStyle(parent);
      if (!viewportScrollAlias(parent) && /(?:auto|scroll|hidden|clip|overlay)/.test(style.overflowY || "")) {
        const boundary = parent.getBoundingClientRect();
        if (centerY < boundary.top || centerY > boundary.top + boundary.height ||
            centerX < boundary.left || centerX > boundary.left + boundary.width) return false;
      }
      parent = parent.parentElement || parent.getRootNode?.()?.host;
    }
    return true;
  }

  function centerInLocalViewport(element, getRect = () => plainRect(element.getBoundingClientRect())) {
    const targets = [];
    const seen = new Set();
    let parent = element.parentElement || element.getRootNode?.()?.host;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (canScroll(parent)) targets.push(parent);
      if (isScrollPort(parent) && (!flow?.scrollRoot || parent === flow.scrollRoot)) break;
      parent = parent.parentElement || parent.getRootNode?.()?.host;
    }
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const target of targets) {
      const rect = getRect();
      const port = courseViewport(element);
      const delta = rect.top + rect.height / 2 - (port.top + port.height / 2);
      if (Math.abs(delta) < 2) continue;
      const next = Math.max(0, Math.min(target.scrollHeight - target.clientHeight, target.scrollTop + delta));
      activeScrollTargets.add(target);
      try { target.scrollTo({ top: next, behavior: reduced || document.hidden ? "instant" : "smooth" }); }
      catch { target.scrollTop = next; }
    }
  }

  function cancelViewportRequests() {
    for (const pending of viewportRequests.values()) { clearTimeout(pending.timer); pending.resolve({ centered: false, readingPort: null }); }
    viewportRequests.clear();
    for (const timer of ancestorTimers) clearTimeout(timer);
    ancestorTimers.clear();
  }

  function topViewportConfirmed(rect, depth = 0, element = activeMedia, readingPort = null) {
    if (globalThis.parent === globalThis || globalThis.top === globalThis) return Promise.resolve({
      centered: readingPort ? centeredInPort(rect, readingPort) : centeredRect(rect, element), readingPort });
    if (!globalThis.parent?.postMessage || depth >= 12) return Promise.resolve({ centered: false, readingPort: null });
    return new Promise(resolve => {
      const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${mediaGateGeneration}`;
      const timer = setTimeout(() => { viewportRequests.delete(requestId); resolve({ centered: false, readingPort: null }); }, 3500);
      viewportRequests.set(requestId, { resolve, timer });
      try { globalThis.parent.postMessage({ protocol: VIEWPORT_PROTOCOL, kind: "request", requestId,
        rect, viewport: viewportSize(), depth, ...(readingPort ? { readingPort } : {}) }, "*"); }
      catch { clearTimeout(timer); viewportRequests.delete(requestId); resolve({ centered: false, readingPort: null }); }
    });
  }

  // Project a textbook's reading viewport through its real frames. These frames
  // carry the reader; they must never scroll to center it in the outer webpage.
  addEventListener("message", event => {
    const message = event.data;
    if (message?.protocol === VIEWPORT_PROTOCOL && message.kind === "flow-bind" && event.source === globalThis.parent && globalThis.parent !== globalThis &&
        typeof message.token === "string" && message.token.length >= 8 && message.token.length <= 160) {
      pendingEmbeddedToken = message.token;
      send("ENGINE_EMBEDDED_READY", { token: message.token });
      return;
    }
    if (!message || message.protocol !== VIEWPORT_PROTOCOL || typeof message.requestId !== "string" || message.requestId.length > 160) return;
    if (message.kind === "response") {
      if (event.source !== globalThis.parent) return;
      const pending = viewportRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer); viewportRequests.delete(message.requestId);
      pending.resolve({ centered: message.centered === true, readingPort: validRect(message.readingPort) ? plainRect(message.readingPort) : null });
      return;
    }
    if (message.kind !== "request" || !alignmentAllowed || !watching || !validRect(message.rect) ||
        !Number.isInteger(message.depth) || message.depth < 0 || message.depth >= 12 ||
        !Number.isFinite(message.viewport?.width) || !Number.isFinite(message.viewport?.height) ||
        message.viewport.width < 1 || message.viewport.height < 1 ||
        message.readingPort !== undefined && !validRect(message.readingPort)) return;
    const frame = queryAll("iframe").find(item => item.contentWindow === event.source && visible(item));
    if (!frame || ancestorTimers.size > 12) return;
    const transform = () => {
      const bounds = frame.getBoundingClientRect();
      const transformX = bounds.width / (Number(frame.offsetWidth) || Number(frame.clientWidth) || bounds.width);
      const transformY = bounds.height / (Number(frame.offsetHeight) || Number(frame.clientHeight) || bounds.height);
      const scaleX = transformX * (Number(frame.clientWidth) || bounds.width) / message.viewport.width;
      const scaleY = transformY * (Number(frame.clientHeight) || bounds.height) / message.viewport.height;
      return { left: bounds.left + (frame.clientLeft || 0) * transformX,
        top: bounds.top + (frame.clientTop || 0) * transformY, scaleX, scaleY };
    };
    const project = rect => {
      const value = transform();
      return { left: value.left + rect.left * value.scaleX, top: value.top + rect.top * value.scaleY,
        width: rect.width * value.scaleX, height: rect.height * value.scaleY };
    };
    const unproject = rect => {
      const value = transform();
      return { left: (rect.left - value.left) / value.scaleX, top: (rect.top - value.top) / value.scaleY,
        width: rect.width / value.scaleX, height: rect.height / value.scaleY };
    };
    const projected = () => project(message.rect);
    const projectedPort = () => message.readingPort ? intersectRects(project(message.readingPort),
      project({ left: 0, top: 0, width: message.viewport.width, height: message.viewport.height }), viewportBounds(frame)) : null;
    const respond = (centered, readingPort = null) => {
      try { event.source.postMessage({ protocol: VIEWPORT_PROTOCOL, kind: "response", requestId: message.requestId, centered,
        ...(validRect(readingPort) ? { readingPort: unproject(readingPort) } : {}) }, "*"); }
      catch { /* Child was removed while confirming its visible viewport. */ }
    };
    const ownedFrame = flow?.embedded?.element === frame;
    const mixed = ownedFrame ? null : mixedMediaCandidate(frame, readingRegions(false, true), firstVisible(DOC_SELECTORS), activeTask());
    if (mixed?.readingBeforeVideo) {
      try { event.source.postMessage({ protocol: VIEWPORT_PROTOCOL, kind: "response", requestId: message.requestId, centered: false }, "*"); }
      catch { /* Child was removed while checking its reading context. */ }
      checkIdentity();
      return;
    }
    if (!message.readingPort && !flow?.frameTransport && (!flow?.embedded || ownedFrame)) centerInLocalViewport(frame, projected);
    const timer = setTimeout(() => {
      ancestorTimers.delete(timer);
      if (!alignmentAllowed || !watching || !frame.isConnected) return;
      const rect = projected();
      const port = projectedPort();
      if (message.readingPort ? !validRect(port) : !centeredRect(rect, frame) || !unclippedRect(frame, rect)) {
        respond(false);
        return;
      }
      topViewportConfirmed(rect, message.depth + 1, frame, port).then(result => {
        if (!alignmentAllowed || !watching || !frame.isConnected) return;
        const latest = projected();
        const finalPort = port && result.readingPort ? intersectRects(projectedPort(), result.readingPort) : null;
        const confirmed = result.centered && (port ? centeredInPort(latest, finalPort) : centeredRect(latest, frame) && unclippedRect(frame, latest)) &&
          Math.abs(latest.top - rect.top) < 2 && Math.abs(latest.height - rect.height) < 2;
        respond(confirmed, finalPort);
      });
    }, 350);
    ancestorTimers.add(timer);
  });

  function watchMedia(media) {
    const originalMuted = media.muted;
    const watchGeneration = mediaGateGeneration;
    let authorized = false;
    let gateInFlight = false;
    mediaOriginalMuted = originalMuted;
    const muteWasChanged = settings.muteVideo;
    const listeners = [];
    const on = (name, callback) => { media.addEventListener(name, callback); listeners.push([name, callback]); };
    on("playing", () => {
      if (!running || paused || media.paused) return;
      if (!authorized) {
        suppressMediaPause = true;
        try { media.pause(); } catch { /* Detached media. */ }
        suppressMediaPause = false;
        gatePlayback();
        return;
      }
      seenPlaying = true; phase = "playing"; detail = "正在播放，结束后继续本页后续内容"; report(true);
    });
    on("pause", () => {
      if (!running || paused || completed || !media.paused || media.ended || suppressMediaPause || gateInFlight) return;
      authorized = false;
      phase = "blocked"; detail = "视频已暂停，在课程播放器中点击播放即可继续"; report(true);
    });
    on("ended", () => { if (seenPlaying && !media.loop) videoFinished(media); });
    on("waiting", () => {
      if (!running || paused || media.paused) return;
      phase = "waiting"; detail = "正在缓冲视频"; report(true);
    });
    on("stalled", () => {
      if (!running || paused || media.paused) return;
      phase = "waiting"; detail = "等待视频数据，请检查课程页面的网络状态"; report(true);
    });
    on("error", () => {
      if (!running || paused) return;
      phase = "error"; detail = `课程视频加载失败${media.error?.code ? `（错误 ${media.error.code}）` : ""}，请在播放器中重试`; report(true);
    });
    on("loadedmetadata", () => { if (running && !paused) report(true); });
    on("emptied", () => scheduleIdentityCheck());
    cleanupMedia = ({ pauseVideo, restoreMute }) => {
      gateInFlight = false;
      authorized = false;
      for (const [name, callback] of listeners) media.removeEventListener(name, callback);
      if (pauseVideo && !media.paused) { try { media.pause(); } catch { /* Detached media. */ } }
      if (restoreMute && (muteWasChanged || settings.muteVideo)) media.muted = originalMuted;
      mediaOriginalMuted = null;
    };
    if (settings.muteVideo) media.muted = true;
    if (media.ended) { try { media.currentTime = 0; } catch { /* Not seekable yet. */ } }
    if (!media.paused && !media.ended) {
      suppressMediaPause = true;
      try { media.pause(); } catch { /* Detached media. */ }
      suppressMediaPause = false;
    }
    function playCentered() {
      authorized = true;
      gateInFlight = false;
      try {
        const playPromise = media.play();
        playPromise?.then?.(() => {
          if (watchGeneration !== mediaGateGeneration || activeMedia !== media || !running || paused) return;
          seenPlaying = !media.paused && !media.ended;
          if (seenPlaying) { phase = "playing"; detail = "正在播放，结束后继续本页后续内容"; report(true); }
        }).catch(error => {
          if (watchGeneration !== mediaGateGeneration || activeMedia !== media || !running || paused) return;
          authorized = false;
          if (error?.name === "AbortError") { scheduleIdentityCheck(); return; }
          phase = "blocked";
          detail = error?.name === "NotAllowedError"
            ? "浏览器阻止了自动播放，请在课程播放器中点击一次播放"
            : "暂时无法播放，请在课程播放器中手动播放或重试";
          report(true);
        });
      } catch { authorized = false; phase = "blocked"; detail = "请在课程播放器中点击播放"; report(true); }
    }
    function gatePlayback(attempt = 0) {
      if (!running || paused || activeMedia !== media || !media.isConnected || gateInFlight) return;
      gateInFlight = true;
      const generation = mediaGateGeneration;
      phase = "centering"; detail = "正在确认视频播放器位于阅读区域中间，确认后播放";
      const rect = plainRect(media.getBoundingClientRect());
      const localCentered = visible(media, 50) && centeredRect(rect, media) && unclippedRect(media, rect);
      // The page runner reaches players using reading steps; a play gate never jumps past lesson text.
      const verify = () => {
        mediaGateTimer = null;
        if (generation !== mediaGateGeneration || !running || paused || activeMedia !== media) return;
        const measured = plainRect(media.getBoundingClientRect());
        if (!visible(media, 50) || !centeredRect(measured, media) || !unclippedRect(media, measured)) {
          gateInFlight = false;
          if (attempt < 7) { mediaGateTimer = setTimeout(() => gatePlayback(attempt + 1), 400); }
          else { phase = "blocked"; detail = "播放器尚未到阅读区域中间；请调整课程区域位置后点击重新识别"; }
          report(true);
          return;
        }
        const readingPort = digitalTextbookHost(media) ? viewportBounds(flow.scrollRoot, true) : null;
        topViewportConfirmed(measured, 0, media, readingPort).then(result => {
          if (generation !== mediaGateGeneration || !running || paused || activeMedia !== media) return;
          if (readingPort && validRect(result.readingPort)) flow.visibleReadingPort = result.readingPort;
          const latest = plainRect(media.getBoundingClientRect());
          if (result.centered && visible(media, 50) && centeredRect(latest, media) && unclippedRect(media, latest) &&
              Math.abs(latest.top - measured.top) < 2 && Math.abs(latest.height - measured.height) < 2) { playCentered(); return; }
          gateInFlight = false;
          if (readingPort && validRect(result.readingPort) && !centeredRect(latest, media)) {
            // A changed outer viewport can narrow the reader. Resume its timed,
            // downward steps instead of moving the surrounding page.
            if (cleanupMedia) { cleanupMedia({ pauseVideo: true, restoreMute: true }); cleanupMedia = null; }
            activeMedia = null; seenPlaying = false; scrollState = "scheduled";
            phase = "reading"; detail = "按内层教材的实际可见区域继续逐步滚动";
            evaluateFlow(); scheduleScroll(); report(true); return;
          }
          if (attempt < 3) mediaGateTimer = setTimeout(() => gatePlayback(attempt + 1), 400);
          else { phase = "blocked"; detail = "无法确认内嵌播放器位于阅读区域中间，请检查内嵌页面权限并重新识别"; }
          report(true);
        });
      };
      if (localCentered) verify();
      else mediaGateTimer = setTimeout(verify, 350);
      report(true);
    }
    gatePlayback();
  }

  function run(value, checkpoint, runId = null, resetPosition = !checkpoint, embedded = null) {
    configure(value);
    const result = detect();
    if (!result.candidate) return { ok: false, error: result.error || result.detail || "尚未识别任务", reason: result.reason };
    stop();
    current = result.candidate;
    embeddedBinding = embedded;
    activeRunId = runId;
    lastIdentity = current.key;
    lastContextKey = taskContextKey();
    lastCandidateMode = Boolean(current.readingBeforeVideo);
    readingScrollVerified = false;
    watching = true;
    running = true;
    alignmentAllowed = true;
    paused = false;
    completed = false;
    const matchingCheckpoint = !resetPosition && checkpoint?.key === current.key;
    scrollMovements = matchingCheckpoint ? Math.max(0, Number(checkpoint.scroll?.movements) || 0) : 0;
    scrollState = settings.scrollEnabled ? "scheduled" : "disabled";
    seenPlaying = false;
    elapsed = matchingCheckpoint ? Math.max(0, Number(checkpoint.elapsedSeconds) || 0) : 0;
    flow = { root: current.flowElement || current.element, frameTransport: current.frameTransport,
      played: new Set(matchingCheckpoint && Array.isArray(checkpoint.flow?.playedMediaIds) ? checkpoint.flow.playedMediaIds : []),
      videosCompleted: matchingCheckpoint ? Math.max(0, Number(checkpoint.flow?.videosCompleted) || 0) : 0, embedded: null,
      resumeEmbeddedId: matchingCheckpoint ? checkpoint.flow?.embeddedMediaId || null : null, guards: new Map(),
      disclosures: new WeakSet(), expandingMedia: null, expansionNeedsStep: false };
    flow.scrollRoot = courseScrollRoot();
    if (resetPosition) resetFlowPosition();
    lastTick = performance.now();
    guardFlowMedia();
    const guarded = flow.guards;
    flowGuardCleanup = () => { for (const [media, listener] of guarded) media.removeEventListener("playing", listener); };
    phase = "reading"; detail = flowDetail();
    evaluateFlow();
    scheduleScroll();
    if (running) timerId = setInterval(tick, 1000);
    report(true);
    return { ok: true, candidate: expose(current), snapshot: snapshot() };
  }

  function pause() {
    if (running && !activeMedia && !paused) {
      elapsed += Math.max(0, (performance.now() - lastTick) / 1000);
      lastTick = performance.now();
    }
    paused = true;
    running = false;
    alignmentAllowed = false;
    clearTimers();
    if (activeMedia) { try { activeMedia.pause(); } catch { /* Detached video. */ } }
    phase = "paused"; detail = "已暂停，点击继续可恢复当前任务";
    report(true);
    if (embeddedBinding) embeddedCheckpoint = snapshot();
    return { ok: true, snapshot: snapshot() };
  }

  function checkIdentity() {
    if (!watching) return;
    const result = detect();
    const contextKey = taskContextKey();
    const frameOrigins = embeddedFrameOrigins();
    const originSignature = frameOrigins.join("|");
    const key = result.candidate?.key || `none:${result.reason || "not_found"}:${contextKey}`;
    const sameTextbook = Boolean(current && flow && key === current.key &&
      flow.root?.isConnected && digitalTextbookHost(flow.root) === flow.root &&
      result.candidate?.flowElement === flow.root);
    const sameEmbeddedDocument = Boolean(embeddedBinding && ["text", "document"].includes(current?.type) && flow &&
      !digitalTextbookHost(flow.root) && key === current.key && ["text", "document"].includes(result.candidate?.type));
    if (sameEmbeddedDocument) {
      // Office previews replace their loading shell with rendered pages. Keep
      // the live delegation and move its reading anchor to the new surface.
      const previousTarget = flow.scrollRoot;
      if (previousTarget && previousTarget !== document.scrollingElement) {
        flow.documentPosition = Math.max(0, Number(previousTarget.scrollTop) || 0);
      }
      current = result.candidate;
      flow.root = current.flowElement || current.element;
      flow.frameTransport = current.frameTransport;
      if (!previousTarget?.isConnected || !flow.root.contains(previousTarget) && flow.root !== previousTarget) {
        flow.scrollRoot = courseScrollRoot();
        if (previousTarget && flow.scrollRoot && previousTarget !== flow.scrollRoot &&
            (flow.scrollRoot !== document.scrollingElement || previousTarget === document.scrollingElement)) {
          const position = Math.max(0, Number(flow.documentPosition ?? previousTarget.scrollTop) || 0,
            Number(flow.scrollRoot.scrollTop) || 0);
          try { flow.scrollRoot.scrollTo({ top: position, behavior: "instant" }); }
          catch { flow.scrollRoot.scrollTop = position; }
        }
      }
    }
    if (sameTextbook || sameEmbeddedDocument) {
      // Infinite readers recycle chapter leaves while retaining their scroll
      // host. Rebind the detection anchor without resetting the reading run.
      current = result.candidate;
      if (flow.embedded && !flow.embedded.element.isConnected) {
        const embedded = flow.embedded;
        const replacement = pageMedia().find(item => item.tagName === "IFRAME" && mediaId(item) === embedded.id);
        if (replacement || sameEmbeddedDocument) {
          embedded.cleanup?.(); flow.resumeEmbeddedId = embedded.id; flow.embedded = null;
        }
      }
      if (activeMedia && !activeMedia.isConnected) {
        if (cleanupMedia) { cleanupMedia({ pauseVideo: true, restoreMute: true }); cleanupMedia = null; }
        activeMedia = null; seenPlaying = false;
        clearTimeout(mediaGateTimer); mediaGateTimer = null;
        mediaGateGeneration += 1; cancelViewportRequests();
        flow.readingPortPending = false; flow.readingPortReady = false;
      }
    }
    const elementReplaced = Boolean(current && result.candidate?.key === current.key &&
      ((current.flowElement || current.element) !== (result.candidate.flowElement || result.candidate.element) || !current.element.isConnected));
    const mediaReplaced = Boolean(activeMedia && !activeMedia.isConnected);
    const mode = Boolean(result.candidate?.readingBeforeVideo);
    if (key === lastIdentity && !elementReplaced && !mediaReplaced && contextKey === lastContextKey && originSignature === lastFrameOrigins) {
      if (running && !scrollVerifyTimer) {
        evaluateFlow();
        if ((sameTextbook || sameEmbeddedDocument) && !scrollTimer) scheduleScroll();
      }
      return;
    }
    lastIdentity = key;
    lastCandidateMode = mode;
    lastContextKey = contextKey;
    lastFrameOrigins = originSignature;
    if (current && (key !== current.key || elementReplaced || mediaReplaced)) {
      // Keep SPA tasks from inheriting the previous task's timer or ended listener.
      stop();
      phase = "idle";
    }
    send("ENGINE_CHANGED", { candidate: expose(result.candidate), reason: result.reason, detail: result.detail, elementReplaced: Boolean(elementReplaced || mediaReplaced), frameOrigins, contextKey });
  }

  function scheduleIdentityCheck() {
    if (!watching || observerTimer) return;
    observerTimer = setTimeout(() => { observerTimer = null; checkIdentity(); }, 550);
  }

  function disabled(el) {
    return Boolean(el.disabled || el.getAttribute("aria-disabled") === "true" || el.closest("[inert]") || /(?:^|\s)(?:disabled|is-disabled|ant-btn-disabled)(?:\s|$)/.test(String(el.className)));
  }

  function dangerousTarget(el) {
    return MANUAL_TASK.test(text(el) || el.getAttribute("aria-label") || el.getAttribute("title") || "");
  }

  function folder(el) {
    return el.getAttribute("aria-expanded") !== null || el.matches(".chapter-title,.catalog-title,.section-title,[role='group']") || Boolean(el.querySelector(".el-tree-node__expand-icon:not(.is-leaf),.ant-tree-switcher:not(.ant-tree-switcher-noop)"));
  }

  function finishedItem(el) {
    return el.getAttribute("data-completed") === "true" || el.getAttribute("data-status") === "completed" || /(?:^|\s)(?:completed|is-completed|is-finished|learned|is-learned)(?:\s|$)/.test(String(el.className));
  }

  function clickNext(el) {
    if (dangerousTarget(el)) return { ok: false, reason: "manual_action", detail: "下一项是测验、实验或直播，需要手动处理。" };
    lastNavigationAt = performance.now();
    el.click();
    scheduleIdentityCheck();
    return { ok: true, clicked: true };
  }

  function advance(value) {
    configure(value);
    const error = invalidSelector();
    if (error) return { ok: false, reason: "invalid_selector", detail: error };
    if (performance.now() - lastNavigationAt < 1800) return { ok: true, clicked: false, detail: "等待上一项切换完成" };
    if (settings.selectors.next) {
      const specified = queryAll(settings.selectors.next).find(el => visible(el));
      if (!specified) return { ok: false, reason: "not_found", detail: "未找到设置中指定的下一项按钮。" };
      if (disabled(specified)) return { ok: false, reason: "end", detail: "下一项按钮不可用，课程可能已经结束。" };
      return clickNext(specified);
    }
    const explicit = queryAll("a[rel='next'],button[rel='next'],[data-action='next-task'],[data-action='next-lesson'],.vjs-next-control,.next-lesson,.next-task,.next-section")
      .filter(el => visible(el) && !el.closest("nav[aria-label*='分页'],.pagination,.el-pagination,.ant-pagination"));
    let disabledNext = false;
    for (const el of explicit) {
      if (disabled(el)) { disabledNext = true; continue; }
      return clickNext(el);
    }
    const controls = queryAll("button,a,[role='button'],[title],[aria-label]").filter(el => visible(el) && !el.closest(".pagination,.el-pagination,.ant-pagination"));
    for (const el of controls) {
      const label = (text(el) || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
      if (!NEXT_TEXT.test(label)) continue;
      if (disabled(el)) { disabledNext = true; continue; }
      return clickNext(el);
    }

    const active = activeTask();
    const selectors = settings.selectors.task ? [settings.selectors.task] : TASK_SELECTORS;
    if (active) {
      for (const selector of selectors) {
        const items = queryAll(selector).filter(el => visible(el) && !folder(el));
        const index = items.findIndex(el => el === active || el.contains(active) || active.contains(el));
        if (index < 0) continue;
        // Stay within the actual catalog containing the selected task, not unrelated page lists.
        const catalog = active.closest(".course-catalog,.catalog-list,.chapter-list,.lesson-list,[role='tree'],.el-tree,.ant-tree,aside,nav") || active.parentElement?.parentElement;
        const subsequent = items.slice(index + 1).filter(el => !catalog || catalog.contains(el));
        for (const el of subsequent) {
          if (disabled(el) || finishedItem(el) || !text(el)) continue;
          const clickable = el.matches("a,button,[role='button'],[role='treeitem']") ? el : el.querySelector("a,button,[role='button']") || el;
          return clickNext(clickable);
        }
        if (index === items.length - 1 || subsequent.length === 0) return { ok: false, reason: "end", detail: "已到达当前课程目录的最后一项。" };
      }
    }
    return disabledNext
      ? { ok: false, reason: "end", detail: "下一项按钮不可用，课程可能已经结束。" }
      : { ok: false, reason: "not_found", detail: "未找到下一项。请展开课程目录，或在高级设置中指定下一项按钮。" };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || typeof message.type !== "string" || !message.type.startsWith("ENGINE_")) return false;
    try {
      switch (message.type) {
        case "ENGINE_PROBE": {
          if (message.settings) configure(message.settings);
          watching = true;
          if (typeof message.viewportEnabled === "boolean") alignmentAllowed = message.viewportEnabled;
          const result = detect();
          const contextKey = taskContextKey();
          const frameOrigins = embeddedFrameOrigins();
          lastFrameOrigins = frameOrigins.join("|");
          if (lastIdentity === null) lastIdentity = result.candidate?.key || `none:${result.reason || "not_found"}:${contextKey}`;
          if (!result.candidate && result.reason === "not_found" && frameOrigins.length) {
            result.detail = "检测到其他网站嵌入的播放器或文档。请确认内嵌页面已连接；若仍无法识别，可复制诊断以适配当前课时。";
          }
          respond({ ...result, candidate: expose(result.candidate), frameOrigins, contextKey, diagnostics: probeDiagnostics(result) });
          break;
        }
        case "ENGINE_RUN": respond(run(message.settings, message.checkpoint, message.runId, message.resetPosition ?? !message.checkpoint)); break;
        case "ENGINE_EMBEDDED_REBIND": {
          const embedded = flow?.embedded;
          if (!running || paused || !embedded || message.runId !== activeRunId || message.token !== embedded.token || !embedded.element.isConnected) {
            respond({ ok: false }); break;
          }
          // A lazy iframe can load its content script after the first bind was sent.
          // Repeat only that binding, retaining the textbook and document positions.
          try {
            embedded.element.contentWindow.postMessage({ protocol: VIEWPORT_PROTOCOL, kind: "flow-bind", token: embedded.token }, "*");
            respond({ ok: true });
          } catch { respond({ ok: false }); }
          break;
        }
        case "ENGINE_EMBEDDED_RUN": {
          if (message.token !== pendingEmbeddedToken) { respond({ ok: false, error: "内嵌课程连接标识不匹配" }); break; }
          const checkpoint = message.resetPosition ? null : embeddedCheckpoint;
          if (message.resetPosition) embeddedCheckpoint = null;
          respond(run(message.settings, checkpoint, message.runId, Boolean(message.resetPosition), { token: message.token }));
          break;
        }
        case "ENGINE_EMBEDDED_STATUS": {
          const embedded = flow?.embedded;
          if (!running || !embedded || message.runId !== activeRunId || message.token !== embedded.token || !message.snapshot) { respond({ ok: true }); break; }
          embedded.deadline = Infinity;
          embedded.snapshot = message.snapshot;
          phase = message.snapshot.phase || "waiting";
          detail = message.snapshot.detail || "正在处理内嵌课程内容";
          report(true); respond({ ok: true }); break;
        }
        case "ENGINE_EMBEDDED_RETURN": {
          const embedded = flow?.embedded;
          if (!running || !embedded || message.runId !== activeRunId || message.token !== embedded.token) { respond({ ok: true }); break; }
          if (!message.ok) { phase = "blocked"; detail = message.detail || "内嵌内容未完成，请检查页面连接"; report(true); respond({ ok: true }); break; }
          flow.played.add(embedded.id);
          embedded.cleanup?.();
          flow.videosCompleted += Math.max(0, Number((message.snapshot || embedded.snapshot)?.flow?.videosCompleted) || 0);
          flow.embedded = null; phase = "reading"; scrollState = "scheduled";
          detail = "内嵌内容已结束，继续阅读同一页面下方内容";
          scheduleScroll(); report(true); respond({ ok: true }); break;
        }
        case "ENGINE_PAUSE": respond(pause()); break;
        case "ENGINE_STOP": {
          if (embeddedBinding && flow) embeddedCheckpoint = snapshot();
          stop(); watching = false; completed = false; lastIdentity = null; lastFrameOrigins = null;
          readingScrollVerified = false; scrollMovements = 0; scrollState = "idle"; elapsed = 0;
          lastContextKey = null; lastCandidateMode = null;
          flow = null; embeddedBinding = null;
          phase = "idle"; detail = "已停止"; respond({ ok: true }); break;
        }
        case "ENGINE_ADVANCE": respond(advance(message.settings)); break;
        case "ENGINE_SETTINGS": {
          const wasScroll = settings.scrollEnabled;
          const previousInterval = settings.scrollIntervalSeconds;
          configure(message.settings);
          if (running && !activeMedia && !flow?.embedded) {
            detail = readingScrollDetail();
            if (settings.scrollEnabled && (!wasScroll || previousInterval !== settings.scrollIntervalSeconds)) scheduleScroll();
            if (!settings.scrollEnabled) {
              clearTimeout(scrollTimer); scrollTimer = null;
              clearTimeout(scrollVerifyTimer); scrollVerifyTimer = null;
              nextScrollAt = 0;
              scrollState = "disabled";
            }
          }
          respond({ ok: true, snapshot: snapshot() }); break;
        }
        default: return false;
      }
    } catch (error) { respond({ ok: false, error: String(error?.message || error) }); }
    return false;
  });

  const observer = new MutationObserver(records => {
    if (!watching) return;
    if (running && flow) guardFlowMedia();
    // Ignore our own smooth scrolling; content/class/media replacement changes are relevant.
    if (records.some(record => record.type === "childList" || record.type === "characterData" || ["src", "class", "aria-selected", "aria-current", "data-task-id", "data-id", "hidden", "data-completed", "data-status", "data-task-completed", "data-current-task-completed"].includes(record.attributeName))) scheduleIdentityCheck();
  });
  observer.observe(document.documentElement || document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["src", "class", "aria-selected", "aria-current", "data-task-id", "data-id", "hidden", "data-completed", "data-status", "data-task-completed", "data-current-task-completed"] });
  addEventListener("hashchange", scheduleIdentityCheck);
  addEventListener("popstate", scheduleIdentityCheck);
  watchTimer = setInterval(() => { if (watching) checkIdentity(); }, 2500);
  addEventListener("pagehide", () => { stop(); clearTimeout(observerTimer); observerTimer = null; clearInterval(watchTimer); observer.disconnect(); });
  addEventListener("pageshow", event => {
    if (!event.persisted) return;
    observer.observe(document.documentElement || document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["src", "class", "aria-selected", "aria-current", "data-task-id", "data-id", "hidden", "data-completed", "data-status", "data-task-completed", "data-current-task-completed"] });
    watchTimer = setInterval(() => { if (watching) checkIdentity(); }, 2500);
    send("ENGINE_READY");
  });
  send("ENGINE_READY");
})();
