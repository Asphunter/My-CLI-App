import assert from "node:assert/strict";
import test from "node:test";

import {
  agentAnswerMessageId,
  stableId,
  uuidV5,
} from "../src/deterministicId.ts";

const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

test("uuidV5 matches the RFC vector", () => {
  assert.equal(
    uuidV5(NAMESPACE_DNS, "python.org"),
    "886313e1-3b8a-5372-9b90-0c9aee199e5d",
  );
});

test("the answer id matches what the Rust runtime writes", () => {
  // Referencia: uuid.uuid5(uuid.NAMESPACE_OID, "min:local:agent-answer:…"),
  // ugyanaz a képlet, mint a store `stable_id`-je.
  assert.equal(
    agentAnswerMessageId("conversation-a", "request-1"),
    "354f1b11-1dd4-5e37-b8b0-aed33db83cc6",
  );
  assert.equal(
    agentAnswerMessageId(
      "8f4e1c22-0b6d-4a3e-9d51-2f7c9a0b1e33",
      "8b2a2f0e-1c44-4f9a-a2d6-6a1b7c3d4e5f",
    ),
    "4b2731d4-8b1f-5df3-9de1-06b401b499be",
  );
});

test("multi-byte characters hash as UTF-8, the way Rust sees the string", () => {
  assert.equal(
    stableId("agent-answer", "árvíztűrő:tükörfúrógép"),
    "37a4f4b9-0309-52be-ba16-5ff5353dc538",
  );
});

test("the id is a v5 UUID and depends on both halves of the pair", () => {
  const id = agentAnswerMessageId("conversation-a", "request-1");
  assert.equal(id[14], "5");
  assert.ok("89ab".includes(id[19]));
  assert.notEqual(id, agentAnswerMessageId("conversation-a", "request-2"));
  assert.notEqual(id, agentAnswerMessageId("conversation-b", "request-1"));
});
