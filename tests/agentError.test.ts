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

test("a busy workspace is its own diagnosis, not a failed connection", () => {
  const description = describeThrownAgentError(
    "A projekt munkaterületén még egy előző futás lezárása dolgozik. Próbáld újra.",
    "Claude",
  );

  assert.equal(description.code, "workspace_busy");
  assert.equal(
    description.userMessage,
    "A projekt munkaterületén még egy előző futás lezárása dolgozik.",
  );
});

test("an unrecognized failure shows the native reason instead of hiding it", () => {
  // A generikus címke ("a kérés nem sikerült") eddig elnyelte az egyetlen
  // kapaszkodót, és a hiba a felhasználó szemszögéből ok nélkül állt elő.
  const description = describeThrownAgentError(
    "Az agent snapshot fájlja nem olvasható: os error 2",
    "Claude",
  );

  assert.equal(description.code, "connection_failed");
  assert.equal(
    description.userMessage.includes("Az agent snapshot fájlja nem olvasható"),
    true,
  );
});
