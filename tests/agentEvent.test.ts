import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptTerminalAgentEvent,
  agentEventIdentity,
  normalizeAgentEventEnvelope,
} from "../src/agentEvent.ts";

test("the provider-neutral channel maps to the existing Coding timeline shape", () => {
  const event = normalizeAgentEventEnvelope({
    protocolVersion: 1,
    messageId: "message-1",
    requestId: "request-1",
    sessionId: "session-1",
    sequence: 7,
    eventType: "assistant/text_delta",
    payload: { delta: "OK", itemId: "assistant-0", turnId: "turn-1" },
  });

  assert.equal(event?.eventType, "item/agentMessage/delta");
  assert.equal(event?.threadId, "session-1");
  assert.equal((event?.payload as { phase?: string }).phase, "final_answer");
  assert.equal(agentEventIdentity(event!), "request-1:7");
});

test("neutral and legacy copies share one sequence identity", () => {
  const neutral = normalizeAgentEventEnvelope({
    messageId: "neutral-message",
    requestId: "request-1",
    sequence: 12,
    eventType: "assistant/text_delta",
    payload: { delta: "OK" },
  });
  const legacy = {
    requestId: "request-1",
    sequence: 12,
    threadId: "session-1",
    eventType: "item/agentMessage/delta",
  };

  assert.equal(agentEventIdentity(neutral!), agentEventIdentity(legacy));
});

test("provider-neutral reasoning is normalized onto the compact trace lane", () => {
  const event = normalizeAgentEventEnvelope({
    requestId: "request-1",
    sessionId: "session-1",
    eventType: "assistant/reasoning_delta",
    payload: { delta: "Rövid összefoglaló" },
  });

  assert.equal((event?.payload as { phase?: string }).phase, "commentary");
  assert.equal(
    (event?.payload as { channel?: string }).channel,
    "reasoning-summary",
  );
});

test("agent-event and codex-event terminal copies are exact-once", () => {
  const seen = new Set<string>();
  const terminal = {
    requestId: "request-1",
    threadId: "turn-1",
    terminalEventId: "request-1:turn-1:completed",
    eventType: "turn/completed",
  };

  assert.equal(acceptTerminalAgentEvent(seen, terminal), true);
  assert.equal(acceptTerminalAgentEvent(seen, terminal), false);
  assert.equal(seen.size, 1);
});

test("legacy codex-event payloads are left to the compatibility normalizer", () => {
  assert.equal(
    normalizeAgentEventEnvelope({
      eventType: "item/agentMessage/delta",
      payload: { delta: "legacy" },
    }),
    null,
  );
});
