// Shared CDP client for the GUI tests. No npm dependencies: Node's native
// WebSocket talks to the WebView2 debug port opened by min.exe.
export const DEFAULT_PORT = 9222;

export async function findPage(port = DEFAULT_PORT) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find(
    (target) => target.type === "page" && target.url.includes("tauri.localhost"),
  );
  if (!page) throw new Error("no tauri page target on the debug port");
  return page;
}

export async function connect(port = DEFAULT_PORT) {
  const page = await findPage(port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method) for (const listener of listeners) listener(message);
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP websocket connect failed"));
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  /** Runs an expression in the page and returns its value (awaits promises). */
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        `page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    return result.result.value;
  };

  return {
    page,
    send,
    evaluate,
    on: (listener) => listeners.add(listener),
    close: () => ws.close(),
    /** Resolves when the socket dies, so a monitor can exit with the app. */
    closed: new Promise((resolve) => {
      ws.addEventListener("close", () => resolve());
    }),
  };
}

/**
 * A compact fingerprint of what the UI currently shows. Pixel hashes alone
 * cannot say *what* changed, and animations make them noisy, so every frame is
 * stored next to this.
 */
export const DOM_STATE_EXPRESSION = `(() => {
  const text = (selector) =>
    document.querySelector(selector)?.textContent?.trim() ?? null;
  const count = (selector) => document.querySelectorAll(selector).length;
  return {
    title: text('.conversation-title, header h1'),
    composerValue: document.querySelector('.composer-wrap textarea')?.value ?? null,
    composerPlaceholder:
      document.querySelector('.composer-wrap textarea')?.placeholder ?? null,
    sendLabel: document
      .querySelector('.composer-wrap .send-button')
      ?.getAttribute('aria-label') ?? null,
    runInputIntent: text('.run-input-intent'),
    pipelineCaption: text('.composer-pipeline-progress'),
    stageRailClasses: [...document.querySelectorAll('.pipeline-run-header .pipeline-run-tab')]
      .map((tab) => tab.className),
    counts: {
      conversations: count('.conversation-row'),
      messages: count('.compact-answer-card, .detailed-run-shell'),
      steps: count('.detailed-step-list .trace-step-row'),
      changeFiles: count('.trace-change-list li'),
      dialogs: count('[role="dialog"]'),
    },
    modals: [...document.querySelectorAll('[role="dialog"]')].map(
      (node) => node.getAttribute('aria-label') ?? node.className,
    ),
    scroll: Math.round(
      document.querySelector('.chat-scroll, main')?.scrollTop ?? 0,
    ),
  };
})()`;
