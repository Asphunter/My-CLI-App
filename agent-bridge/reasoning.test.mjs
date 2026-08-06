import assert from "node:assert/strict";
import test from "node:test";
import { reasoningOptionsForProvider } from "./reasoning.mjs";

test("DeepSeek V4 Flash high uses the responsive 4k thinking budget", () => {
  assert.deepEqual(reasoningOptionsForProvider("deepseek", "high"), {
    effort: "high",
    thinking: { type: "enabled", budgetTokens: 4_096 },
  });
  assert.deepEqual(reasoningOptionsForProvider("deepseek", "max"), {
    effort: "max",
    thinking: { type: "enabled", budgetTokens: 32_768 },
  });
  assert.deepEqual(reasoningOptionsForProvider("deepseek", "none"), {
    thinking: { type: "disabled" },
  });
});

test("other provider reasoning behavior is unchanged", () => {
  assert.equal(
    reasoningOptionsForProvider("kimi", "high").thinking.budgetTokens,
    16_384,
  );
  assert.deepEqual(reasoningOptionsForProvider("anthropic", "medium"), {
    effort: "medium",
    thinking: { type: "adaptive" },
  });
});
