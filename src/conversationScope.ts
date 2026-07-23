export type ConversationScope = "coding" | "general";
export type AppMode = ConversationScope;

export const DEFAULT_APP_MODE: AppMode = "general";
export const GENERAL_CACHE_PREFIX = "general::";
// SQLite keeps a foreign-key-safe internal container for GENERAL records.
// The UI and sync wire format always expose this as projectId: null.
export const GENERAL_PROJECT_ID = "system-general-scope-v1";

export const normalizeConversationScope = (
  value: unknown,
  projectId?: string | null,
): ConversationScope => {
  if (value === "general") return "general";
  if (value === "coding") return "coding";
  return projectId ? "coding" : "general";
};

export const isGeneralScope = (
  scope: unknown,
  projectId?: string | null,
) => normalizeConversationScope(scope, projectId) === "general";

export const generalConversationCacheKey = (conversationId: string) =>
  `${GENERAL_CACHE_PREFIX}${conversationId}`;

export const isGeneralConversationCacheKey = (key: string) =>
  key.startsWith(GENERAL_CACHE_PREFIX);

export const conversationTitleFromPrompt = (prompt: string) => {
  const firstLine =
    prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const normalized = firstLine
    .replace(/^[#>*\-\d.)\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Új beszélgetés";
  if (normalized.length <= 42) return normalized;
  const shortened = normalized
    .slice(0, 42)
    .replace(/\s+\S*$/, "")
    .trim();
  return `${shortened || normalized.slice(0, 42).trim()}…`;
};
