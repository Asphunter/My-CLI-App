import assert from "node:assert/strict";
import test from "node:test";

import {
  describeAgentError,
  describeThrownAgentError,
} from "../src/agentError.ts";

test("agent errors become short Hungarian user messages with stable codes", () => {
  assert.deepEqual(
    describeAgentError("budget_exceeded", "max budget exceeded", "Claude"),
    {
      code: "budget_exceeded",
      detail: "max budget exceeded",
      userMessage: "A Claude-turn elérte a beállított költségkeretet.",
      notification: "Claude: A Claude-turn elérte a beállított költségkeretet.",
    },
  );
  assert.equal(
    describeAgentError("missing_api_key", "missing", "Claude").userMessage,
    "Claude API-kulcs nincs beállítva.",
  );
});

test("unknown error text is classified without exposing credentials", () => {
  const description = describeThrownAgentError(
    new Error("Claude [unauthorized]: sk-ant-secret-value"),
    "Claude",
  );

  assert.equal(description.code, "unauthorized");
  assert.equal(description.detail.includes("sk-ant-secret-value"), false);
  assert.equal(description.detail.includes("[redacted-api-key]"), true);
  assert.equal(
    description.userMessage,
    "Claude API-kulcsa hibás vagy vissza lett vonva.",
  );
});

test("timeout, cancellation and bridge crash have separate recovery labels", () => {
  assert.equal(describeThrownAgentError("SessionStore timed out").code, "timeout");
  assert.equal(describeThrownAgentError("A Claude-kérés megszakadt").code, "cancelled");
  assert.equal(describeThrownAgentError("A Claude bridge closed its stdout").code, "bridge_crashed");
});
