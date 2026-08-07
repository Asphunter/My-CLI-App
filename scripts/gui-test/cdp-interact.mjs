// Interaction probe: type into the composer (without sending), click a phase
// tab in the vertical rail, then screenshot and restore the composer.
import { writeFileSync } from "node:fs";

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
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

// 1) Type into the composer through the real input path (React needs the
// native setter + input event), then read the value back.
const typed = await evaluate(`(() => {
  const textarea = document.querySelector('.composer-wrap textarea');
  if (!textarea) return 'no-textarea';
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, 'CDP interakciós teszt — nem küldöm el');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  return textarea.value;
})()`);

// 2) Click the first phase tab of the last finished run's rail, if present.
const railClick = await evaluate(`(() => {
  const tab = document.querySelector('.pipeline-run-header .pipeline-run-tab');
  if (!tab) return 'no-rail';
  tab.click();
  return 'clicked:' + tab.className;
})()`);

await new Promise((r) => setTimeout(r, 600));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(
  new URL("./min-gui-interact.png", import.meta.url),
  Buffer.from(shot.data, "base64"),
);

// 3) Restore: clear the composer so nothing lingers.
const cleared = await evaluate(`(() => {
  const textarea = document.querySelector('.composer-wrap textarea');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, '');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  return textarea.value === '' ? 'cleared' : 'not-cleared';
})()`);

console.log(JSON.stringify({ typed, railClick, cleared }, null, 2));
ws.close();
