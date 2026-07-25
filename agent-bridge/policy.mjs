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
 * The checklist tool. Claude writes and re-writes its task list through it, so
 * every call is a plan update for the LÉPÉSEK panel. It touches nothing else.
 */
export const PLAN_TOOLS = new Set(["TodoWrite"]);

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
  "AskUserQuestion",
];

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
