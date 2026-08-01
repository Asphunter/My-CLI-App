export type NormalizedAgentEvent = {
  requestId?: string | null;
  sequence?: number;
  messageId?: string | null;
  threadId: string;
  eventType: string;
  payload: unknown;
  providerTurnId?: string | null;
  terminalEventId?: string | null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const parseEventValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const firstString = (...values: unknown[]) =>
  values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );

const compatibilityEventType = (eventType: string) => {
  switch (eventType) {
    case "agent/turn_started":
      return "turn/started";
    case "agent/turn_completed":
      return "turn/completed";
    case "agent/turn_failed":
      return "turn/failed";
    case "agent/turn_cancelled":
      return "turn/cancelled";
    case "assistant/text_delta":
      return "item/agentMessage/delta";
    case "assistant/reasoning_delta":
      return "item/agentMessage/delta";
    case "tool/started":
      return "item/tool/started";
    case "tool/progress":
      return "item/tool/progress";
    case "tool/failed":
      return "item/tool/denied";
    default:
      return eventType;
  }
};

/**
 * Converts the provider-neutral event envelope into the compatibility shape
 * consumed by the existing Coding timeline. Returning null for legacy
 * codex-event payloads lets the same UI listener accept both channels.
 */
export const normalizeAgentEventEnvelope = (
  value: unknown,
): NormalizedAgentEvent | null => {
  const envelope = asRecord(parseEventValue(value));
  const rawEventType = firstString(
    envelope.eventType,
    envelope.event_type,
  );
  if (
    !rawEventType ||
    ![
      "agent/turn_started",
      "agent/turn_completed",
      "agent/turn_failed",
      "agent/turn_cancelled",
      "assistant/text_delta",
      "assistant/reasoning_delta",
      "tool/started",
      "tool/progress",
      "tool/failed",
      "approval/requested",
      "question/requested",
      "usage/updated",
    ].includes(rawEventType)
  )
    return null;

  const payload = Object.prototype.hasOwnProperty.call(envelope, "payload")
    ? envelope.payload
    : envelope;
  const payloadRecord = asRecord(payload);
  const eventType = compatibilityEventType(rawEventType);
  const nextPayload = { ...payloadRecord };
  if (
    (rawEventType === "assistant/text_delta" ||
      rawEventType === "assistant/reasoning_delta") &&
    typeof nextPayload.phase !== "string"
  ) {
    nextPayload.phase =
      rawEventType === "assistant/reasoning_delta"
        ? "commentary"
        : "final_answer";
  }
  if (
    rawEventType === "assistant/reasoning_delta" &&
    typeof nextPayload.channel !== "string"
  )
    nextPayload.channel = "reasoning-summary";
  if (
    rawEventType === "assistant/text_delta" &&
    nextPayload.phase === "commentary" &&
    typeof nextPayload.channel !== "string"
  )
    nextPayload.channel = "assistant-output";

  return {
    requestId:
      firstString(envelope.requestId, envelope.request_id) ?? null,
    sequence:
      typeof envelope.sequence === "number" && Number.isFinite(envelope.sequence)
        ? envelope.sequence
        : undefined,
    messageId: firstString(envelope.messageId, envelope.message_id) ?? null,
    threadId:
      firstString(
        envelope.threadId,
        envelope.thread_id,
        envelope.sessionId,
        envelope.session_id,
        envelope.requestId,
        envelope.request_id,
      ) ?? "",
    eventType,
    payload: nextPayload,
    providerTurnId:
      firstString(envelope.providerTurnId, envelope.provider_turn_id) ??
      firstString(
        payloadRecord.providerTurnId,
        payloadRecord.turnId,
        payloadRecord.turn_id,
      ) ??
      null,
    terminalEventId:
      firstString(envelope.terminalEventId, envelope.terminal_event_id) ?? null,
  };
};

/** A stable identity shared by the agent-event and codex-event channels. */
export const agentEventIdentity = (event: {
  requestId?: string | null;
  sequence?: number;
  messageId?: string | null;
  terminalEventId?: string | null;
  eventType: string;
  threadId?: string | null;
}) =>
  // The native bridge currently emits the same event on the provider-neutral
  // and legacy compatibility channels. Their message ids are not guaranteed
  // to be identical, while the per-request sequence is shared. Prefer that
  // sequence so a delta/terminal event is applied exactly once across both
  // listeners.
  (event.sequence !== undefined
    ? `${event.requestId ?? "unknown"}:${event.sequence}`
    : event.messageId?.trim() ||
      `${event.requestId ?? "unknown"}:${event.threadId ?? "unknown"}:${event.eventType}`);

/** Exact-once guard used for terminal agent events. */
export const acceptTerminalAgentEvent = (
  seen: Set<string>,
  event: {
    requestId?: string | null;
    threadId?: string | null;
    terminalEventId?: string | null;
    eventType: string;
  },
) => {
  const key =
    event.terminalEventId?.trim() ||
    `${event.requestId ?? "unknown"}:${event.threadId ?? "unknown"}:${event.eventType}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
};
