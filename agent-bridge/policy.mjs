//! Tool classification for the Claude bridge permission gate.
//!
//! Keeping the classification here (rather than inline in the gate) makes the
//! policy testable without spawning a turn, and makes it obvious at a glance
//! which tools reach the workspace and which cannot.

/** Tools that touch the workspace; every path they name is containment-checked. */
export const WORKSPACE_TOOLS = new Set(["Read", "Glob", "Grep", "Edit", "Write"]);

/**
 * Read-only network tools. They cannot see or modify the workspace, so they are
 * auto-allowed like the read tools — the risk they carry is that fetched
 * content enters the context, not that they change anything on disk.
 */
export const NETWORK_TOOLS = new Set(["WebSearch", "WebFetch"]);

/**
 * Subagent delegation. The subagent's own tool calls come back through this
 * same gate, so allowing the spawn does not widen what can be done — it only
 * lets the work be split up.
 */
export const DELEGATION_TOOLS = new Set(["Agent", "Task"]);

/**
 * The checklist tools. Claude writes and re-writes its task list through them,
 * so every call is a plan update for the LÉPÉSEK panel. They touch nothing else.
 *
 * `TodoWrite` is the older single-call form: one call carries the whole list.
 * The native build ships `TaskCreate`/`TaskUpdate` instead, where the list is
 * built up call by call — and a name the build does not know is dropped from
 * `tools` without a word, which is why every Claude stage reported having no
 * checklist tool and the LÉPÉSEK list only moved from the filename fallback.
 * Both forms are accepted; the bridge maps them onto the same plan shape.
 */
export const PLAN_TOOLS = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

/** The full set handed to the SDK. */
export const ENABLED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "Bash",
  "WebSearch",
  "WebFetch",
  "Agent",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "AskUserQuestion",
];

/** Tools that can change the workspace. */
const WRITE_TOOLS = new Set(["Edit", "Write"]);

/**
 * Role profiles for a pipeline stage.
 *
 * A planning or reviewing stage must not edit files, and a prompt asking it not
 * to is a hope, not a guarantee. Withholding the tools is the guarantee -- the
 * SDK cannot call what it was never given, and a subagent inherits the same
 * gate, so delegation cannot widen it either.
 *
 * `reviewer` keeps Bash so the review can run the tests instead of speculating
 * about them, which is the difference between evidence and an opinion. It is
 * also why the reviewer profile is not simply "read-only".
 */
export const STAGE_TOOL_PROFILES = {
  full: ENABLED_TOOLS,
  read_only: ENABLED_TOOLS.filter(
    (tool) => !WRITE_TOOLS.has(tool) && tool !== "Bash",
  ),
  reviewer: ENABLED_TOOLS.filter((tool) => !WRITE_TOOLS.has(tool)),
};

/** Falls back to the full set for an unknown profile rather than failing a turn. */
export function toolsForProfile(profile) {
  if (typeof profile !== "string") return ENABLED_TOOLS;
  return STAGE_TOOL_PROFILES[profile] ?? ENABLED_TOOLS;
}

/**
 * Converts a TodoWrite payload into the plan shape the GUI already renders.
 * Claude's statuses (`pending` / `in_progress` / `completed`) are passed through
 * unchanged — the frontend normalizes them.
 */
export function planFromTodos(input) {
  const todos = Array.isArray(input?.todos) ? input.todos : [];
  return todos
    .map((todo, index) => {
      const step =
        typeof todo?.content === "string" && todo.content.trim()
          ? todo.content.trim()
          : typeof todo?.activeForm === "string"
            ? todo.activeForm.trim()
            : "";
      if (!step) return null;
      return { id: `todo-${index}`, step, status: todo?.status ?? "pending" };
    })
    .filter(Boolean);
}

/**
 * A híd által vezetett task-lista → a panel lépéslistája.
 *
 * A `TaskCreate`/`TaskUpdate` páros egy hívásban egy elemet érint, tehát a
 * listát a hídnak kell összeraknia: a sorrend a létrehozás sorrendje, a
 * törölt elem pedig kiesik. A kimenet ugyanaz az alak, amit a `TodoWrite`
 * teljes listája ad, így a felület felé nincs különbség.
 */
export function planFromTasks(tasks) {
  return [...tasks.values()]
    .filter((task) => task && !task.hidden && task.status !== "deleted")
    .map((task, index) => {
      const step = (task.subject || task.activeForm || "").trim();
      if (!step) return null;
      // The Map index is not an identity: deleting a task would otherwise
      // renumber every later row and make its timing/trace jump to another
      // step. The bridge assigns planId from the tool-use key once, before
      // the SDK result supplies the model-facing task id.
      return {
        id: task.planId ?? `task-${index}`,
        step,
        status: task.status ?? "pending",
      };
    })
    .filter(Boolean);
}

const cleanPlanTitle = (value) => String(value ?? "")
  .trim()
  .replace(/^#{1,6}\s*/, "")
  .replace(/^\d+[.)]\s*/, "")
  .replaceAll("**", "")
  .split(/\s+[—–]\s+/, 1)[0]
  .trim();

const comparablePlanTitle = (value) => cleanPlanTitle(value)
  .toLocaleLowerCase("hu-HU")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim();

/** Model workflow scaffolding is never a user plan step. */
export function isChecklistMetaTask(value) {
  const normalized = comparablePlanTitle(value);
  if (!normalized) return false;
  const hadZeroPrefix = /^\s*0[.)]\s*/.test(String(value ?? ""));
  return hadZeroPrefix && (
    /\b(előkészítés|előkészítése|értelmezés|értelmezése|checklist|todo)\b/u.test(normalized)
    || /\b(kódolás|terv|feladat)\b/u.test(normalized)
  );
}

/**
 * Extracts the planner's numbered titles from a coding-stage prompt. Review
 * stages intentionally return no titles: their checklist has a different,
 * review-specific contract.
 */
export function expectedPlanTitlesFromPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.includes("[SZEREP]\nTe vagy a kódoló.")) return [];
  const marker = "A tervező terve:\n";
  const start = prompt.indexOf(marker);
  if (start < 0) return [];
  const remainder = prompt.slice(start + marker.length);
  const endCandidates = [
    remainder.indexOf("\nVáltozott fájlok:"),
    remainder.indexOf("\nA terv bírálata:"),
    remainder.indexOf("\nA kódoló összefoglalója:"),
    remainder.indexOf("\nA korábbi review:"),
    remainder.indexOf("\n[SZEREP]"),
  ].filter((index) => index >= 0);
  const section = remainder.slice(0, endCandidates.length ? Math.min(...endCandidates) : undefined);
  return section
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:#{1,6}\s*)?\d+[.)]\s+(.+)$/)?.[1] ?? "")
    .map(cleanPlanTitle)
    .filter(Boolean);
}

/** The exact planner title corresponding to a model-authored checklist row. */
export function expectedPlanTitleFor(subject, expectedTitles) {
  const candidate = comparablePlanTitle(subject);
  if (!candidate) return null;
  return expectedTitles.find((title) => {
    const expected = comparablePlanTitle(title);
    return candidate === expected || candidate.startsWith(`${expected} `) || expected.startsWith(`${candidate} `);
  }) ?? null;
}

/**
 * A full TodoWrite list is visible only through rows that correspond to the
 * accepted plan. Model-invented "0. preparation" phases must not replace it.
 */
export function alignChecklistToExpectedPlan(steps, expectedTitles) {
  if (!Array.isArray(expectedTitles) || expectedTitles.length === 0) return steps;
  return steps.flatMap((step) => {
    const expected = expectedPlanTitleFor(step?.step, expectedTitles);
    return expected ? [{ ...step, step: expected }] : [];
  });
}

/**
 * Applies a TaskUpdate without losing bridge-only metadata. In particular,
 * an invented preparation task remains hidden when the model changes it from
 * pending to in_progress/completed.
 */
export function updatedChecklistTask(existing, input, fallbackPlanId) {
  const text = (value) =>
    typeof value === "string" && value.trim() ? value.trim() : "";
  return {
    ...existing,
    planId: existing?.planId ?? fallbackPlanId,
    subject: text(input?.subject) || existing?.subject || "",
    activeForm: text(input?.activeForm) || existing?.activeForm || "",
    status: text(input?.status) || existing?.status || "pending",
  };
}

/**
 * Resolves the id used by TaskUpdate back to the stable TaskCreate key.
 *
 * The native Claude build currently returns a short ordinal ("1", "2", ...)
 * in TaskUpdate, while the preceding TaskCreate is keyed by its tool-use id.
 * Prefer the explicit result mapping when it exists, then fall back to the
 * one-based creation order. Returning null for an unknown id is important:
 * inventing a new task here creates a phantom checklist row and loses the
 * active-step link for every subsequent tool call.
 */
export function taskKeyForUpdate(tasks, taskKeyById, taskId) {
  if (typeof taskId !== "string" || !taskId.trim()) return null;
  const normalized = taskId.trim();
  const mapped = taskKeyById?.get(normalized);
  if (mapped) return mapped;

  if (/^\d+$/.test(normalized)) {
    const ordinal = Number(normalized);
    if (Number.isSafeInteger(ordinal) && ordinal > 0) {
      const keys = [...tasks.keys()];
      const key = keys[ordinal - 1];
      if (key) {
        taskKeyById?.set(normalized, key);
        return key;
      }
    }
  }

  return null;
}

/**
 * @returns {"workspace"|"network"|"delegation"|"plan"|"bash"|"question"|"unknown"}
 */
export function classifyTool(toolName) {
  if (WORKSPACE_TOOLS.has(toolName)) return "workspace";
  if (NETWORK_TOOLS.has(toolName)) return "network";
  if (DELEGATION_TOOLS.has(toolName)) return "delegation";
  if (PLAN_TOOLS.has(toolName)) return "plan";
  if (toolName === "Bash") return "bash";
  if (toolName === "AskUserQuestion") return "question";
  return "unknown";
}
