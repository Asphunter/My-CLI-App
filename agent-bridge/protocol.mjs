import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1;
// A session_store_response egyetlen JSONL-sor, és egy Claude-session betöltése
// az összes entry-t hozza — a store-ban ma is van 4,5 MB-os session. A korábbi
// 256 KB-os plafon ezeket a sorokat némán eldobta: a függő store-művelet 60
// másodpercig várt, timeoutolt, a session pedig újként indult újra. A limit
// célja csak egy elszabadult stream megfogása egy lokális pipe-on; arra a
// 64 MB is bőven elég.
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export function makeEnvelope({
  type,
  requestId,
  conversationId = null,
  sessionId = null,
  sequence = 0,
  payload = {},
  messageId = randomUUID(),
}) {
  if (typeof type !== "string" || type.length === 0) {
    throw new TypeError("Bridge message type is required");
  }
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw new TypeError("Bridge requestId is required");
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId,
    requestId,
    conversationId,
    sessionId,
    sequence,
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
}

export function parseLine(line) {
  if (typeof line !== "string") {
    throw new TypeError("Bridge input must be text");
  }
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    throw new RangeError(`Bridge message exceeds ${MAX_LINE_BYTES} bytes`);
  }
  const message = JSON.parse(line);
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new TypeError("Bridge message must be a JSON object");
  }
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("Unsupported bridge protocol version");
  }
  if (typeof message.type !== "string" || message.type.length === 0) {
    throw new TypeError("Bridge message type is required");
  }
  if (typeof message.requestId !== "string" || message.requestId.length === 0) {
    throw new TypeError("Bridge requestId is required");
  }
  return message;
}

export function normalizeSdkMessage(message) {
  if (!message || typeof message !== "object") {
    return { eventType: "unknown" };
  }
  if (message.type === "system") {
    return {
      eventType: "system",
      subtype: typeof message.subtype === "string" ? message.subtype : null,
      sessionId: typeof message.session_id === "string" ? message.session_id : null,
    };
  }
  if (message.type === "result") {
    return {
      eventType: "result",
      subtype: typeof message.subtype === "string" ? message.subtype : null,
      success: message.subtype === "success",
      totalCostUsd:
        typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
      sessionId: typeof message.session_id === "string" ? message.session_id : null,
    };
  }
  return {
    eventType: typeof message.type === "string" ? message.type : "unknown",
    subtype: typeof message.subtype === "string" ? message.subtype : null,
  };
}

export function redactForDiagnostic(value) {
  if (Array.isArray(value)) return value.map(redactForDiagnostic);
  if (!value || typeof value !== "object") return value;
  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    if (/key|token|secret|password|authorization|env/i.test(key)) {
      redacted[key] = "[redacted]";
    } else if (/prompt|content|text/i.test(key) && typeof item === "string") {
      redacted[key] = `[${item.length} chars]`;
    } else {
      redacted[key] = redactForDiagnostic(item);
    }
  }
  return redacted;
}
