import readline from "node:readline";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { classifyConnectionError } from "./errors.mjs";
import { budgetOption, hasCredentials } from "./auth.mjs";
import { hasAnswer, normalizeQuestionAnswers } from "./questions.mjs";
import {
  commandAppearsOutsideWorkspace,
  containsForbiddenPath,
  normalizeGuardPath,
} from "./paths.mjs";
import {
  classifyTool,
  alignChecklistToExpectedPlan,
  ENABLED_TOOLS,
  expectedPlanTitleFor,
  expectedPlanTitlesFromPrompt,
  isChecklistMetaTask,
  PLAN_TOOLS,
  planFromTasks,
  planFromTodos,
  updatedChecklistTask,
  taskKeyForUpdate,
  toolsForProfile,
} from "./policy.mjs";
import { collectProjectInstructions } from "./instructions.mjs";
import {
  makeEnvelope,
  normalizeSdkMessage,
  parseLine,
  PROTOCOL_VERSION,
  redactForDiagnostic,
} from "./protocol.mjs";
import { shouldStartFreshSession } from "./recovery.mjs";
import { streamedStringField } from "./streamingJson.mjs";
import { TurnInputBroker } from "./turnInputBroker.mjs";
import { startKimiOpenAdapter } from "./openaiAnthropicAdapter.mjs";
import { createSdkPrompt } from "./multimodalPrompt.mjs";
import { reasoningOptionsForProvider } from "./reasoning.mjs";

const PROVIDER = process.env.MIN_AGENT_PROVIDER || "anthropic";
const PROVIDER_LABEL = process.env.MIN_AGENT_PROVIDER_LABEL
  || (PROVIDER === "kimi" ? "Kimi" : PROVIDER === "deepseek" ? "DeepSeek" : "Claude");
const ACCESS_PROFILE = process.env.MIN_AGENT_ACCESS_PROFILE || "claude";
const RUNTIME = PROVIDER === "anthropic" ? "claudeAgentBridge" : "compatibleAgentBridge";
let providerAdapter = null;
let providerTransportError = null;
let providerAdapterCloseTask = null;

async function configureProviderTransport() {
  if (ACCESS_PROFILE !== "kimiOpenPlatform") return;
  const apiKey = process.env.MIN_KIMI_OPEN_API_KEY;
  // The real Kimi key remains in this closure and is removed before the Agent
  // SDK child is created. That child can only see the loopback URL and a dummy
  // credential, never the upstream secret.
  delete process.env.MIN_KIMI_OPEN_API_KEY;
  const upstreamBaseUrl = process.env.MIN_AGENT_BRIDGE_TEST_MODE === "1"
    ? process.env.MIN_KIMI_OPEN_UPSTREAM_BASE_URL || "https://api.moonshot.ai/v1"
    : "https://api.moonshot.ai/v1";
  providerAdapter = await startKimiOpenAdapter({ apiKey, upstreamBaseUrl });
  process.env.ANTHROPIC_BASE_URL = providerAdapter.baseUrl;
  process.env.ANTHROPIC_API_KEY = "min-local-kimi-proxy";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

try {
  await configureProviderTransport();
} catch (error) {
  providerTransportError = error instanceof Error ? error.message : String(error);
}

function closeProviderTransport() {
  if (!providerAdapter) return providerAdapterCloseTask ?? Promise.resolve();
  const adapter = providerAdapter;
  providerAdapter = null;
  providerAdapterCloseTask = Promise.resolve(adapter.close()).catch((error) => {
    diagnostic("provider adapter close failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  return providerAdapterCloseTask;
}

const activeRequests = new Map();
const dispatchTasks = new Set();
const pendingInteractions = new Map();
const pendingSessionStore = new Map();
const sessionAllowedTools = new Set();
// A store egy nagyra nőtt adatbázison (ellenőrzés, WAL-visszaírás, párhuzamos
// lánc-írások) másodpercekig is dolgozhat egy-egy műveleten; 15 mp-nél a
// REVIEW szakasz emiatt halt meg turn közben. A türelem olcsó, a megszakadt
// szakasz drága.
const SESSION_STORE_TIMEOUT_MS = 60_000;

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
  // Teljes esemény-dump auditra: MIRE fut a GUI, soronként, időbélyeggel.
  // Csak kérésre él (env), mert mindent tartalmaz, amit a modell írt.
  const dumpPath = process.env.MIN_AGENT_BRIDGE_DUMP;
  if (dumpPath && type !== "session_store_request") {
    try {
      appendFileSync(
        dumpPath,
        `${JSON.stringify({ at: new Date().toISOString(), ...message })}\n`,
      );
    } catch {
      // A dump sosem viheti el a turnt.
    }
  }
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
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted-api-key]")
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
  return `Reply with exactly: ${PROVIDER_LABEL} kapcsolat rendben.`;
}

function missingCredentialsMessage() {
  if (providerTransportError) {
    return `A ${PROVIDER_LABEL} provider adaptere nem indult el: ${providerTransportError}`;
  }
  return `Nincs ${PROVIDER_LABEL} hitelesítés a bridge környezetében.`;
}

function providerReasoningOptions(effort) {
  process.env.MIN_AGENT_EFFECTIVE_EFFORT = effort;
  return reasoningOptionsForProvider(PROVIDER, effort);
}

function normalizeCwd(value) {
  const candidate = typeof value === "string" && value.trim() ? value : process.cwd();
  // Rust hands over a canonicalized root, which on Windows carries the
  // extended-length `\\?\` prefix. Claude sends plain absolute paths, so the
  // prefix has to go or every containment check against an absolute file_path
  // fails and in-project edits are denied.
  return normalizeGuardPath(candidate);
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
      reject(new Error(`A felhasználó megszakította a ${PROVIDER_LABEL}-eszköz kérését.`));
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
  // A majdnem-timeout is adat: ha egy művelet másodperceket vár, az a napló
  // mondja meg, mielőtt a következő futás tényleg elakadna rajta.
  if (pending.startedAt && Date.now() - pending.startedAt > 5_000) {
    diagnostic("session store slow op", {
      operation: pending.operation,
      tookMs: Date.now() - pending.startedAt,
      pendingOps: pendingSessionStore.size,
    });
  }
  if (payload?.ok === false) {
    pending.reject(new Error(typeof payload.error === "string" ? payload.error : "A SessionStore művelet sikertelen."));
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
  const startedAt = Date.now();
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingSessionStore.get(operationId);
      if (!pending) return;
      pendingSessionStore.delete(operationId);
      // Ki, mit, mennyi függő társsal — enélkül a timeout arca egy általános
      // hibaüzenet volt, és találgattuk, melyik művelet halt meg.
      diagnostic("session store timeout", {
        operation,
        operationId,
        waitedMs: Date.now() - startedAt,
        pendingOps: pendingSessionStore.size,
      });
      pending.reject(new Error(`A ${PROVIDER_LABEL} SessionStore művelete időtúllépés miatt megszakadt.`));
    }, SESSION_STORE_TIMEOUT_MS);
    pendingSessionStore.set(operationId, {
      requestId: turn.request.requestId,
      operation,
      startedAt,
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

/**
 * A session-mentés a folytathatóság kényelme, nem a turn terméke. Egy elakadt
 * append miatt eddig a REVIEW szakasz halt meg turn közben — a munka kárba
 * veszett egy olyan írás miatt, aminek az egyetlen tétje a későbbi resume.
 * A hiba naplóba kerül, a turn megy tovább; a hiányos session legfeljebb új
 * sessionként folytatódik, amit a meglévő recovery-út amúgy is kezel.
 */
function softenedSessionStoreOp(turn, operation, key, extra, fallback) {
  return sessionStoreRequest(turn, operation, key, extra).catch((error) => {
    diagnostic("session store op degraded", {
      operation,
      message: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  });
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
    append: (sessionKey, entries) =>
      softenedSessionStoreOp(turn, "append", key(sessionKey), { entries }, null),
    load: (sessionKey) =>
      softenedSessionStoreOp(turn, "load", key(sessionKey), {}, null),
    listSessions: (projectKey) =>
      softenedSessionStoreOp(turn, "listSessions", { projectKey }, {}, []),
    listSessionSummaries: (projectKey) =>
      softenedSessionStoreOp(turn, "listSessionSummaries", { projectKey }, {}, []),
    delete: (sessionKey) =>
      softenedSessionStoreOp(turn, "delete", key(sessionKey), {}, null),
    listSubkeys: (sessionKey) =>
      softenedSessionStoreOp(
        turn,
        "listSubkeys",
        {
          projectKey: sessionKey?.projectKey ?? turn.projectKey,
          sessionId: sessionKey?.sessionId ?? turn.sessionId,
        },
        {},
        [],
      ),
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
  if (options?.signal?.aborted) return deny(`A ${PROVIDER_LABEL}-kérés megszakadt.`);
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
    // A listát az assistant tool_use blokkja vezeti (csak ott van azonosító,
    // amivel a TaskUpdate visszatalál) — itt csak a teljes listát hozó
    // TodoWrite mehet ki, hogy egy auto-jóváhagyott hívás se maradjon le.
    if (toolName === "TodoWrite") {
      const plan = planFromTodos(input);
      if (plan.length > 0) {
        const activeStepId = plan.find((step) =>
          /^(in_progress|inprogress|running|active)$/i.test(String(step.status)),
        )?.id ?? null;
        emitAgentEvent(turn.request, turn.sessionId, "turn/plan/updated", {
          turnId: turn.sessionId ?? turn.request.requestId,
          plan,
          source: "claude-todo",
          activeStepId,
        });
      }
    }
    return allow();
  }

  if (kind === "bash") {
    const command = input?.command;
    if (commandAppearsOutsideWorkspace(command, cwd)) {
      return deny("A parancs védett belső állapotot vagy a kiválasztott workspace-en kívüli útvonalat érint.");
    }
    // Ugyanaz a modell, mint a Codex futtatónál: a parancs kérdés nélkül fut,
    // a védelem a munkaterület-határ — kifelé mutató útvonal, .git/.min fentebb
    // már tiltva. A jóváhagyó dialógus minden új projektben minden parancsra
    // újra megjelent, miközben a Codex oldalon ugyanez némán futott; a kettő
    // közti különbségnek nem volt indoka.
    return allow();
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

/**
 * A checklist-hívásból a panel lépéslistája.
 *
 * `TodoWrite` a teljes listát hozza, tehát elég leképezni. A natív build
 * `TaskCreate`/`TaskUpdate` párosánál egy hívás egy elemet érint, ezért a futó
 * listát a híd vezeti: az új elem a saját tool_use-azonosítója alatt kerül be
 * (a task azonosítóját csak az eszköz *eredménye* hozza meg), a `TaskUpdate`
 * pedig azon keresztül talál rá. A lekérdező hívások (`TaskList`, `TaskGet`)
 * nem módosítanak semmit.
 */
function planFromChecklistCall(turn, toolName, input, toolUseId) {
  if (toolName === "TodoWrite") {
    return alignChecklistToExpectedPlan(
      planFromTodos(input),
      turn.expectedPlanTitles,
    );
  }
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : "");
  if (toolName === "TaskCreate") {
    const key = toolUseId ?? randomUUID();
    const subject = text(input?.subject);
    const expectedTitle = expectedPlanTitleFor(subject, turn.expectedPlanTitles);
    turn.tasks.set(key, {
      planId: `claude-task:${key}`,
      // Keep the tool internally so TaskUpdate/result ids still resolve, but
      // do not let an invented "0. preparation" phase replace the accepted
      // planner list in the GUI.
      hidden:
        isChecklistMetaTask(subject)
        || (turn.expectedPlanTitles.length > 0 && !expectedTitle),
      subject: expectedTitle ?? subject,
      activeForm: text(input?.activeForm),
      status: "pending",
    });
    return planFromTasks(turn.tasks);
  }
  if (toolName === "TaskUpdate") {
    const taskId = text(input?.taskId);
    const key = taskKeyForUpdate(turn.tasks, turn.taskKeyById, taskId);
    // Do not create a new task for an id that the bridge cannot tie to a
    // TaskCreate. That would produce a phantom checklist row and make the UI
    // lose the real active task.
    if (!key) return planFromTasks(turn.tasks);
    const existing = turn.tasks.get(key) ?? {
      planId: `claude-task:${key}`,
      subject: "",
      activeForm: "",
      status: "pending",
    };
    const updated = updatedChecklistTask(
      existing,
      input,
      `claude-task:${key}`,
    );
    const status = updated.status;
    turn.tasks.set(key, updated);
    if (/^(in_progress|inprogress|running|active)$/i.test(status))
      turn.lastActiveTaskKey = key;
    return planFromTasks(turn.tasks);
  }
  return [];
}

/** The one explicit active Claude task, if the model has declared one. */
function activePlanStepId(turn, plan) {
  const lastActive = turn.lastActiveTaskKey
    ? turn.tasks.get(turn.lastActiveTaskKey)
    : null;
  if (lastActive?.status && /^(in_progress|inprogress|running|active)$/i.test(lastActive.status))
    return lastActive.planId ?? null;
  const active = [...turn.tasks.values()]
    .reverse()
    .find((task) => task?.status === "in_progress");
  if (active?.planId) return active.planId;
  return plan.find((step) => /^(in_progress|inprogress|running|active)$/i.test(String(step.status)))?.id ?? null;
}

/** A `TaskCreate` eredményéből a task azonosítója, ha kiolvasható. */
function createdTaskId(content) {
  const raw = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
      : "";
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    const id = parsed?.task?.id ?? parsed?.id;
    if (typeof id === "string" && id.trim()) return id;
  } catch {
    // Nem JSON: marad a szöveges kiolvasás.
  }
  const match = raw.match(/"id"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function emitToolStarted(turn, block) {
  const request = turn.request;
  const sessionId = turn.sessionId;
  const toolName = typeof block?.name === "string" ? block.name : "tool";
  const input = block?.input && typeof block.input === "object" ? block.input : {};

  // The checklist is a plan, not a tool card. Claude Code auto-approves it, so
  // the permission callback may never see it — the assistant's tool_use block
  // is the one place every update reliably passes through, and the only one
  // that carries the call's id.
  if (classifyTool(toolName) === "plan") {
    const plan = planFromChecklistCall(turn, toolName, input, block?.id);
    if (plan.length > 0) {
      const activeStepId = activePlanStepId(turn, plan);
      diagnostic("plan transition", {
        requestId: request.requestId,
        operation: toolName,
        taskId: typeof input?.taskId === "string" ? input.taskId : null,
        activeStepId,
        activeTaskIds: plan
          .filter((step) => /^(in_progress|inprogress|running|active)$/i.test(String(step.status)))
          .map((step) => step.id),
        plan: plan.map((step) => ({ id: step.id, status: step.status })),
      });
      emitAgentEvent(request, sessionId, "turn/plan/updated", {
        turnId: sessionId ?? request.requestId,
        plan,
        source: toolName === "TodoWrite" ? "claude-todo" : "claude-task",
        activeStepId,
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

/**
 * Az élő kódnézet adagja: amit a modell épp beír a fájlba.
 *
 * Csak akkor szólal meg, ha már tudjuk, melyik fájlról van szó — a `file_path`
 * a séma szerint a tartalom előtt érkezik, tehát ez néhány deltán belül
 * megvan. A tartalom onnantól minden darabbal nő; a felület a *teljes* eddigi
 * szöveget kapja, nem a különbséget, mert a darabhatárokon átnyúló escape-ek
 * miatt egy delta önmagában nem is mindig értelmes szöveg.
 */
function emitFileWriteDelta(turn, index, partialJson) {
  if (index == null || typeof partialJson !== "string") return;
  const write = turn.fileWrites.get(index);
  if (!write) return;
  write.json += partialJson;
  if (!write.path) {
    const path = streamedStringField(write.json, "file_path");
    if (!path?.complete) return;
    write.path = displayPath(path.value, turn.cwd);
  }
  // A `Write` a teljes tartalmat adja, az `Edit` a cserélendő és az új
  // szöveget. A felület mindkettőből fájlt rajzol; a szerkesztésnél a lemezen
  // álló tartalomra vetíti a foltot.
  const content = streamedStringField(write.json, "content");
  const oldString = streamedStringField(write.json, "old_string");
  const newString = streamedStringField(write.json, "new_string");
  if (!content && !newString) return;
  emitAgentEvent(turn.request, turn.sessionId, "item/fileWrite/delta", {
    itemId: write.id,
    turnId: turn.sessionId,
    item: {
      id: write.id,
      type: "fileWrite",
      toolName: write.name,
      filePath: write.path,
      mode: content ? "write" : "edit",
      content: content?.value,
      oldString: oldString?.complete ? oldString.value : undefined,
      newString: newString?.value,
      streaming: !(content ?? newString).complete,
    },
  });
}

/** Turns a tool_result block into the completion of the call that caused it. */
function emitToolCompleted(turn, block) {
  const id = typeof block?.tool_use_id === "string" ? block.tool_use_id : null;
  if (!id) return;
  // A `TaskCreate` eredménye hozza meg a task azonosítóját; a későbbi
  // `TaskUpdate` ezen keresztül talál vissza a listaelemre. Checklist-hívásnak
  // nincs kártyája, ezért itt véget is ér az útja.
  if (turn.tasks.has(id)) {
    const created = createdTaskId(block?.content);
    if (created) turn.taskKeyById.set(created, id);
    return;
  }
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
      payload: { provider: PROVIDER, runtime: RUNTIME, accessProfile: ACCESS_PROFILE },
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
        // Az azonosítóban benne van, hányadik üzenetről van szó: két külön
        // üzenet szövege így nem ragad egybe („…(folyamatban).7. lépés…"),
        // hanem bekezdéshatárt kap a felületen.
        itemId: raw.index != null
          ? `assistant-${turn.assistantTexts.length}-${raw.index}`
          : `assistant-${turn.assistantTexts.length}`,
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
        channel: "reasoning-summary",
        item: { type: "reasoning", phase: "commentary" },
      });
    }
    // A streamed `content_block_start` carries an empty tool input — the input
    // arrives afterwards as deltas — so emitting the tool card from here named
    // the row after the tool ("Edit") and left the enriched copy to merge into
    // it later. That merge is what kept losing the file path in a chain. The
    // card is emitted once, from the complete assistant message below, which
    // still lands before the tool actually runs.
    //
    // A kártya tehát nem innen jön — az élő kódnézet viszont igen. A fájlírás
    // tartalma pont ezekben a deltákban folyik, és ez az egyetlen hely, ahol
    // *írás közben* látható. Külön csatornán megy: a munkanapló sorait nem
    // szaporítja, csak a kódpanel olvassa.
    if (raw.type === "content_block_start" && raw.content_block?.type === "tool_use") {
      const name = raw.content_block.name;
      if (FILE_CHANGE_TOOLS.has(name) && raw.index != null)
        turn.fileWrites.set(raw.index, {
          id: raw.content_block.id ?? randomUUID(),
          name,
          json: "",
          path: null,
        });
      return;
    }
    if (raw.type === "content_block_delta" && delta.type === "input_json_delta") {
      emitFileWriteDelta(turn, raw.index, delta.partial_json);
      return;
    }
    if (raw.type === "content_block_stop" && raw.index != null)
      turn.fileWrites.delete(raw.index);
    return;
  }
  if (event?.type === "assistant") {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    // Egy korábbi üzenet szövege attól a pillanattól biztosan nem a végső
    // válasz, hogy egy újabb assistant-üzenet érkezett utána — mehet a
    // kommentár-sávra, élőben. A Claude a narrációt külön, csak-szöveges
    // üzenetben küldi, és csak a következőben hívja az eszközt, ezért nem volt
    // elég a tool_use-t is tartalmazó üzenetekre szűrni: a magyar gondolatok
    // így a szakasz legvégéig láthatatlanok maradtak.
    for (let index = 0; index < turn.assistantTexts.length; index += 1) {
      if (turn.liveCommentary.has(index)) continue;
      turn.liveCommentary.add(index);
      emitAgentEvent(request, turn.sessionId, "item/agentMessage/delta", {
        delta: turn.assistantTexts[index],
        itemId: `commentary-${index}`,
        turnId: turn.sessionId,
        phase: "commentary",
        channel: "assistant-output",
        item: { type: "agentMessage", phase: "commentary" },
      });
    }
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
    if (textParts.length > 0) {
      turn.assistantTexts.push(textParts.join("\n\n"));
      // Aki eszközt is hív ugyanabban az üzenetben, arról itt helyben eldőlt,
      // hogy narráció: nem kell megvárni a következő üzenetet.
      if (blocks.some((block) => block?.type === "tool_use")) {
        const index = turn.assistantTexts.length - 1;
        turn.liveCommentary.add(index);
        emitAgentEvent(request, turn.sessionId, "item/agentMessage/delta", {
          delta: turn.assistantTexts[index],
          itemId: `commentary-${index}`,
          turnId: turn.sessionId,
          phase: "commentary",
          channel: "assistant-output",
          item: { type: "agentMessage", phase: "commentary" },
        });
      }
    }
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

function createTurnPrompt(payload, hasResume, cwd) {
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const contextualPrompt =
    hasResume ||
    typeof payload.conversationContext !== "string" ||
    !payload.conversationContext.trim()
      ? prompt
      : `${payload.conversationContext}\n\n--- CURRENT USER REQUEST ---\n${prompt}`;
  return createSdkPrompt(contextualPrompt, payload.images, cwd);
}

async function runConnectionTest(request) {
  const payload = request.payload ?? {};
  if (providerTransportError || !hasCredentials()) {
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
        error: missingCredentialsMessage(),
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
        ...providerReasoningOptions(effort),
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
      : safeErrorMessage(errors ?? `A ${PROVIDER_LABEL} connection test sikertelen.`);
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
    // A napló mindig aktív és nem rotál, a `redactForDiagnostic` pedig kulcs
    // *nevekre* szűr, az `error` mezőre nem — ezen az úton pedig épp
    // hitelesítési hibák jönnek, amelyek beágyazhatják a kulcsot. Ezért a
    // redaktált változat kerül a naplóba, nem a nyers.
    diagnostic("connection test failed", {
      requestId: request.requestId,
      error: safeMessage,
    });
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
  if (providerTransportError || !hasCredentials()) {
    writeMessage({
      type: "turn_failed",
      request,
      sessionId: null,
      payload: {
        code: "missing_api_key",
        errorCode: "missing_api_key",
        message: missingCredentialsMessage(),
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
    // Indexes of assistantTexts already emitted as live commentary, so the
    // turn-end sweep does not append the same narration a second time.
    liveCommentary: new Set(),
    // A checklist futó listája: kulcs a `TaskCreate` tool_use-azonosítója,
    // érték a listaelem. A `taskKeyById` az eszköz által adott task-azonosítót
    // köti ide, mert a `TaskUpdate` csak azt ismeri.
    tasks: new Map(),
    taskKeyById: new Map(),
    lastActiveTaskKey: null,
    expectedPlanTitles: expectedPlanTitlesFromPrompt(payload.prompt),
    // content_block index → a készülő fájlírás: az azonosítója, az eddig
    // megérkezett nyers JSON és a fájl útvonala, amint kiderül. Ebből él az
    // élő kódnézet, amíg a hívás tart; a blokk lezárásakor kiürül.
    fileWrites: new Map(),
    inputAttemptSequence: 0,
    inputCloseCode: "no_active_turn",
    inputBroker: null,
  };
  diagnostic("turn checklist contract", {
    requestId: request.requestId,
    expectedPlanTitles: turn.expectedPlanTitles,
    hasCodingRole:
      typeof payload.prompt === "string"
      && payload.prompt.includes("[SZEREP]\nTe vagy a kódoló."),
  });
  turn.inputBroker = new TurnInputBroker({
    onAccepted: (entry, attemptId) => {
      writeMessage({
        type: "steer_accepted",
        request,
        sessionId: turn.sessionId,
        payload: {
          inputId: entry.inputId,
          attemptId,
          providerTurnId: turn.sessionId ?? request.requestId,
          ...entry.meta,
        },
      });
    },
    onRejected: (entry, code, message) => {
      writeMessage({
        type: "steer_rejected",
        request,
        sessionId: turn.sessionId,
        payload: { inputId: entry.inputId, code, message, ...entry.meta },
      });
    },
  });
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
        const inputAttemptId = `${request.requestId}:attempt-${++turn.inputAttemptSequence}`;
        // A late streamInput() call on a query that started with a string makes
        // the CLI a single-user-turn process. The steer text still arrives, but
        // its following permission callbacks hit a closed transport. Starting
        // with this open iterable makes the whole stage bidirectional from its
        // first user message onward.
        const inputStream = turn.inputBroker.beginAttempt(
          inputAttemptId,
          createTurnPrompt(payload, Boolean(resumeForQuery), cwd),
        );
        const stream = query({
          prompt: inputStream,
          options: {
            model,
            ...providerReasoningOptions(effort),
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
            // A natív build a `tools` listából nem minden eszközt regisztrál
            // (a d.ts maga mondja: „List Grep/Glob here or in allowedTools to
            // get them") — a TodoWrite is így hiányzott, a kódoló kétszer is
            // leírta, hogy nem kapta meg, és a LÉPÉSEK csak a fájlnév-alapú
            // tartalék-léptetésből mozgott. Az itt felsoroltak jóváhagyás
            // nélkül futnak, ezért csak a lemezt nem író eszközök: a todo-
            // frissítést az assistant tool_use blokkja így is a panelre viszi.
            allowedTools: [...PLAN_TOOLS, "Grep", "Glob"].filter((tool) =>
              stageTools.includes(tool),
            ),
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
        try {
          for await (const event of stream) {
            if (typeof event?.session_id === "string") turn.sessionId = event.session_id;
            handleSdkEvent(turn, event);
            if (event?.type === "result") {
              finalResult = event;
              if (turn.inputBroker.recordResult(inputAttemptId)) {
                turn.inputBroker.finishAttempt(inputAttemptId);
              }
            }
          }
        } finally {
          turn.inputBroker.endAttempt(inputAttemptId);
        }
        if (!finalResult) throw new Error(`A ${PROVIDER_LABEL} bridge nem adott turn eredményt.`);
        if (finalResult.subtype !== "success") {
          const errors = Array.isArray(finalResult.errors) ? finalResult.errors.filter((item) => typeof item === "string").join("; ") : `A ${PROVIDER_LABEL} turn sikertelen.`;
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
            turn.liveCommentary = new Set();
            turn.tasks = new Map();
            turn.taskKeyById = new Map();
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
        turn.liveCommentary = new Set();
        turn.tasks = new Map();
        turn.taskKeyById = new Map();
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
            channel: "status",
            item: { type: "reasoning", phase: "commentary" },
          });
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          if (abortController.signal.aborted) break;
          finalResult = null;
          turn.sawText = false;
          turn.assistantTexts = [];
          turn.liveCommentary = new Set();
          turn.tasks = new Map();
          turn.taskKeyById = new Map();
          continue;
        }
      }
      break;
    }
    if (!finalResult) throw new Error(`A ${PROVIDER_LABEL} bridge nem adott turn eredményt.`);
    if (finalResult.subtype !== "success") {
      const errors = Array.isArray(finalResult.errors) ? finalResult.errors.filter((item) => typeof item === "string").join("; ") : `A ${PROVIDER_LABEL} turn sikertelen.`;
      const safeErrors = safeErrorMessage(errors);
      writeMessage({
        type: "turn_failed",
        request,
        sessionId: turn.sessionId,
        payload: { code: finalResult.subtype ?? "turn_failed", errorCode: classifyConnectionError(errors), message: safeErrors, sessionId: turn.sessionId, totalCostUsd: finalResult.total_cost_usd ?? null },
      });
      turn.inputCloseCode = "runtime_failed";
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
      // Ami élőben már kiment, azt a lezárás nem ismételheti: a GUI itemId
      // szerint fűzi a deltákat, és a második példány duplázta a szöveget.
      if (turn.liveCommentary.has(index)) continue;
      emitAgentEvent(request, turn.sessionId, "item/agentMessage/delta", {
        delta: commentaryText,
        itemId: `commentary-${index}`,
        turnId: turn.sessionId,
        phase: "commentary",
        channel: "assistant-output",
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
      turn.inputCloseCode = "run_cancelled";
      writeMessage({ type: "turn_failed", request, sessionId: turn.sessionId, payload: { code: "cancelled", errorCode: "cancelled", message: `A ${PROVIDER_LABEL}-kérés megszakadt.` } });
    } else {
      turn.inputCloseCode = "runtime_failed";
      const safeMessage = safeErrorMessage(error);
      diagnostic("live turn failed", { requestId: request.requestId, error: safeMessage });
      writeMessage({ type: "turn_failed", request, sessionId: turn.sessionId, payload: { code: "turn_failed", errorCode: classifyConnectionError(message), message: safeMessage } });
    }
  } finally {
    turn.inputBroker.close(
      turn.inputCloseCode,
      turn.inputCloseCode === "run_cancelled"
        ? `A ${PROVIDER_LABEL} futást az input elfogadása előtt leállították.`
        : turn.inputCloseCode === "runtime_failed"
          ? `A ${PROVIDER_LABEL} runtime az input elfogadása előtt leállt.`
          : `A ${PROVIDER_LABEL} turn lezárult az input elfogadása előtt.`,
    );
    rejectSessionStoreForRequest(request.requestId, `A ${PROVIDER_LABEL} turn lezárult a SessionStore válasza előtt.`);
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
    writeMessage({ type: "ready", request, payload: { protocolVersion: PROTOCOL_VERSION, bridgeVersion: "0.3.0", capabilities: ["live_turn", "resume_turn", "connection_test", "approvals", "questions", "steer_turn"] } });
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
  if (type === "steer_turn") {
    const turn = activeRequests.get(request.requestId);
    const inputId = typeof request.payload?.inputId === "string"
      ? request.payload.inputId
      : "";
    const reject = (code, message) => writeMessage({
      type: "steer_rejected",
      request,
      sessionId: turn?.sessionId ?? null,
      payload: { inputId, code, message },
    });
    if (!turn || !turn.inputBroker) {
      reject("no_active_turn", `A ${PROVIDER_LABEL} turn már nem aktív.`);
      return;
    }
    const expectedTurnId = typeof request.payload?.expectedProviderTurnId === "string"
      ? request.payload.expectedProviderTurnId
      : "";
    const activeTurnId = turn.sessionId ?? request.requestId;
    if (!expectedTurnId || expectedTurnId !== activeTurnId) {
      reject("target_changed", `A célzott ${PROVIDER_LABEL} turn közben megváltozott.`);
      return;
    }
    const queued = turn.inputBroker.enqueue({
      inputId,
      text: request.payload?.text,
      meta: {
        conversationId: request.payload?.conversationId,
        rootRequestId: request.payload?.rootRequestId,
        providerRequestId: request.requestId,
        pipelineRunId: request.payload?.pipelineRunId,
        stageIndex: request.payload?.stageIndex,
        stageRole: request.payload?.stageRole,
        stageEpoch: request.payload?.stageEpoch,
      },
    });
    if (!queued.accepted) {
      reject(queued.code, queued.code === "duplicate_input"
        ? `Ezt az inputot a ${PROVIDER_LABEL} futás már feldolgozta.`
        : `A ${PROVIDER_LABEL} inputcsatornája nem fogadta el az üzenetet.`);
    }
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
      if (shuttingDown && activeRequests.size === 0 && dispatchTasks.size === 0) {
        void closeProviderTransport().finally(() => process.exit(0));
      }
    });
  dispatchTasks.add(task);
});

input.on("close", async () => {
  for (const turn of activeRequests.values()) turn?.abortController?.abort?.();
  for (const pending of pendingSessionStore.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(`A ${PROVIDER_LABEL} bridge lezárult.`));
  }
  pendingSessionStore.clear();
  await Promise.allSettled([...dispatchTasks]);
  await closeProviderTransport();
  process.exit(0);
});
