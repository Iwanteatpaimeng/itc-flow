"use strict";

// Deliberately serve the fixture only on loopback; no external packages required.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png" };
const port = Number(process.env.ITC_FIXTURE_PORT) || 8765;

http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/tests/popup-preview.html") {
      let source = await fs.readFile(path.join(root, "popup.html"), "utf8");
      source = source.replace('href="styles.css"', 'href="/styles.css"')
        .replace('<script src="shared.js"></script>', '<script src="/tests/popup-preview.js"></script><script src="/shared.js"></script>')
        .replace('src="popup.js"', 'src="/popup.js"');
      response.writeHead(200, { "Content-Type": types[".html"], "Cache-Control": "no-store" }).end(source);
      return;
    }
    if (url.pathname === "/tests/engine-preview.html") {
      let source = await fs.readFile(path.join(root, "tests/fixtures/course.html"), "utf8");
      source = source.replace('src="course.js"', 'src="/tests/fixtures/course.js"')
        .replace("</body>", '<script src="/tests/engine-preview.js"></script><script src="/shared.js"></script><script src="/content.js"></script></body>');
      response.writeHead(200, { "Content-Type": types[".html"], "Cache-Control": "no-store" }).end(source);
      return;
    }
    const requested = decodeURIComponent(url.pathname === "/" ? "/tests/fixtures/course.html" : url.pathname);
    const filename = path.resolve(root, `.${requested}`);
    if (filename !== root && !filename.startsWith(root + path.sep)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const body = await fs.readFile(filename);
    response.writeHead(200, { "Content-Type": types[path.extname(filename)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Fixture: http://127.0.0.1:${port}/tests/fixtures/course.html`));
