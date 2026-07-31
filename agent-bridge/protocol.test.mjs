import assert from "node:assert/strict";
import test from "node:test";
import { classifyConnectionError } from "./errors.mjs";
import {
  budgetOption,
  hasCredentials,
  isSubscriptionAuth,
  MISSING_CREDENTIALS_MESSAGE,
} from "./auth.mjs";
import { hasAnswer, normalizeQuestionAnswers } from "./questions.mjs";
import { normalizeGuardPath, stripExtendedLengthPrefix } from "./paths.mjs";
import {
  classifyTool,
  ENABLED_TOOLS,
  planFromTasks,
  planFromTodos,
  taskKeyForUpdate,
  toolsForProfile,
} from "./policy.mjs";
import { collectProjectInstructions } from "./instructions.mjs";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  isMissingRemoteSessionError,
  shouldStartFreshSession,
} from "./recovery.mjs";
import {
  makeEnvelope,
  normalizeSdkMessage,
  parseLine,
  redactForDiagnostic,
} from "./protocol.mjs";

test("bridge envelopes are versioned JSONL messages", () => {
  const envelope = makeEnvelope({
    type: "ready",
    requestId: "request-1",
    payload: { ok: true },
  });
  const parsed = parseLine(JSON.stringify(envelope));

  assert.equal(parsed.protocolVersion, 1);
  assert.equal(parsed.requestId, "request-1");
  assert.equal(parsed.type, "ready");
  assert.equal(parsed.payload.ok, true);
  assert.match(parsed.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("invalid protocol version is rejected without accepting the payload", () => {
  assert.throws(
    () => parseLine(JSON.stringify({ protocolVersion: 999, type: "ready", requestId: "x" })),
    /Unsupported bridge protocol version/,
  );
});

test("SDK result mapping never requires the raw prompt or environment", () => {
  const mapped = normalizeSdkMessage({
    type: "result",
    subtype: "success",
    session_id: "session-1",
    total_cost_usd: 0.01,
    result: "private response",
  });

  assert.deepEqual(mapped, {
    eventType: "result",
    subtype: "success",
    success: true,
    totalCostUsd: 0.01,
    sessionId: "session-1",
  });
});

test("diagnostics redact credentials and full prompt-like strings", () => {
  const redacted = redactForDiagnostic({
    apiKey: "sk-ant-secret",
    prompt: "A private prompt that must not be logged",
    nested: { token: "secret" },
  });

  assert.equal(redacted.apiKey, "[redacted]");
  assert.equal(redacted.nested.token, "[redacted]");
  assert.equal(redacted.prompt, "[40 chars]");
});

test("subscription auth counts as credentials without an API key", () => {
  const subscription = { MIN_AGENT_AUTH_MODE: "subscription" };

  assert.equal(isSubscriptionAuth(subscription), true);
  // The key is deliberately absent in this mode; the turn must not fail-fast.
  assert.equal(hasCredentials(subscription), true);
  assert.equal(
    hasCredentials({ MIN_AGENT_AUTH_MODE: "subscription", ANTHROPIC_API_KEY: "" }),
    true,
  );
});

test("api-key auth still requires a key in the bridge environment", () => {
  assert.equal(hasCredentials({ MIN_AGENT_AUTH_MODE: "apiKey", ANTHROPIC_API_KEY: "sk-ant-x" }), true);
  assert.equal(hasCredentials({ MIN_AGENT_AUTH_MODE: "apiKey" }), false);
  assert.equal(hasCredentials({}), false);
  assert.equal(isSubscriptionAuth({ MIN_AGENT_AUTH_MODE: "apiKey" }), false);
  assert.match(MISSING_CREDENTIALS_MESSAGE, /előfizetéses bejelentkezés/);
  assert.ok(!MISSING_CREDENTIALS_MESSAGE.includes("sk-ant"));
});

test("the USD budget ceiling is only sent on the metered api-key path", () => {
  // Subscription turns are not billed per token, so a notional cost must not
  // be able to stop the turn; maxTurns stays the guard there.
  assert.deepEqual(budgetOption(0.05, { MIN_AGENT_AUTH_MODE: "subscription" }), {});
  assert.deepEqual(budgetOption(0.05, { MIN_AGENT_AUTH_MODE: "apiKey" }), { maxBudgetUsd: 0.05 });
  assert.deepEqual(budgetOption(0.5, {}), { maxBudgetUsd: 0.5 });
});

const QUESTION_INPUT = {
  questions: [
    {
      question: "Should the new helper file be named 'alpha.js' or 'beta.js'?",
      header: "File name",
      options: [{ label: "alpha.js" }, { label: "beta.js" }],
      multiSelect: false,
    },
  ],
};

test("a header-keyed answer is remapped onto the question text the SDK reads", () => {
  // The GUI used to key by header; the SDK ignores that and reports
  // "no answer provided", losing the user's selection with no error.
  const normalized = normalizeQuestionAnswers(QUESTION_INPUT, { "File name": "alpha.js" });

  assert.deepEqual(normalized, {
    answers: { "Should the new helper file be named 'alpha.js' or 'beta.js'?": "alpha.js" },
  });
  assert.equal(hasAnswer(normalized), true);
});

test("an already correctly keyed answer passes through untouched", () => {
  const key = QUESTION_INPUT.questions[0].question;
  const normalized = normalizeQuestionAnswers(QUESTION_INPUT, { [key]: "beta.js" });

  assert.deepEqual(normalized, { answers: { [key]: "beta.js" } });
});

test("a single unambiguous answer is accepted under any key", () => {
  const key = QUESTION_INPUT.questions[0].question;
  const normalized = normalizeQuestionAnswers(QUESTION_INPUT, { answer: "beta.js" });

  assert.deepEqual(normalized, { answers: { [key]: "beta.js" } });
});

test("multi-select answers are joined the way the SDK expects", () => {
  const input = {
    questions: [
      { question: "Which sections?", header: "Sections", options: [], multiSelect: true },
    ],
  };
  const normalized = normalizeQuestionAnswers(input, { Sections: ["Intro", "Conclusion"] });

  assert.deepEqual(normalized, { answers: { "Which sections?": "Intro, Conclusion" } });
});

test("a freeform reply travels as response, not as a fake answer", () => {
  const normalized = normalizeQuestionAnswers(QUESTION_INPUT, { response: "  neither, use gamma.js  " });

  assert.equal(normalized.response, "neither, use gamma.js");
  assert.deepEqual(normalized.answers, {});
  assert.equal(hasAnswer(normalized), true);
});

test("an empty or missing selection is not passed off as an answer", () => {
  // A cancelled question card must deny the tool rather than resume the turn
  // with a blank answer the model cannot act on.
  assert.equal(hasAnswer(normalizeQuestionAnswers(QUESTION_INPUT, { "File name": "" })), false);
  assert.equal(hasAnswer(normalizeQuestionAnswers(QUESTION_INPUT, { "File name": [] })), false);
  assert.equal(hasAnswer(normalizeQuestionAnswers(QUESTION_INPUT, {})), false);
  assert.equal(hasAnswer(normalizeQuestionAnswers(QUESTION_INPUT, null)), false);
});

test("multiple questions are matched individually, not collapsed", () => {
  const input = {
    questions: [
      { question: "Format?", header: "Format", options: [] },
      { question: "Sections?", header: "Sections", options: [] },
    ],
  };
  const normalized = normalizeQuestionAnswers(input, { Format: "Summary", Sections: "Intro" });

  assert.deepEqual(normalized.answers, { "Format?": "Summary", "Sections?": "Intro" });
  // With more than one question the single-answer shortcut must not guess.
  assert.deepEqual(normalizeQuestionAnswers(input, { whatever: "Summary" }).answers, {});
});

test("a canonicalized Windows root and a plain absolute path compare equal", () => {
  // Rust canonicalizes the project root, which on Windows yields `\\?\C:\...`.
  // Claude sends plain absolute paths for Edit and Write, so without stripping
  // the prefix the guard rejected every in-project edit as "outside the
  // workspace" — reads survived only because relative paths were resolved
  // against the prefixed root.
  assert.equal(
    stripExtendedLengthPrefix("\\\\?\\C:\\Users\\dev\\project"),
    "C:\\Users\\dev\\project",
  );
  assert.equal(
    stripExtendedLengthPrefix("\\\\?\\UNC\\server\\share\\project"),
    "\\\\server\\share\\project",
  );
  // Ordinary paths, POSIX paths and non-strings pass through untouched.
  assert.equal(stripExtendedLengthPrefix("C:\\Users\\dev"), "C:\\Users\\dev");
  assert.equal(stripExtendedLengthPrefix("/home/dev/project"), "/home/dev/project");
  assert.equal(stripExtendedLengthPrefix(undefined), undefined);

  assert.equal(
    normalizeGuardPath("\\\\?\\C:\\Users\\dev\\project"),
    normalizeGuardPath("C:\\Users\\dev\\project"),
    "the two forms of the same root must normalize to one value",
  );
});

test("the tool policy separates workspace, network and delegation tools", () => {
  assert.equal(classifyTool("Edit"), "workspace");
  assert.equal(classifyTool("Read"), "workspace");
  assert.equal(classifyTool("WebSearch"), "network");
  assert.equal(classifyTool("WebFetch"), "network");
  assert.equal(classifyTool("Agent"), "delegation");
  assert.equal(classifyTool("Bash"), "bash");
  assert.equal(classifyTool("AskUserQuestion"), "question");
  // Anything unrecognised must stay unknown so the gate denies it.
  assert.equal(classifyTool("ComputerUse"), "unknown");
  assert.equal(classifyTool(""), "unknown");
});

test("Bash still requires approval while the new tools do not", () => {
  // Network and delegation tools cannot reach the workspace, so gating them
  // behind a prompt would add friction without adding safety. Bash can, and
  // therefore must keep its approval step.
  assert.notEqual(classifyTool("Bash"), "network");
  assert.equal(ENABLED_TOOLS.includes("Bash"), true);
  for (const tool of ["WebSearch", "WebFetch", "Agent"]) {
    assert.equal(ENABLED_TOOLS.includes(tool), true, `${tool} must be offered to the model`);
  }
  // The workspace tools the coding flow depends on are still present.
  for (const tool of ["Read", "Glob", "Grep", "Edit", "Write", "AskUserQuestion"]) {
    assert.equal(ENABLED_TOOLS.includes(tool), true, `${tool} missing from the tool set`);
  }
});

test("a TodoWrite payload becomes the plan shape the panel renders", () => {
  const plan = planFromTodos({
    todos: [
      { content: "Read math.js", status: "completed", activeForm: "Reading math.js" },
      { content: "Fix multiply", status: "in_progress", activeForm: "Fixing multiply" },
      { content: "Run the tests", status: "pending", activeForm: "Running the tests" },
    ],
  });

  assert.deepEqual(plan, [
    { id: "todo-0", step: "Read math.js", status: "completed" },
    { id: "todo-1", step: "Fix multiply", status: "in_progress" },
    { id: "todo-2", step: "Run the tests", status: "pending" },
  ]);
  assert.equal(classifyTool("TodoWrite"), "plan");
  assert.equal(ENABLED_TOOLS.includes("TodoWrite"), true);
});

test("the task tools are the checklist too, and build the same plan shape", () => {
  // A natív SDK-build a TodoWrite nevet nem ismeri: a checklist TaskCreate /
  // TaskUpdate párokból áll össze, és a hídnak kell vezetnie a listát. Ez a
  // teszt azt rögzíti, hogy mindkét forma ugyanoda érkezik.
  for (const tool of ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]) {
    assert.equal(classifyTool(tool), "plan", `${tool} a checklist része`);
  }
  for (const tool of ["TaskCreate", "TaskUpdate"]) {
    assert.equal(ENABLED_TOOLS.includes(tool), true, `${tool} nincs felkínálva a modellnek`);
  }

  const tasks = new Map([
    ["use-1", { subject: "Terv átnézése", activeForm: "Tervet nézek", status: "completed" }],
    ["use-2", { subject: "", activeForm: "Teszteket futtatok", status: "in_progress" }],
    ["use-3", { subject: "Verdikt", activeForm: "", status: "pending" }],
    ["use-4", { subject: "Elvetett pont", activeForm: "", status: "deleted" }],
  ]);
  assert.deepEqual(planFromTasks(tasks), [
    { id: "task-0", step: "Terv átnézése", status: "completed" },
    { id: "task-1", step: "Teszteket futtatok", status: "in_progress" },
    { id: "task-2", step: "Verdikt", status: "pending" },
  ]);
  // Törölt elem nem marad a listán, névtelen elem nem kerül rá.
  assert.deepEqual(planFromTasks(new Map()), []);
  assert.deepEqual(
    planFromTasks(new Map([["use-1", { subject: "", activeForm: "", status: "pending" }]])),
    [],
  );
});

test("task plan ids stay stable when a task disappears", () => {
  const tasks = new Map([
    ["use-1", { planId: "claude-task:use-1", subject: "First", status: "completed" }],
    ["use-2", { planId: "claude-task:use-2", subject: "Second", status: "pending" }],
  ]);
  assert.deepEqual(planFromTasks(tasks).map((step) => step.id), [
    "claude-task:use-1",
    "claude-task:use-2",
  ]);
  tasks.delete("use-1");
  assert.deepEqual(planFromTasks(tasks), [
    { id: "claude-task:use-2", step: "Second", status: "pending" },
  ]);
});

test("numeric TaskUpdate ids resolve to TaskCreate order without phantom tasks", () => {
  const tasks = new Map([
    ["use-1", { planId: "claude-task:use-1", subject: "First", status: "pending" }],
    ["use-2", { planId: "claude-task:use-2", subject: "Second", status: "pending" }],
  ]);
  const taskKeyById = new Map();

  assert.equal(taskKeyForUpdate(tasks, taskKeyById, "1"), "use-1");
  assert.equal(taskKeyForUpdate(tasks, taskKeyById, "2"), "use-2");
  assert.equal(taskKeyById.get("1"), "use-1");
  assert.equal(taskKeyForUpdate(tasks, taskKeyById, "unknown"), null);
  assert.deepEqual(planFromTasks(tasks).map((step) => step.id), [
    "claude-task:use-1",
    "claude-task:use-2",
  ]);
});

test("a malformed or empty checklist produces no plan update", () => {
  // An empty plan must not blank out a list the panel already shows.
  assert.deepEqual(planFromTodos({ todos: [] }), []);
  assert.deepEqual(planFromTodos({}), []);
  assert.deepEqual(planFromTodos(null), []);
  assert.deepEqual(planFromTodos({ todos: [{ status: "pending" }] }), []);
  // A todo with only an activeForm still names a step worth showing.
  assert.deepEqual(planFromTodos({ todos: [{ activeForm: "Reading", status: "in_progress" }] }), [
    { id: "todo-0", step: "Reading", status: "in_progress" },
  ]);
});

test("project instructions are collected outermost-first", () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "min-instr-"));
  const project = nodePath.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(nodePath.join(root, "AGENTS.md"), "Shared rule: answer in Hungarian.");
  fs.writeFileSync(nodePath.join(project, "AGENTS.md"), "Project rule: run the tests.");
  fs.writeFileSync(nodePath.join(project, "CLAUDE.md"), "Claude rule: keep diffs small.");

  const { text, files } = collectProjectInstructions(project);

  // The shared file must come first so the project's own file wins a conflict.
  assert.equal(files.length, 3);
  assert.ok(files[0].endsWith(nodePath.join(nodePath.basename(root), "AGENTS.md")));
  assert.ok(text.indexOf("Shared rule") < text.indexOf("Project rule"));
  assert.match(text, /Projektutasítások/);
  assert.match(text, /alkönyvtárban további AGENTS\.md/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a project with no instruction files appends nothing", () => {
  const empty = fs.mkdtempSync(nodePath.join(os.tmpdir(), "min-instr-empty-"));
  const result = collectProjectInstructions(empty);

  assert.deepEqual(result, { text: "", files: [] });
  fs.rmSync(empty, { recursive: true, force: true });
});

test("connection failures retain provider-specific error classes", () => {
  assert.equal(classifyConnectionError("ANTHROPIC_API_KEY is missing"), "missing_api_key");
  assert.equal(classifyConnectionError("Invalid API key"), "unauthorized");
  assert.equal(classifyConnectionError("HTTP 402 payment required"), "billing");
  assert.equal(classifyConnectionError("HTTP 429 rate limit"), "rate_limited");
  assert.equal(classifyConnectionError("max budget exceeded"), "budget_exceeded");
  assert.equal(classifyConnectionError("max_turns reached"), "turn_limit");
  // Az SDK szó szerinti hibaszövege — connection_failed-ként jelent meg,
  // és a felhasználó a Claude kapcsolatára gyanakodott a saját limitünk miatt.
  assert.equal(
    classifyConnectionError(
      "Claude Code returned an error result: Reached maximum number of turns (40)",
    ),
    "turn_limit",
  );
  assert.equal(classifyConnectionError("SessionStore timed out"), "timeout");
  assert.equal(classifyConnectionError("request cancelled"), "cancelled");
  assert.equal(classifyConnectionError("Claude bridge closed its stdout"), "bridge_crashed");
  assert.equal(classifyConnectionError("HTTP 503 service unavailable"), "server_error");
});

test("a missing remote Claude session retries once without resume", () => {
  assert.equal(
    isMissingRemoteSessionError("No conversation found with session ID old-session"),
    true,
  );
  assert.equal(
    shouldStartFreshSession("old-session", "No conversation found with session ID old-session"),
    true,
  );
  assert.equal(shouldStartFreshSession(null, "No conversation found with session ID"), false);
  assert.equal(shouldStartFreshSession("old-session", "Invalid API key"), false);
});

test("a planning stage cannot be handed a tool that edits files", () => {
  const tools = toolsForProfile("read_only");
  assert.ok(!tools.includes("Edit"));
  assert.ok(!tools.includes("Write"));
  assert.ok(
    !tools.includes("Bash"),
    "a planning stage reads and thinks; running commands is not part of it",
  );
  assert.ok(tools.includes("Read") && tools.includes("Grep"));
});

test("a reviewer may run the tests but still cannot edit files", () => {
  const tools = toolsForProfile("reviewer");
  assert.ok(
    tools.includes("Bash"),
    "without Bash a review can only speculate about the tests",
  );
  assert.ok(!tools.includes("Edit"));
  assert.ok(!tools.includes("Write"));
});

test("an unknown or missing profile keeps the full set instead of failing a turn", () => {
  assert.deepEqual(toolsForProfile(undefined), ENABLED_TOOLS);
  assert.deepEqual(toolsForProfile("nonsense"), ENABLED_TOOLS);
  assert.deepEqual(toolsForProfile("full"), ENABLED_TOOLS);
});
