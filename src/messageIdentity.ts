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
  const turnId = nonEmpty(message.turnId);
  const itemId = nonEmpty(message.itemId);
  const id = nonEmpty(message.id);

  if (turnId) keys.push(`turn:${turnId}:${message.role}`);
  if (itemId) keys.push(`item:${itemId}:${message.role}`);
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
  return output;
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
