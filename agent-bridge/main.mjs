import readline from "node:readline";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { classifyConnectionError } from "./errors.mjs";
import { budgetOption, hasCredentials, MISSING_CREDENTIALS_MESSAGE } from "./auth.mjs";
import { hasAnswer, normalizeQuestionAnswers } from "./questions.mjs";
import { normalizeGuardPath } from "./paths.mjs";
import { classifyTool, ENABLED_TOOLS, planFromTodos, toolsForProfile } from "./policy.mjs";
import { collectProjectInstructions } from "./instructions.mjs";
import {
  makeEnvelope,
  normalizeSdkMessage,
  parseLine,
  PROTOCOL_VERSION,
  redactForDiagnostic,
} from "./protocol.mjs";
import { shouldStartFreshSession } from "./recovery.mjs";

const activeRequests = new Map();
const dispatchTasks = new Set();
const pendingInteractions = new Map();
const pendingSessionStore = new Map();
const sessionAllowedTools = new Set();
const SESSION_STORE_TIMEOUT_MS = 15_000;

/**
 * Tools the user has granted, per workspace.
 *
 * This process is spawned per turn, so a grant kept in memory alone was gone
 * before the next command: "allow for this session" asked again every time,
 * every stage, forever. The grant is written to disk instead, keyed by the
 * workspace it was given in -- approving a command in one project must not
 * quietly approve it in another.
 */
const approvalsPath = () => process.env.MIN_AGENT_APPROVALS_PATH || "";

const workspaceKey = (cwd) =>
  typeof cwd === "string" && cwd.trim()
    ? path.resolve(cwd).replace(/\\/g, "/").toLowerCase()
    : "";

function readApprovals() {
  const file = approvalsPath();
  if (!file) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // No file yet, or a corrupted one. Either way the safe reading is "nothing
    // has been granted": a missing grant costs one dialog, a wrong one runs a
    // command the user never approved.
    return {};
  }
}

function grantedTools(cwd) {
  const key = workspaceKey(cwd);
  if (!key) return [];
  const entry = readApprovals()[key];
  return Array.isArray(entry) ? entry : [];
}

function rememberGrantedTool(cwd, toolName) {
  const file = approvalsPath();
  const key = workspaceKey(cwd);
  if (!file || !key || !toolName) return;
  try {
    const approvals = readApprovals();
    const existing = Array.isArray(approvals[key]) ? approvals[key] : [];
    if (existing.includes(toolName)) return;
    approvals[key] = [...existing, toolName];
    writeFileSync(file, `${JSON.stringify(approvals, null, 2)}\n`, "utf8");
  } catch (error) {
    diagnostic("a jóváhagyás nem menthető", { message: error?.message });
  }
}
let outputSequence = 0;
let shuttingDown = false;

function writeMessage({ type, request, payload = {}, sessionId = null }) {
  const message = makeEnvelope({
    type,
    requestId: request?.requestId ?? "bridge",
    conversationId: request?.conversationId ?? null,
    sessionId,
    sequence: ++outputSequence,
    payload,
  });
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function diagnostic(message, details = {}) {
  const line = `[claude-bridge] ${message} ${JSON.stringify(redactForDiagnostic(details))}\n`;
  process.stderr.write(line);
  // The supervisor discards the child's stderr, so bridge diagnostics are
  // invisible in the running app. Setting MIN_AGENT_BRIDGE_LOG mirrors them to
  // a file — the payload is already credential-redacted by redactForDiagnostic.
  const logPath = process.env.MIN_AGENT_BRIDGE_LOG;
  if (logPath) {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${line}`);
    } catch {
      // Diagnostics must never take the turn down.
    }
  }
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(anthropic_api_key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 2000);
}

function bridgeError(request, code, message) {
  writeMessage({
    type: "agent_event",
    request,
    payload: { eventType: "protocol_error", code, message },
  });
}

function connectionPrompt() {
  return "Reply with exactly: Claude kapcsolat rendben.";
}

function normalizeCwd(value) {
  const candidate = typeof value === "string" && value.trim() ? value : process.cwd();
  // Rust hands over a canonicalized root, which on Windows carries the
  // extended-length `\\?\` prefix. Claude sends plain absolute paths, so the
  // prefix has to go or every containment check against an absolute file_path
  // fails and in-project edits are denied.
  return normalizeGuardPath(candidate);
}

function isInside(root, candidate) {
  const resolvedRoot = normalizeGuardPath(root);
  const resolvedCandidate = normalizeGuardPath(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function candidateInputPaths(toolName, input, cwd) {
  const values = [];
  for (const key of ["file_path", "filePath", "path", "directory", "cwd"]) {
    if (typeof input?.[key] === "string" && input[key].trim()) values.push(input[key]);
  }
  if (toolName === "Glob" && typeof input?.pattern === "string") {
    const pattern = input.pattern.trim();
    if (path.isAbsolute(pattern)) values.push(pattern);
  }
  return values.map((value) => path.resolve(cwd, value));
}

function containsForbiddenPath(candidate, cwd) {
  if (!isInside(cwd, candidate)) return true;
  const relative = path.relative(cwd, candidate).replaceAll("\\", "/").toLowerCase();
  return relative.split("/").some((segment) =>
    [".git", ".min", "conversation audits", "artifacts"].includes(segment),
  );
}

function commandAppearsOutsideWorkspace(command, cwd) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (/\.git(?:[\\/]|$)|\.min(?:[\\/]|$)|conversation audits/i.test(command)) return true;
  const windowsPaths = command.match(/[A-Za-z]:[\\/][^\s"';&|<>]*/g) ?? [];
  const unixPaths = command.match(/(?:^|\s)(\/(?:[^\s"';&|<>]+))/g) ?? [];
  return [...windowsPaths, ...unixPaths.map((value) => value.trim())].some((value) =>
    containsForbiddenPath(path.resolve(cwd, value), cwd),
  );
}

function deny(message) {
  return { behavior: "deny", message, interrupt: false };
}

function allow(input, updatedPermissions) {
  return {
    behavior: "allow",
    ...(input ? { updatedInput: input } : {}),
    ...(updatedPermissions ? { updatedPermissions } : {}),
  };
}

function waitForInteraction(request, kind, payload, signal) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const entry = { id, requestId: request.requestId, kind, resolve, reject };
    pendingInteractions.set(id, entry);
    const type = kind === "approval" ? "approval_requested" : "question_requested";
    writeMessage({ type, request, sessionId: request.sessionId ?? null, payload: { ...payload, ...(kind === "approval" ? { approvalId: id } : { questionId: id }) } });
    const abort = () => {
      if (!pendingInteractions.has(id)) return;
      pendingInteractions.delete(id);
      reject(new Error("A felhasználó megszakította a Claude-eszköz kérést."));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function resolveInteraction(request, kind, payload) {
  const id = kind === "approval" ? payload?.approvalId : payload?.questionId;
  if (typeof id !== "string") throw new Error("Hiányzó interaction azonosító.");
  const pending = pendingInteractions.get(id);
  if (!pending || pending.requestId !== request.requestId) {
    throw new Error("Az interaction már lezárult vagy nem található.");
  }
  pendingInteractions.delete(id);
  pending.resolve(payload);
}

function resolveSessionStore(payload) {
  const operationId = payload?.operationId;
  const pending = typeof operationId === "string" ? pendingSessionStore.get(operationId) : null;
  if (!pending) return;
  pendingSessionStore.delete(operationId);
  clearTimeout(pending.timeout);
  if (payload?.ok === false) {
    pending.reject(new Error(typeof payload.error === "string" ? payload.error : "A SessionStore mÅ±velet sikertelen."));
    return;
  }
  pending.resolve(payload?.result ?? null);
}

function rejectSessionStoreForRequest(requestId, message) {
  for (const [operationId, pending] of pendingSessionStore) {
    if (pending.requestId !== requestId) continue;
    pendingSessionStore.delete(operationId);
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }
}

function sessionStoreRequest(turn, operation, key, extra = {}) {
  const operationId = randomUUID();
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingSessionStore.get(operationId);
      if (!pending) return;
      pendingSessionStore.delete(operationId);
      pending.reject(new Error("A Claude SessionStore művelete időtúllépés miatt megszakadt."));
    }, SESSION_STORE_TIMEOUT_MS);
    pendingSessionStore.set(operationId, {
      requestId: turn.request.requestId,
      resolve,
      reject,
      timeout,
    });
  });
  writeMessage({
    type: "session_store_request",
    request: turn.request,
    sessionId: turn.sessionId,
    payload: { operationId, operation, key, ...extra },
  });
  return promise;
}

function createSessionStore(turn) {
  const key = (sessionKey) => ({
    projectKey: typeof sessionKey?.projectKey === "string" && sessionKey.projectKey.trim()
      ? sessionKey.projectKey
      : turn.projectKey,
    sessionId: sessionKey?.sessionId ?? turn.sessionId,
    ...(typeof sessionKey?.subpath === "string" && sessionKey.subpath ? { subpath: sessionKey.subpath } : {}),
  });
  return {
    append: (sessionKey, entries) => sessionStoreRequest(turn, "append", key(sessionKey), { entries }),
    load: (sessionKey) => sessionStoreRequest(turn, "load", key(sessionKey)),
    listSessions: (projectKey) => sessionStoreRequest(turn, "listSessions", { projectKey }),
    listSessionSummaries: (projectKey) => sessionStoreRequest(turn, "listSessionSummaries", { projectKey }),
    delete: (sessionKey) => sessionStoreRequest(turn, "delete", key(sessionKey)),
    listSubkeys: (sessionKey) => sessionStoreRequest(turn, "listSubkeys", {
      projectKey: sessionKey?.projectKey ?? turn.projectKey,
      sessionId: sessionKey?.sessionId ?? turn.sessionId,
    }),
  };
}

function permissionUpdateFor(toolName) {
  return [{
    type: "addRules",
    rules: [{ toolName }],
    behavior: "allow",
    destination: "session",
  }];
}

/** Az Anthropic átmeneti túlterhelése: érdemes megvárni, nem elbukni. */
const MAX_OVERLOAD_RETRIES = 3;

function isTransientOverload(message) {
  const text = String(message ?? "").toLowerCase();
  return /529|overloaded|temporarily unavailable|503/.test(text);
}

async function canUseToolForTurn(turn, toolName, input, options) {
  const cwd = turn.cwd;
  if (options?.signal?.aborted) return deny("A Claude-kérés megszakadt.");
  if (sessionAllowedTools.has(toolName)) return allow();
  // A grant given in an earlier turn counts: the dialog promised it would.
  if (grantedTools(cwd).includes(toolName)) {
    sessionAllowedTools.add(toolName);
    return allow(undefined, permissionUpdateFor(toolName));
  }

  const kind = classifyTool(toolName);

  if (kind === "workspace") {
    const candidates = candidateInputPaths(toolName, input, cwd);
    if (candidates.some((candidate) => containsForbiddenPath(candidate, cwd))) {
      return deny("A művelet a kiválasztott workspace-en kívülre vagy védett belső fájlra mutat.");
    }
    return allow();
  }

  // Read-only and workspace-blind: searching or fetching a page cannot change
  // anything on disk, and a subagent's own tool calls come back through this
  // same gate, so neither widens what the turn is allowed to do.
  if (kind === "network" || kind === "delegation") return allow();

  // The checklist Claude keeps for itself is exactly what the LÉPÉSEK panel was
  // built to show, so every write is forwarded as a plan update before the tool
  // runs. The panel already renders this event shape for the Codex runtime.
  if (kind === "plan") {
    const plan = planFromTodos(input);
    if (plan.length > 0) {
      emitAgentEvent(turn.request, turn.sessionId, "turn/plan/updated", {
        turnId: turn.sessionId ?? turn.request.requestId,
        plan,
      });
    }
    return allow();
  }

  if (kind === "bash") {
    const command = input?.command;
    if (commandAppearsOutsideWorkspace(command, cwd)) {
      return deny("A parancs védett belső állapotot vagy a kiválasztott workspace-en kívüli útvonalat érint.");
    }
    const result = await waitForInteraction(
      turn.request,
      "approval",
      {
        toolName,
        input,
        title: options?.title ?? "Claude parancs futtatását kéri",
        reason: options?.decisionReason ?? null,
        displayName: options?.displayName ?? "Bash",
        description: options?.description ?? null,
      },
      options?.signal,
    );
    const decision = result?.decision;
    if (decision === "acceptForSession") {
      sessionAllowedTools.add(toolName);
      rememberGrantedTool(cwd, toolName);
      return allow(undefined, permissionUpdateFor(toolName));
    }
    if (decision === "accept") return allow();
    return deny(result?.reason || "A felhasználó nem engedélyezte a parancsot.");
  }

  if (kind === "question") {
    const result = await waitForInteraction(
      turn.request,
      "question",
      { questions: input?.questions ?? [] },
      options?.signal,
    );
    // The SDK reads `answers` keyed by each question's full text; a record keyed
    // by anything else is ignored and the model is told "no answer provided", so
    // the client's answer is normalized here rather than trusted verbatim.
    const normalized = normalizeQuestionAnswers(input, result?.answer);
    if (!hasAnswer(normalized)) return deny("Nem érkezett érvényes válasz.");
    return allow({ questions: input?.questions ?? [], ...normalized });
  }

  return deny(`A(z) ${toolName} eszköz nincs engedélyezve ebben a kliensben.`);
}

function emitAgentEvent(request, sessionId, eventType, payload = {}) {
  diagnostic("emit", { eventType, itemId: payload?.item?.id ?? payload?.itemId ?? null });
  writeMessage({
    type: "agent_event",
    request,
    sessionId,
    payload: { eventType, ...payload },
  });
}

/** Tools whose whole point is changing a file; their card is a file card. */
const FILE_CHANGE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** Tool output forwarded to the GUI; the rest stays in the session log. */
const TOOL_OUTPUT_LIMIT = 4000;

function truncatedOutput(value) {
  if (typeof value !== "string") return undefined;
  return value.length > TOOL_OUTPUT_LIMIT ? `${value.slice(0, TOOL_OUTPUT_LIMIT)}\n[...]` : value;
}

/** Paths shown to the user are project-relative; absolute ones repeat the
 * project prefix on every row and push the file name out of view. */
function displayPath(filePath, cwd) {
  if (typeof filePath !== "string" || typeof cwd !== "string" || !cwd) return filePath;
  const normalized = filePath.replaceAll("/", "\\");
  const root = cwd.replaceAll("/", "\\").replace(/\\+$/, "");
  if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}\\`)) {
    return normalized.slice(root.length + 1);
  }
  return filePath;
}

/** The GUI shape of one tool call, shared by its started and completed events. */
function toolItemFor(toolName, input, id, cwd) {
  const rawPath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.notebook_path === "string"
        ? input.notebook_path
        : undefined;
  const filePath = displayPath(rawPath, cwd);
  const isFileChange = FILE_CHANGE_TOOLS.has(toolName) && typeof filePath === "string";
  const type = toolName === "Bash" ? "commandExecution" : isFileChange ? "fileChange" : "tool";
  return {
    kindSlug: type === "commandExecution" ? "commandExecution" : type === "fileChange" ? "fileChange" : "tool",
    item: {
      id,
      type,
      name: toolName,
      toolName,
      command: typeof input.command === "string" ? input.command : undefined,
      filePath,
      path: typeof input.path === "string" ? input.path : undefined,
      // What the edit does, so the trace can show a real diff instead of a
      // bare tool name. Write has no before; the SDK does not send one.
      before: typeof input.old_string === "string" ? input.old_string : undefined,
      after:
        typeof input.new_string === "string"
          ? input.new_string
          : typeof input.content === "string"
            ? input.content
            : undefined,
    },
  };
}

function emitToolStarted(turn, block) {
  const request = turn.request;
  const sessionId = turn.sessionId;
  const toolName = typeof block?.name === "string" ? block.name : "tool";
  const input = block?.input && typeof block.input === "object" ? block.input : {};

  // The checklist is a plan, not a tool card. Claude Code auto-approves
  // TodoWrite, so the permission callback may never see it — the assistant's
  // tool_use block is the one place every update reliably passes through.
  if (classifyTool(toolName) === "plan") {
    const plan = planFromTodos(input);
    if (plan.length > 0) {
      emitAgentEvent(request, sessionId, "turn/plan/updated", {
        turnId: sessionId ?? request.requestId,
        plan,
      });
    }
    return;
  }

  const id = block?.id ?? randomUUID();
  const { kindSlug, item } = toolItemFor(toolName, input, id, turn.cwd);
  // The streamed content_block_start arrives with an empty input — the input
  // itself streams as deltas — so this fires again from the complete assistant
  // message with the same id, and the second pass carries the file path and
  // the edit body. Recording the meta lets the tool_result, which carries only
  // the id, get a completion event of the right kind.
  turn.toolMeta.set(id, {
    name: toolName,
    kindSlug,
    filePath: item.filePath,
    command: item.command,
  });
  emitAgentEvent(request, sessionId, `item/${kindSlug}/started`, {
    item: { ...item, status: "running" },
  });
}

/** Turns a tool_result block into the completion of the call that caused it. */
function emitToolCompleted(turn, block) {
  const id = typeof block?.tool_use_id === "string" ? block.tool_use_id : null;
  if (!id) return;
  const meta = turn.toolMeta.get(id);
  if (!meta) return;
  const rawContent = block?.content;
  const outputText = typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .filter(Boolean)
          .join("\n")
      : undefined;
  emitAgentEvent(turn.request, turn.sessionId, `item/${meta.kindSlug}/completed`, {
    item: {
      id,
      type: meta.kindSlug,
      name: meta.name,
      toolName: meta.name,
      filePath: meta.filePath,
      command: meta.command,
      output: truncatedOutput(outputText),
      status: block?.is_error ? "error" : "completed",
    },
  });
}

function handleSdkEvent(turn, event) {
  const request = turn.request;
  if (typeof event?.session_id === "string") turn.sessionId = event.session_id;
  if (event?.type === "system" && event?.subtype === "init") {
    writeMessage({
      type: "session_started",
      request,
      sessionId: turn.sessionId,
      payload: { provider: "anthropic", runtime: "claudeAgentBridge" },
    });
    emitAgentEvent(request, turn.sessionId, "turn/started", {
      turnId: turn.sessionId,
      item: { type: "turn", status: "started" },
    });
    return;
  }
  if (event?.type === "stream_event") {
    const raw = event.event ?? {};
    const delta = raw.delta ?? {};
    if (raw.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
      turn.sawText = true;
      emitAgentEvent(request, turn.sessionId, "item/agentMessage/delta", {
        delta: delta.text,
        itemId: raw.index != null ? `assistant-${raw.index}` : "assistant",
        turnId: turn.sessionId,
        phase: "final_answer",
        item: { type: "agentMessage", phase: "final_answer" },
      });
    } else if (raw.type === "content_block_delta" && delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      emitAgentEvent(request, turn.sessionId, "item/agentMessage/delta", {
        delta: delta.thinking,
        itemId: raw.index != null ? `thinking-${raw.index}` : "thinking",
        turnId: turn.sessionId,
        phase: "commentary",
        item: { type: "reasoning", phase: "commentary" },
      });
    }
    // A streamed `content_block_start` carries an empty tool input — the input
    // arrives afterwards as deltas — so emitting the tool card from here named
    // the row after the tool ("Edit") and left the enriched copy to merge into
    // it later. That merge is what kept losing the file path in a chain. The
    // card is emitted once, from the complete assistant message below, which
    // still lands before the tool actually runs.
    return;
  }
  if (event?.type === "assistant") {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    const textParts = [];
    for (const [index, block] of blocks.entries()) {
      if (block?.type === "tool_use") {
        emitToolStarted(turn, block);
      } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        textParts.push(block.text);
      } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        // The stream shows the thinking as it happens; this is the durable
        // row for it, so a Claude stage's GONDOLKODÁS list is no longer
        // empty on reload while a Codex stage's is full.
        emitAgentEvent(request, turn.sessionId, "item/reasoning/completed", {
          item: {
            id: `thinking-${event.message?.id ?? turn.assistantTexts.length}-${index}`,
            type: "reasoning",
            text: block.thinking,
            status: "completed",
          },
        });
      }
    }
    if (textParts.length > 0) turn.assistantTexts.push(textParts.join("\n\n"));
    return;
  }
  if (event?.type === "user") {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of blocks) {
      if (block?.type === "tool_result") emitToolCompleted(turn, block);
    }
    return;
  }
  if (event?.type === "tool_progress") {
    emitAgentEvent(request, turn.sessionId, "item/tool/progress", {
      itemId: event.tool_use_id ?? null,
      item: {
        type: "tool",
        name: event.tool_name ?? "tool",
        status: "running",
        output: event.output ?? null,
      },
    });
    return;
  }
  if (event?.type === "system" && event?.subtype === "permission_denied") {
    emitAgentEvent(request, turn.sessionId, "item/tool/denied", {
      item: { type: "tool", name: event.tool_name ?? "tool", status: "error", body: event.message ?? "Tiltva" },
    });
  }
}

function createTurnPrompt(payload, hasResume) {
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (hasResume || typeof payload.conversationContext !== "string" || !payload.conversationContext.trim()) return prompt;
  return `${payload.conversationContext}\n\n--- CURRENT USER REQUEST ---\n${prompt}`;
}

async function runConnectionTest(request) {
  const payload = request.payload ?? {};
  if (!hasCredentials()) {
    writeMessage({
      type: "connection_result",
      request,
      payload: {
        success: false,
        model: payload.model ?? "claude-sonnet-5",
        effort: payload.effort ?? "low",
        text: null,
        sessionId: null,
        totalCostUsd: null,
        errorCode: "missing_api_key",
        error: MISSING_CREDENTIALS_MESSAGE,
      },
    });
    return;
  }

  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : "claude-sonnet-5";
  const effort = typeof payload.effort === "string" && payload.effort.trim() ? payload.effort.trim() : "low";
  const maxBudgetUsd = typeof payload.maxBudgetUsd === "number" ? payload.maxBudgetUsd : 0.05;
  const maxTurns = typeof payload.maxTurns === "number" ? payload.maxTurns : 1;
  const cwd = normalizeCwd(payload.cwd);
  let sessionId = null;
  let finalResult = null;
  try {
    const stream = query({
      prompt: connectionPrompt(),
      options: {
        model,
        effort,
        ...budgetOption(maxBudgetUsd),
        maxTurns,
        cwd,
        allowedTools: [],
        tools: [],
        permissionMode: "default",
        persistSession: false,
        settingSources: [],
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "min-local-ai-workspace/0.1.0" },
      },
    });
    for await (const event of stream) {
      const normalized = normalizeSdkMessage(event);
      if (normalized.sessionId) sessionId = normalized.sessionId;
      if (event?.type === "result") finalResult = event;
    }
    const success = finalResult?.subtype === "success";
    const errors = Array.isArray(finalResult?.errors) ? finalResult.errors.filter((item) => typeof item === "string").join("; ") : null;
    const error = success
      ? null
      : safeErrorMessage(errors ?? "A Claude connection test sikertelen.");
    writeMessage({
      type: "connection_result",
      request,
      sessionId,
      payload: {
        success,
        model,
        effort,
        text: success && typeof finalResult?.result === "string" ? finalResult.result : null,
        sessionId,
        totalCostUsd: typeof finalResult?.total_cost_usd === "number" ? finalResult.total_cost_usd : null,
        errorCode: success ? null : classifyConnectionError(error),
        error,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = safeErrorMessage(error);
    diagnostic("connection test failed", { requestId: request.requestId, error: message });
    writeMessage({
      type: "connection_result",
      request,
      sessionId,
      payload: {
        success: false,
        model,
        effort,
        text: null,
        sessionId,
        totalCostUsd: null,
        errorCode: classifyConnectionError(message),
        error: safeMessage,
      },
    });
  }
}

async function runLiveTurn(request) {
  const payload = request.payload ?? {};
  if (!hasCredentials()) {
    writeMessage({
      type: "turn_failed",
      request,
      sessionId: null,
      payload: {
        code: "missing_api_key",
        errorCode: "missing_api_key",
        message: MISSING_CREDENTIALS_MESSAGE,
      },
    });
    return;
  }
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : "claude-sonnet-5";
  const effort = typeof payload.effort === "string" && payload.effort.trim() ? payload.effort.trim() : "low";
  const maxBudgetUsd = typeof payload.maxBudgetUsd === "number" ? payload.maxBudgetUsd : 0.05;
  const maxTurns = typeof payload.maxTurns === "number" ? payload.maxTurns : 1;
  const cwd = normalizeCwd(payload.cwd);
  const initialResume = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : null;
  const abortController = new AbortController();
  const turn = {
    request,
    cwd,
    projectKey: typeof payload.projectKey === "string" && payload.projectKey.trim() ? payload.projectKey : cwd,
    abortController,
    sessionId: initialResume,
    sawText: false,
    // tool_use id → {name, filePath, command}: a tool_result block carries only
    // the id, so typing its completion event needs what the call looked like.
    toolMeta: new Map(),
    // Joined text of every complete assistant message, in order. The last one
    // is the actual answer; the earlier ones are commentary the model wrote
    // between tool calls. `result.result` glues all of them together without
    // separators, which is where the "tests.32/32 teszt zöld" artifacts came
    // from — so the answer is reconstructed from here instead.
    assistantTexts: [],
  };
  activeRequests.set(request.requestId, turn);
  // Without an explicit systemPrompt the SDK uses a minimal prompt that omits
  // Claude Code's coding guidance entirely, so the preset is requested and the
  // user's own AGENTS.md / CLAUDE.md is appended to it.
  const projectInstructions = collectProjectInstructions(cwd);
  if (projectInstructions.files.length > 0) {
    emitAgentEvent(request, turn.sessionId, "turn/instructions/loaded", {
      files: projectInstructions.files,
    });
  }
  // A pipeline stage narrows what the turn may do. Withholding the tools is
  // what makes a "do not edit files" role an actual constraint.
  const stageTools = toolsForProfile(payload.toolProfile);
  diagnostic("live turn starting", {
    requestId: request.requestId,
    resumeSessionId: initialResume,
    projectKey: turn.projectKey,
    toolProfile: payload.toolProfile ?? "full",
    toolCount: stageTools.length,
    cwd,
  });
  emitAgentEvent(request, turn.sessionId, "turn/started", { turnId: turn.sessionId ?? request.requestId, item: { type: "turn", status: "started" } });
  try {
    let finalResult = null;
    let resumeForQuery = initialResume;
    let overloadRetries = 0;
    while (true) {
      try {
        const stream = query({
          prompt: createTurnPrompt(payload, Boolean(resumeForQuery)),
          options: {
            model,
            effort,
            thinking: { type: "adaptive" },
            ...budgetOption(maxBudgetUsd),
            maxTurns,
            cwd,
            ...(resumeForQuery ? { resume: resumeForQuery } : {}),
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              ...(projectInstructions.text ? { append: projectInstructions.text } : {}),
            },
            tools: stageTools,
            allowedTools: [],
            permissionMode: "default",
            persistSession: true,
            sessionStore: createSessionStore(turn),
            sessionStoreFlush: "eager",
            settingSources: [],
            includePartialMessages: true,
            forwardSubagentText: true,
            canUseTool: (toolName, input, options) => canUseToolForTurn(turn, toolName, input, options),
            abortController,
            env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "min-local-ai-workspace/0.1.0" },
          },
        });
        finalResult = null;
        for await (const event of stream) {
          if (typeof event?.session_id === "string") turn.sessionId = event.session_id;
          handleSdkEvent(turn, event);
          if (event?.type === "result") finalResult = event;
        }
        if (!finalResult) throw new Error("A Claude bridge nem adott turn eredményt.");
        if (finalResult.subtype !== "success") {
          const errors = Array.isArray(finalResult.errors) ? finalResult.errors.filter((item) => typeof item === "string").join("; ") : "A Claude turn sikertelen.";
          if (shouldStartFreshSession(resumeForQuery, errors)) {
            diagnostic("remote session missing in result; starting a new Claude session", {
              requestId: request.requestId,
              sessionId: resumeForQuery,
            });
            rejectSessionStoreForRequest(request.requestId, "A hiányzó Claude remote session miatt új session indul.");
            resumeForQuery = null;
            turn.sessionId = null;
            turn.sawText = false;
            turn.assistantTexts = [];
            turn.toolMeta.clear();
            continue;
          }
        }
        break;
      } catch (error) {
        if (!shouldStartFreshSession(resumeForQuery, error)) throw error;
        diagnostic("remote session missing; starting a new Claude session", {
          requestId: request.requestId,
          sessionId: resumeForQuery,
        });
        rejectSessionStoreForRequest(request.requestId, "A hiányzó Claude remote session miatt új session indul.");
        resumeForQuery = null;
        turn.sessionId = null;
        turn.sawText = false;
        turn.assistantTexts = [];
        turn.toolMeta.clear();
        continue;
      }
      // Az Anthropic átmeneti túlterhelése (529) eddig megölte a szakaszt,
      // pedig percek munkája veszett vele, és a következő próbálkozás
      // rendszerint sikerül. Rövid, növekvő várakozás — csak erre az egy
      // hibafajtára, hogy egy valódi hiba továbbra is azonnal kiderüljön.
      if (finalResult && finalResult.subtype !== "success") {
        const failureText = Array.isArray(finalResult.errors)
          ? finalResult.errors.filter((item) => typeof item === "string").join("; ")
          : "";
        if (isTransientOverload(failureText) && overloadRetries < MAX_OVERLOAD_RETRIES) {
          overloadRetries += 1;
          const waitMs = 4000 * overloadRetries;
          diagnostic("transient overload; retrying the turn", {
            requestId: request.requestId,
            attempt: overloadRetries,
            waitMs,
          });
          emitAgentEvent(request, turn.sessionId, "item/agentMessage/delta", {
            delta: `A szolgáltatás túlterhelt. Újrapróbálom ${waitMs / 1000} másodperc múlva (${overloadRetries}/${MAX_OVERLOAD_RETRIES}).`,
            itemId: `overload-${overloadRetries}`,
            phase: "commentary",
            item: { type: "reasoning", phase: "commentary" },
          });
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          if (abortController.signal.aborted) break;
          finalResult = null;
          turn.sawText = false;
          turn.assistantTexts = [];
          continue;
        }
      }
      break;
    }
    if (!finalResult) throw new Error("A Claude bridge nem adott turn eredményt.");
    if (finalResult.subtype !== "success") {
      const errors = Array.isArray(finalResult.errors) ? finalResult.errors.filter((item) => typeof item === "string").join("; ") : "A Claude turn sikertelen.";
      const safeErrors = safeErrorMessage(errors);
      writeMessage({
        type: "turn_failed",
        request,
        sessionId: turn.sessionId,
        payload: { code: finalResult.subtype ?? "turn_failed", errorCode: classifyConnectionError(errors), message: safeErrors, sessionId: turn.sessionId, totalCostUsd: finalResult.total_cost_usd ?? null },
      });
      return;
    }
    const gluedText = typeof finalResult.result === "string" ? finalResult.result : "";
    // `result.result` is every text block of the turn glued together without
    // separators — "tests.32/32 teszt zöld" was born there. The answer is the
    // last complete assistant message; what came before it is the model's
    // between-tools narration and belongs on the thinking lane.
    const finalAnswer =
      turn.assistantTexts.length > 0
        ? turn.assistantTexts[turn.assistantTexts.length - 1]
        : gluedText;
    for (const [index, commentaryText] of turn.assistantTexts.slice(0, -1).entries()) {
      emitAgentEvent(request, turn.sessionId, "item/agentMessage/delta", {
        delta: commentaryText,
        itemId: `commentary-${index}`,
        turnId: turn.sessionId,
        phase: "commentary",
        item: { type: "agentMessage", phase: "commentary" },
      });
    }
    if (!turn.sawText && finalAnswer) {
      emitAgentEvent(request, turn.sessionId, "item/agentMessage/delta", { delta: finalAnswer, itemId: "assistant-final", turnId: turn.sessionId, phase: "final_answer", item: { type: "agentMessage", phase: "final_answer" } });
    }
    // The live bubble accumulated the glued stream; this swaps in the answer
    // alone once the turn is over.
    emitAgentEvent(request, turn.sessionId, "item/completed", {
      itemId: "assistant-final",
      item: { id: "assistant-final", type: "agentMessage", phase: "final_answer", text: finalAnswer, status: "completed" },
    });
    emitAgentEvent(request, turn.sessionId, "turn/completed", { finalText: finalAnswer, turnId: turn.sessionId, totalCostUsd: finalResult.total_cost_usd ?? null, usage: finalResult.usage ?? null, item: { type: "turn", status: "completed" } });
    writeMessage({
      type: "turn_completed",
      request,
      sessionId: turn.sessionId,
      payload: { text: finalAnswer, sessionId: turn.sessionId, totalCostUsd: typeof finalResult.total_cost_usd === "number" ? finalResult.total_cost_usd : null, usage: finalResult.usage ?? null, numTurns: finalResult.num_turns ?? null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (abortController.signal.aborted) {
      writeMessage({ type: "turn_failed", request, sessionId: turn.sessionId, payload: { code: "cancelled", errorCode: "cancelled", message: "A Claude-kérés megszakadt." } });
    } else {
      const safeMessage = safeErrorMessage(error);
      diagnostic("live turn failed", { requestId: request.requestId, error: safeMessage });
      writeMessage({ type: "turn_failed", request, sessionId: turn.sessionId, payload: { code: "turn_failed", errorCode: classifyConnectionError(message), message: safeMessage } });
    }
  } finally {
    rejectSessionStoreForRequest(request.requestId, "A Claude turn lezÃ¡rult a SessionStore vÃ¡lasza elÅ‘t.");
    activeRequests.delete(request.requestId);
  }
}

async function dispatch(request) {
  const type = request.type;
  if (type === "session_store_response") {
    resolveSessionStore(request.payload ?? {});
    return;
  }
  if (type === "initialize") {
    writeMessage({ type: "ready", request, payload: { protocolVersion: PROTOCOL_VERSION, bridgeVersion: "0.2.0", capabilities: ["live_turn", "resume_turn", "connection_test", "approvals", "questions"] } });
    return;
  }
  if (type === "test_connection") {
    await runConnectionTest(request);
    return;
  }
  if (type === "start_turn" || type === "resume_turn") {
    await runLiveTurn(request);
    return;
  }
  if (type === "cancel_turn") {
    const turn = activeRequests.get(request.requestId);
    if (turn) turn.abortController.abort();
    return;
  }
  if (type === "approval_response") {
    resolveInteraction(request, "approval", request.payload ?? {});
    return;
  }
  if (type === "question_response") {
    resolveInteraction(request, "question", request.payload ?? {});
    return;
  }
  if (type === "shutdown") {
    shuttingDown = true;
    for (const turn of activeRequests.values()) turn.abortController.abort();
    writeMessage({ type: "ready", request, payload: { shutdown: true } });
    return;
  }
  bridgeError(request, "unknown_message_type", `Ismeretlen bridge üzenet: ${type}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let request;
  try {
    request = parseLine(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostic("invalid protocol line", { error: message });
    return;
  }
  const task = dispatch(request)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      diagnostic("request failed", { requestId: request.requestId, error: message });
      bridgeError(request, "request_failed", "A bridge-kérés sikertelen.");
    })
    .finally(() => {
      dispatchTasks.delete(task);
      if (shuttingDown && activeRequests.size === 0 && dispatchTasks.size === 0) process.exit(0);
    });
  dispatchTasks.add(task);
});

input.on("close", async () => {
  for (const turn of activeRequests.values()) turn?.abortController?.abort?.();
  for (const pending of pendingSessionStore.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("A Claude bridge lezÃ¡rult."));
  }
  pendingSessionStore.clear();
  await Promise.allSettled([...dispatchTasks]);
  process.exit(0);
});
