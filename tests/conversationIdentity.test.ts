import assert from "node:assert/strict";
import test from "node:test";

import { ensureCanonicalConversationId } from "../src/conversationIdentity.ts";

test("existing conversation ids are preserved exactly after normalization", () => {
  assert.equal(
    ensureCanonicalConversationId(" conversation-1 ", () => "generated"),
    "conversation-1",
  );
});

test("a new Coding thread gets a canonical id before its first agent turn", () => {
  assert.equal(
    ensureCanonicalConversationId(undefined, () => "conversation-generated"),
    "conversation-generated",
  );
  assert.equal(
    ensureCanonicalConversationId("   ", () => "conversation-generated"),
    "conversation-generated",
  );
});
