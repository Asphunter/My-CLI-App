// Minimal CDP smoke test against the running min.exe WebView2 (port 9222).
import { writeFileSync } from "node:fs";

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("ws connect failed"));
});

const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true })).result
    .value;

const report = {
  title: await evaluate("document.title"),
  url: await evaluate("location.href"),
  projectCount: await evaluate(
    "document.querySelectorAll('.conversation-row').length",
  ),
  sidebarHeadings: await evaluate(
    "[...document.querySelectorAll('aside strong, aside h1, aside h2')].slice(0,8).map(n=>n.textContent.trim())",
  ),
  composerPresent: await evaluate(
    "Boolean(document.querySelector('.composer-wrap'))",
  ),
  // The removed status caption must not exist while no pipeline runs.
  pipelineCaptionCount: await evaluate(
    "document.querySelectorAll('.composer-pipeline-progress').length",
  ),
  jsErrors: await evaluate(
    "window.__smokeErrors ? window.__smokeErrors.length : 'not-instrumented'",
  ),
};

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(
  new URL("./min-gui-smoke.png", import.meta.url),
  Buffer.from(shot.data, "base64"),
);

console.log(JSON.stringify(report, null, 2));
ws.close();
