import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationIdForKey,
  conversationKeyIndex,
  conversationKeysMatch,
  forgetConversation,
  readConversation,
  writeConversation,
  writeTarget,
} from "../src/conversationState.ts";

test("an ownerless write goes nowhere", () => {
  assert.equal(writeTarget(null, "conversation-a"), "drop");
  assert.equal(writeTarget(undefined, "conversation-a"), "drop");
  assert.equal(writeTarget("   ", "conversation-a"), "drop");
  // This was the leak: a run whose owner had been cleared kept writing, and
  // "no owner" meant "every view" instead of "no view".
  assert.equal(writeTarget(null, null), "drop");
});

test("a run writes to its own conversation even while another one is on screen", () => {
  assert.equal(writeTarget("conversation-a", "conversation-a"), "store-and-view");
  assert.equal(writeTarget("conversation-a", "conversation-b"), "store-only");
  assert.equal(writeTarget("conversation-a", null), "store-only");
});

test("the store is addressed by id, never by what is on screen", () => {
  const empty: Record<string, { messages: string[] }> = {};
  const withA = writeConversation(empty, "conversation-a", (current) => ({
    messages: [...(current?.messages ?? []), "első"],
  }));
  const withB = writeConversation(withA, "conversation-b", (current) => ({
    messages: [...(current?.messages ?? []), "másik"],
  }));

  assert.deepEqual(readConversation(withB, "conversation-a")?.messages, ["első"]);
  assert.deepEqual(readConversation(withB, "conversation-b")?.messages, ["másik"]);
  assert.equal(readConversation(withB, "conversation-c"), undefined);
});

test("an ownerless write leaves the store untouched, reference and all", () => {
  const store = { "conversation-a": { messages: ["első"] } };
  assert.equal(
    writeConversation(store, "", () => ({ messages: ["szemét"] })),
    store,
  );
  assert.equal(
    writeConversation(store, null, () => ({ messages: ["szemét"] })),
    store,
  );
  assert.equal(readConversation(store, null), undefined);
});

test("forgetting a conversation removes only that one", () => {
  const store = { a: { messages: [] }, b: { messages: [] } };
  assert.deepEqual(Object.keys(forgetConversation(store, "a")), ["b"]);
  assert.equal(forgetConversation(store, "missing"), store);
  assert.equal(forgetConversation(store, null), store);
});

test("the two Windows spellings of a path name the same conversation", () => {
  assert.equal(
    conversationKeysMatch(
      "\\\\?\\C:\\Users\\me\\projects\\app/GUI tests",
      "C:\\Users\\me\\projects\\app/GUI tests",
    ),
    true,
  );
  assert.equal(
    conversationKeysMatch(
      "C:\\Users\\me\\projects\\app/GUI tests",
      "C:\\Users\\me\\projects\\app/GUI test 2",
    ),
    false,
  );
});

test("key lookup falls back to a spelling-tolerant match instead of dropping the write", () => {
  const index = conversationKeyIndex({
    "\\\\?\\C:\\Users\\me\\projects\\app/GUI tests": { id: "conversation-a" },
    "C:\\Users\\me\\projects\\app/GUI test 2": { id: "conversation-b" },
    "C:\\Users\\me\\projects\\app/Névtelen": { id: null },
  });

  assert.equal(
    conversationIdForKey(index, "C:\\Users\\me\\projects\\app/GUI tests"),
    "conversation-a",
  );
  assert.equal(
    conversationIdForKey(index, "C:\\Users\\me\\projects\\app/GUI test 2"),
    "conversation-b",
  );
  assert.equal(
    conversationIdForKey(index, "C:\\Users\\me\\projects\\app/Névtelen"),
    null,
  );
});
