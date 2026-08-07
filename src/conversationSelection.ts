/**
 * Which conversation a project should open. Split out of App.tsx so the rule
 * can be tested: a background sync poll used to move the reader off a freshly
 * created conversation, which also threw away the composer settings typed into
 * it.
 *
 * The parameters are structural on purpose — the app's own Project and
 * SyncConversation types satisfy them without this module importing them.
 */
export type SelectableProject = {
  path: string;
  threads: string[];
};

export type SelectableConversation = {
  messages?: unknown[] | null;
  workItems?: unknown[] | null;
  updatedAt?: string | null;
};

export const isUntitledConversation = (title: string) =>
  /^Új beszélgetés(?: \d+)?$/i.test(title.trim());

export const conversationHasContent = (
  conversation?: SelectableConversation | null,
) =>
  Boolean(
    conversation &&
      ((conversation.messages?.length ?? 0) > 0 ||
        (conversation.workItems?.length ?? 0) > 0),
  );

export type PreferredThreadOptions = {
  /**
   * True when `preferredTitle` is the conversation the reader is sitting on
   * right now, rather than a mere landing suggestion. A data refresh must never
   * relocate a live selection: skipping an empty placeholder is only correct
   * when choosing *where to land*, never when the reader already chose.
   */
  keepLiveSelection?: boolean;
};

export const preferredThreadForProject = (
  project: SelectableProject,
  cache: Record<string, SelectableConversation>,
  preferredTitle: string,
  options: PreferredThreadOptions = {},
) => {
  const preferred = project.threads.includes(preferredTitle)
    ? preferredTitle
    : "";
  const preferredConversation = preferred
    ? cache[`${project.path}/${preferred}`]
    : undefined;
  if (
    preferred &&
    (options.keepLiveSelection ||
      !isUntitledConversation(preferred) ||
      conversationHasContent(preferredConversation))
  ) {
    return preferred;
  }

  const populatedThreads = project.threads
    .map((title) => ({
      title,
      conversation: cache[`${project.path}/${title}`],
    }))
    .filter(({ conversation }) => conversationHasContent(conversation))
    .sort((left, right) =>
      (left.conversation?.updatedAt ?? "").localeCompare(
        right.conversation?.updatedAt ?? "",
      ),
    );
  return (
    populatedThreads[populatedThreads.length - 1]?.title ||
    preferred ||
    project.threads[0] ||
    ""
  );
};
