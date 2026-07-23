import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationTitleFromPrompt,
  generalConversationCacheKey,
  isGeneralConversationCacheKey,
  normalizeConversationScope,
} from "../src/conversationScope.ts";

test("General conversations use an id-only cache key", () => {
  const first = generalConversationCacheKey("conversation-a");
  const second = generalConversationCacheKey("conversation-b");

  assert.equal(first, "general::conversation-a");
  assert.notEqual(first, second);
  assert.equal(isGeneralConversationCacheKey(first), true);
  assert.equal(isGeneralConversationCacheKey("project::Tell me a joke"), false);
});

test("legacy records without a scope remain Coding when they have a project", () => {
  assert.equal(normalizeConversationScope(undefined, "project-1"), "coding");
  assert.equal(normalizeConversationScope(undefined, null), "general");
  assert.equal(normalizeConversationScope("general", "project-1"), "general");
});

test("General titles come from the first meaningful prompt line", () => {
  assert.equal(
    conversationTitleFromPrompt("\n  # Tell me a joke\nwith more context"),
    "Tell me a joke",
  );
  assert.equal(conversationTitleFromPrompt("\n\n"), "Új beszélgetés");
  assert.match(conversationTitleFromPrompt("x ".repeat(80)), /…$/);
});
