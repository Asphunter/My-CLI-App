export type MessageIdentityLike = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  time?: string;
  itemId?: string;
  turnId?: string;
  sequence?: number;
  live?: boolean;
  final?: boolean;
  interrupted?: boolean;
  interaction?: { kind?: string; inputId?: string };
};

export const INTERRUPTED_ANSWER_LABEL = "A válasz megszakítva.";

const interruptedAnswerMarkerPattern =
  /(?:\r?\n\s*){0,2}A válasz megszakítva\.?\s*$/i;

export const hasInterruptedAnswerMarker = (text: string) =>
  interruptedAnswerMarkerPattern.test(text.trimEnd());

/** Keeps every emitted character and adds exactly one durable stop marker. */
export const appendInterruptedAnswerMarker = (text: string) => {
  const partial = text.replace(interruptedAnswerMarkerPattern, "").trimEnd();
  return partial
    ? `${partial}\n\n${INTERRUPTED_ANSWER_LABEL}`
    : INTERRUPTED_ANSWER_LABEL;
};

const exactRepeatedUnit = (text: string) => {
  const characters = Array.from(text);
  if (characters.length < 6) return undefined;

  // KMP prefix table gives the smallest exact period in linear time. The old
  // divisor scan was capped at 64 repetitions, while a real corrupted Work 2
  // row had already grown to 166 copies and therefore escaped every reload.
  const prefix = new Array<number>(characters.length).fill(0);
  for (let index = 1, matched = 0; index < characters.length; index += 1) {
    while (matched > 0 && characters[index] !== characters[matched])
      matched = prefix[matched - 1];
    if (characters[index] === characters[matched]) matched += 1;
    prefix[index] = matched;
  }

  const periodLength = characters.length - prefix[characters.length - 1];
  if (
    periodLength < 3 ||
    periodLength >= characters.length ||
    characters.length % periodLength !== 0 ||
    characters.length / periodLength < 2
  )
    return undefined;
  return characters.slice(0, periodLength).join("");
};

/**
 * Repairs the historical stream-listener corruption where one completed
 * assistant answer was appended once per duplicate listener. Do not touch
 * user text: repeating a user prompt is valid history.
 */
export const collapseRepeatedAssistantText = (role: string, text: string) => {
  if (role !== "assistant" || Array.from(text).length < 6) return text;
  const exact = exactRepeatedUnit(text);
  if (exact !== undefined) return exact;

  // Interrupted legacy streams sometimes inserted the terminal marker into
  // only some copies. Remove it solely for period detection, then preserve one
  // marker. Two exact answer copies are enough: the original two-listener bug
  // persisted many rows as answer+answer, including short exact-output tests.
  const withoutInterruptionMarkers = text.replace(
    /(?:\r?\n){2}A válasz megszakítva\.?/gi,
    "",
  );
  if (withoutInterruptionMarkers !== text) {
    const repaired = exactRepeatedUnit(withoutInterruptionMarkers);
    if (repaired !== undefined)
      return `${repaired.trimEnd()}\n\nA válasz megszakítva.`;
  }
  return text;
};

/**
 * Old persisted rows can contain a complete answer with `final: false` after
 * an interrupted shutdown. Once no stream is live and the following row is a
 * new user turn, content is stronger evidence than that stale lifecycle bit.
 */
export const isSettledHistoricalAssistant = (
  message: MessageIdentityLike,
  nextRole: MessageIdentityLike["role"] | undefined,
  hasImages = false,
) =>
  message.role === "assistant" &&
  (Boolean(message.final) ||
    (!message.live &&
      (Boolean(message.text.trim()) || hasImages) &&
      (nextRole === undefined || nextRole === "user")));

/**
 * A previous client could persist a second, longer assistant alias under the
 * same turn id. When the canonical answer arrives later, its timeline
 * sequence is authoritative even if its text is shorter than the corrupted
 * alias. This keeps restart/sync hydration from moving the real answer back
 * into the old alias position.
 */
export const isNewerSettledAssistantVersion = (
  existing: MessageIdentityLike,
  incoming: MessageIdentityLike,
) => {
  if (
    existing.role !== "assistant" ||
    incoming.role !== "assistant" ||
    !incoming.final ||
    incoming.live ||
    !incoming.text.trim() ||
    !existing.final ||
    existing.live ||
    !existing.text.trim()
  )
    return false;
  if (existing.text === incoming.text) return false;
  if (
    typeof existing.sequence !== "number" ||
    !Number.isFinite(existing.sequence) ||
    typeof incoming.sequence !== "number" ||
    !Number.isFinite(incoming.sequence)
  )
    return false;
  return incoming.sequence > existing.sequence;
};

/**
 * Reconciles the durable stop marker with a cached partial copy of the same
 * answer. A cancelled turn is commonly persisted twice during shutdown: the
 * database has the marker while the browser cache still has the last emitted
 * sentence. Neither copy is complete on its own, so the merge must retain
 * both pieces. A genuinely newer settled answer still wins.
 */
export const mergeInterruptedAssistantVersions = (
  existing: MessageIdentityLike,
  incoming: MessageIdentityLike,
) => {
  if (existing.role !== "assistant" || incoming.role !== "assistant")
    return undefined;

  const existingInterrupted = Boolean(
    existing.interrupted || hasInterruptedAnswerMarker(existing.text),
  );
  const incomingInterrupted = Boolean(
    incoming.interrupted || hasInterruptedAnswerMarker(incoming.text),
  );
  if (!existingInterrupted && !incomingInterrupted) return undefined;

  if (
    !incomingInterrupted &&
    isNewerSettledAssistantVersion(existing, incoming)
  )
    return { text: incoming.text, interrupted: false };
  if (
    !existingInterrupted &&
    isNewerSettledAssistantVersion(incoming, existing)
  )
    return { text: existing.text, interrupted: false };

  const partial = [existing.text, incoming.text]
    .map((text) => text.replace(interruptedAnswerMarkerPattern, "").trimEnd())
    .sort((left, right) => right.length - left.length)[0];
  return {
    text: appendInterruptedAnswerMarker(partial),
    interrupted: true,
  };
};

/**
 * Two settled versions of the same answer. The "longer text wins" heuristic
 * must not decide here: a corrupted copy that glued two answers together is
 * always longer, so it outlived every reload and the correct, shorter text
 * could never win back. Only the authoritative side may decide, and the
 * heuristic stays for genuinely incomplete rows (a live or truncated stream).
 */
export const bothAssistantVersionsAreSettled = (
  existing: MessageIdentityLike,
  incoming: MessageIdentityLike,
) =>
  existing.role === "assistant" &&
  incoming.role === "assistant" &&
  Boolean(existing.final) &&
  !existing.live &&
  Boolean(existing.text.trim()) &&
  Boolean(incoming.final) &&
  !incoming.live;

const nonEmpty = (value: string | undefined) => value?.trim() || undefined;

/** Ordered aliases for one logical chat row.
 *
 * A timeline sequence is a position, not an identity: two offline devices can
 * legitimately allocate the same value. Strong ids therefore win. Sequence
 * is only a legacy fallback, and includes the exact immutable payload so it
 * can never blend two different user inputs.
 */
export const messageIdentityKeys = (message: MessageIdentityLike) => {
  const keys: string[] = [];
  const interactionInputId = nonEmpty(message.interaction?.inputId);
  const turnId = nonEmpty(message.turnId);
  const itemId = nonEmpty(message.itemId);
  const id = nonEmpty(message.id);

  if (interactionInputId)
    keys.push(`interaction:${interactionInputId}:${message.role}`);
  else if (turnId) keys.push(`turn:${turnId}:${message.role}`);
  // An item id only identifies a message inside its own turn. Providers label
  // content blocks positionally, so every first answer block is `assistant-0`;
  // treating that as a global identity merged every answer in a conversation
  // into one and the earlier ones were lost.
  if (itemId && !interactionInputId)
    keys.push(
      turnId
        ? `turn:${turnId}:item:${itemId}:${message.role}`
        : `item:${itemId}:${message.role}`,
    );
  if (id) keys.push(`id:${id}`);
  if (
    message.role === "assistant" &&
    !turnId &&
    !itemId &&
    typeof message.sequence === "number" &&
    Number.isFinite(message.sequence)
  )
    keys.push(
      `legacy-assistant-payload:${Math.trunc(message.sequence)}:${message.text}`,
    );
  if (
    !turnId &&
    !itemId &&
    !id &&
    typeof message.sequence === "number" &&
    Number.isFinite(message.sequence)
  )
    keys.push(
      `legacy-sequence-payload:${message.role}:${Math.trunc(message.sequence)}:${message.text}`,
    );
  return keys;
};

export const messagesShareIdentity = (
  left: MessageIdentityLike | undefined,
  right: MessageIdentityLike | undefined,
) => {
  if (!left || !right) return false;
  if (left === right) return true;
  const rightKeys = new Set(messageIdentityKeys(right));
  return messageIdentityKeys(left).some((key) => rightKeys.has(key));
};

export const beginAssistantRegeneration = <
  Message extends MessageIdentityLike,
>(
  messages: Message[],
  source: Message,
  answer: Message,
  fallbackTurnId: string,
) => {
  const sourceIndex = messages.findIndex(
    (message) =>
      message.role === "user" && messagesShareIdentity(message, source),
  );
  const answerIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" && messagesShareIdentity(message, answer),
  );
  if (sourceIndex < 0 || answerIndex <= sourceIndex) return undefined;

  const storedSource = messages[sourceIndex];
  const storedAnswer = messages[answerIndex];
  const turnId =
    storedSource.turnId ?? storedAnswer.turnId ?? fallbackTurnId;
  const liveAnswer = {
    ...storedAnswer,
    text: "",
    time: "most",
    live: true,
    final: false,
    turnId,
  };
  return {
    source: storedSource,
    originalAnswer: storedAnswer,
    liveAnswer,
    sourceIndex,
    answerIndex,
    turnId,
    messages: messages.map((message, index) =>
      index === answerIndex ? liveAnswer : message,
    ),
  };
};

/**
 * Old regeneration appended the same user prompt plus an empty assistant row.
 * Suppress only an empty retry for a payload that has another answered turn;
 * completed repeated prompts remain separate because they can be intentional.
 */
export const collapseAbandonedRegenerationRetries = <
  Message extends MessageIdentityLike & {
    images?: unknown[];
    quoteRefs?: unknown[];
    pipeline?: unknown;
    interaction?: unknown;
  },
>(messages: Message[]) => {
  const output: Message[] = [];
  const samePayload = (left: Message, right: Message) =>
    left.text === right.text &&
    JSON.stringify(left.images ?? []) === JSON.stringify(right.images ?? []);
  const answeredPayloads = messages
    .map((message, index) => ({ message, answer: messages[index + 1] }))
    .filter(
      ({ message, answer }) =>
        message.role === "user" &&
        answer?.role === "assistant" &&
        Boolean(answer.text.trim()),
    )
    .map(({ message }) => message);

  for (let index = 0; index < messages.length; index += 1) {
    const retryUser = messages[index];
    const retryAnswer = messages[index + 1];
    const abandonedRetry =
      retryUser?.role === "user" &&
      retryAnswer?.role === "assistant" &&
      !retryAnswer.text.trim() &&
      !retryAnswer.live &&
      !retryAnswer.final &&
      Boolean(retryUser.turnId) &&
      retryUser.turnId === retryAnswer.turnId &&
      answeredPayloads.some(
        (answeredUser) =>
          answeredUser !== retryUser && samePayload(answeredUser, retryUser),
      );
    if (abandonedRetry) {
      index += 1;
      continue;
    }
    output.push(messages[index]);
  }
  // A regeneration is one answer revision, not a new chat turn. Older builds
  // persisted every retry under a fresh request turn while keeping the single
  // original user row, so reload produced a stack of assistant-only bubbles.
  // Consecutive settled, non-pipeline assistant rows with different turn ids
  // are precisely that shape. Same-turn content blocks remain untouched.
  const collapsed: Message[] = [];
  let revisionStart: number | null = null;
  let revisionTurnId: string | undefined;
  for (const message of output) {
    if (message.role === "user") {
      collapsed.push(message);
      revisionStart = null;
      revisionTurnId = undefined;
      continue;
    }
    const settledStandalone =
      Boolean(message.text.trim()) &&
      Boolean(message.final) &&
      !message.live &&
      !message.pipeline &&
      !message.interaction &&
      Boolean(message.turnId);
    if (!settledStandalone) {
      collapsed.push(message);
      revisionStart = null;
      revisionTurnId = undefined;
      continue;
    }
    if (
      revisionStart !== null &&
      revisionTurnId &&
      message.turnId &&
      message.turnId !== revisionTurnId
    ) {
      collapsed.splice(revisionStart);
      collapsed.push(message);
      revisionTurnId = message.turnId;
      continue;
    }
    if (revisionStart === null) {
      revisionStart = collapsed.length;
      revisionTurnId = message.turnId;
    }
    collapsed.push(message);
  }
  return collapsed;
};

/** Coalesce aliases while preserving the first row's timeline position. */
export const coalesceMessageIdentities = <Message extends MessageIdentityLike>(
  messages: Message[],
  mergeVersions: (existing: Message, incoming: Message) => Message,
) => {
  const merged: Message[] = [];
  const indexes = new Map<string, number>();

  for (const message of messages) {
    const keys = messageIdentityKeys(message);
    const existingIndex = keys
      .map((key) => indexes.get(key))
      .find((index): index is number => index !== undefined);
    if (existingIndex === undefined) {
      const index = merged.length;
      merged.push(message);
      for (const key of keys) indexes.set(key, index);
      continue;
    }

    const next = mergeVersions(merged[existingIndex], message);
    merged[existingIndex] = next;
    for (const key of [
      ...messageIdentityKeys(merged[existingIndex]),
      ...keys,
    ])
      indexes.set(key, existingIndex);
  }

  return merged;
};
