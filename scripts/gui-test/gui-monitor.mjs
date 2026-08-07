// Long-running observer for the live GUI: screenshots the window once a second
// and keeps a frame only when the pixels actually changed, so a session's
// visual history stays reviewable without thousands of identical PNGs.
// Console errors, page exceptions and failed requests land in events.jsonl.
//
// Usage: node gui-monitor.mjs <outDir> [intervalMs]
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect, DOM_STATE_EXPRESSION } from "./cdp.mjs";

const outDir = process.argv[2];
const interval = Number(process.argv[3] ?? 1000);
if (!outDir) throw new Error("usage: node gui-monitor.mjs <outDir> [intervalMs]");
mkdirSync(`${outDir}/frames`, { recursive: true });

const eventsPath = `${outDir}/events.jsonl`;
const framesPath = `${outDir}/frames.jsonl`;
const logEvent = (event) =>
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);

const cdp = await connect();
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Page.enable");
await cdp.send("Network.enable");

cdp.on((message) => {
  const { method, params } = message;
  if (method === "Runtime.exceptionThrown")
    logEvent({
      at: new Date().toISOString(),
      kind: "pageError",
      text:
        params.exceptionDetails.exception?.description ??
        params.exceptionDetails.text,
    });
  else if (method === "Runtime.consoleAPICalled" && params.type !== "log")
    logEvent({
      at: new Date().toISOString(),
      kind: `console.${params.type}`,
      text: params.args
        .map((arg) => arg.description ?? JSON.stringify(arg.value))
        .join(" ")
        .slice(0, 2000),
    });
  else if (method === "Log.entryAdded" && params.entry.level !== "info")
    logEvent({
      at: new Date().toISOString(),
      kind: `log.${params.entry.level}`,
      text: params.entry.text?.slice(0, 2000),
      url: params.entry.url,
    });
  else if (method === "Network.loadingFailed")
    logEvent({
      at: new Date().toISOString(),
      kind: "requestFailed",
      text: params.errorText,
      type: params.type,
    });
  else if (
    method === "Network.responseReceived" &&
    params.response.status >= 400
  )
    logEvent({
      at: new Date().toISOString(),
      kind: "httpError",
      status: params.response.status,
      url: params.response.url,
    });
  // A reload mid-session would invalidate every earlier frame's context.
  else if (method === "Page.frameNavigated" && !params.frame.parentId)
    logEvent({
      at: new Date().toISOString(),
      kind: "navigated",
      url: params.frame.url,
    });
});

let previousPixels = null;
let previousDom = null;
let index = 0;
let running = true;
cdp.closed.then(() => {
  running = false;
});
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

logEvent({ at: new Date().toISOString(), kind: "monitorStarted", interval });

while (running) {
  const startedAt = Date.now();
  try {
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      optimizeForSpeed: true,
    });
    const pixels = createHash("sha1").update(shot.data).digest("hex");
    const dom = await cdp.evaluate(DOM_STATE_EXPRESSION);
    const domHash = createHash("sha1")
      .update(JSON.stringify(dom))
      .digest("hex");
    if (pixels !== previousPixels || domHash !== previousDom) {
      const at = new Date().toISOString();
      const name = `frame-${String(index).padStart(4, "0")}.png`;
      writeFileSync(`${outDir}/frames/${name}`, Buffer.from(shot.data, "base64"));
      appendFileSync(
        framesPath,
        `${JSON.stringify({
          at,
          frame: name,
          pixelsChanged: pixels !== previousPixels,
          domChanged: domHash !== previousDom,
          dom,
        })}\n`,
      );
      previousPixels = pixels;
      previousDom = domHash;
      index += 1;
    }
  } catch (error) {
    logEvent({
      at: new Date().toISOString(),
      kind: "monitorError",
      text: String(error.message ?? error),
    });
    // A dead socket means the app closed; anything else is worth retrying.
    if (String(error.message ?? error).includes("CLOSED")) break;
  }
  const spent = Date.now() - startedAt;
  if (spent < interval)
    await new Promise((resolve) => setTimeout(resolve, interval - spent));
}

logEvent({ at: new Date().toISOString(), kind: "monitorStopped", frames: index });
console.log(`monitor stopped after ${index} frames`);
cdp.close();
