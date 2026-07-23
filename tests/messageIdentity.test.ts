import assert from "node:assert/strict";
import test from "node:test";

import {
  beginAssistantRegeneration,
  collapseRepeatedAssistantText,
  collapseAbandonedRegenerationRetries,
  coalesceMessageIdentities,
  isSettledHistoricalAssistant,
  messagesShareIdentity,
  type MessageIdentityLike,
} from "../src/messageIdentity.ts";

type TestMessage = MessageIdentityLike & {
  live?: boolean;
  final?: boolean;
};

const mergeVersions = (existing: TestMessage, incoming: TestMessage) => {
  const final = Boolean(existing.final || incoming.final);
  return {
    ...existing,
    text:
      incoming.text.trim().length > existing.text.trim().length
        ? incoming.text
        : existing.text,
    live: final ? false : Boolean(existing.live || incoming.live),
    final,
    itemId: existing.itemId ?? incoming.itemId,
    turnId: existing.turnId ?? incoming.turnId,
  };
};

test("legacy cache and OneDrive copies without strong ids render once", () => {
  const result = coalesceMessageIdentities<TestMessage>(
    [
      {
        role: "assistant",
        text: "Kesz.",
        sequence: 42,
        final: true,
      },
      {
        role: "assistant",
        text: "Kesz.",
        sequence: 42,
        final: true,
      },
    ],
    mergeVersions,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].text, "Kesz.");
});

test("different strong ids at the same sequence never blend user payloads", () => {
  const result = coalesceMessageIdentities<TestMessage>(
    [
      { id: "user-a", role: "user", text: "Elso kerdes", sequence: 42 },
      { id: "user-b", role: "user", text: "Masodik kerdes", sequence: 42 },
    ],
    mergeVersions,
  );

  assert.deepEqual(
    result.map((message) => message.text),
    ["Elso kerdes", "Masodik kerdes"],
  );
});

test("legacy assistant aliases with exact sequence and payload render once", () => {
  const result = coalesceMessageIdentities<TestMessage>(
    [
      { id: "answer-a", role: "assistant", text: "Kész.", sequence: 42 },
      { id: "answer-b", role: "assistant", text: "Kész.", sequence: 42 },
    ],
    mergeVersions,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "answer-a");
});

test("a completed copy monotonically replaces the live placeholder", () => {
  const result = coalesceMessageIdentities<TestMessage>(
    [
      {
        id: "live-id",
        role: "assistant",
        text: "",
        sequence: 8,
        turnId: "request-1",
        live: true,
      },
      {
        id: "pulled-id",
        role: "assistant",
        text: "Vegleges valasz",
        sequence: 999,
        turnId: "request-1",
        final: true,
      },
    ],
    mergeVersions,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].text, "Vegleges valasz");
  assert.equal(result[0].live, false);
  assert.equal(result[0].final, true);
});

test("identical answers from distinct turns remain distinct", () => {
  const result = coalesceMessageIdentities<TestMessage>(
    [
      {
        id: "answer-1",
        role: "assistant",
        text: "Mukodik.",
        sequence: 10,
        turnId: "request-1",
      },
      {
        id: "answer-2",
        role: "assistant",
        text: "Mukodik.",
        sequence: 20,
        turnId: "request-2",
      },
    ],
    mergeVersions,
  );

  assert.equal(result.length, 2);
});

test("identical user content from distinct turns remains complete", () => {
  const context = "A projekt kontextusa: " + "x".repeat(600);
  const result = coalesceMessageIdentities<TestMessage>(
    [
      { id: "u1", role: "user", text: context, sequence: 1, turnId: "turn-1" },
      { id: "u2", role: "user", text: context, sequence: 3, turnId: "turn-2" },
      { id: "u3", role: "user", text: context, sequence: 5, turnId: "turn-3" },
    ],
    mergeVersions,
  );

  assert.deepEqual(result.map((message) => message.id), ["u1", "u2", "u3"]);
});

test("regeneration replaces the answer in place without duplicating the user", () => {
  const user: TestMessage = {
    id: "user-1",
    role: "user",
    text: "Ismeteld meg",
    sequence: 10,
    turnId: "turn-1",
  };
  const answer: TestMessage = {
    id: "answer-1",
    role: "assistant",
    text: "Regi valasz",
    sequence: 11,
    turnId: "turn-1",
    final: true,
  };
  const result = beginAssistantRegeneration(
    [user, answer],
    user,
    answer,
    "fallback-turn",
  );
  assert.ok(result);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(result.liveAnswer.id, "answer-1");
  assert.equal(result.liveAnswer.sequence, 11);
  assert.equal(result.liveAnswer.text, "");
  assert.equal(result.liveAnswer.live, true);
  assert.equal(result.liveAnswer.final, false);
});

test("only an abandoned legacy regeneration retry is collapsed", () => {
  const source: TestMessage = {
    id: "legacy-user",
    role: "user",
    text: "Ugyanaz",
    sequence: 1,
  };
  const answer: TestMessage = {
    id: "legacy-answer",
    role: "assistant",
    text: "Meglevo valasz",
    sequence: 2,
    final: true,
  };
  const retryUser: TestMessage = {
    id: "retry-user",
    role: "user",
    text: "Ugyanaz",
    sequence: 3,
    turnId: "request:retry",
  };
  const retryAnswer: TestMessage = {
    id: "retry-answer",
    role: "assistant",
    text: "",
    sequence: 4,
    turnId: "request:retry",
    live: false,
    final: false,
  };
  assert.deepEqual(
    collapseAbandonedRegenerationRetries([
      source,
      answer,
      retryUser,
      retryAnswer,
    ]).map((message) => message.id),
    ["legacy-user", "legacy-answer"],
  );
  assert.equal(
    collapseAbandonedRegenerationRetries([
      source,
      answer,
      retryUser,
      { ...retryAnswer, text: "Uj valasz", final: true },
    ]).length,
    4,
  );
});

test("historical repeated assistant stream output is collapsed within one row", () => {
  const answer = "Ertettem:\n\nNincs tovabbi feladat.";
  assert.equal(collapseRepeatedAssistantText("assistant", answer.repeat(2)), answer);
  assert.equal(collapseRepeatedAssistantText("assistant", answer.repeat(17)), answer);
  assert.equal(collapseRepeatedAssistantText("assistant", answer.repeat(166)), answer);
  assert.equal(collapseRepeatedAssistantText("user", answer.repeat(17)), answer.repeat(17));
  assert.equal(collapseRepeatedAssistantText("assistant", "K-1K-1"), "K-1");
  assert.equal(collapseRepeatedAssistantText("assistant", "abcabcabc"), "abc");
  assert.equal(collapseRepeatedAssistantText("assistant", "abcabca"), "abcabca");
});

test("historical repeated interruption markers collapse to one preserved marker", () => {
  const answer = "Igen, most mar futtathato.";
  const marker = "\n\nA válasz megszakítva.";
  const corrupted = `${answer}${marker}${answer.repeat(164)}${answer}${marker}`;
  assert.equal(
    collapseRepeatedAssistantText("assistant", corrupted),
    `${answer}${marker}`,
  );
});

test("a non-live historical answer survives a stale false final bit", () => {
  assert.equal(
    isSettledHistoricalAssistant(
      { role: "assistant", text: "Megmaradt válasz", live: false, final: false },
      "user",
    ),
    true,
  );
  assert.equal(
    isSettledHistoricalAssistant(
      { role: "assistant", text: "Készül", live: true, final: false },
      "user",
    ),
    false,
  );
  assert.equal(
    isSettledHistoricalAssistant(
      { role: "assistant", text: "", live: false, final: false },
      "user",
    ),
    false,
  );
});

test("trace suppression applies only to the exact logical answer", () => {
  const earlier = {
    id: "earlier",
    role: "assistant" as const,
    text: "Korábbi válasz",
    sequence: 10,
    turnId: "turn-earlier",
  };
  const selected = {
    id: "selected",
    role: "assistant" as const,
    text: "Későbbi válasz",
    sequence: 20,
    turnId: "turn-selected",
  };
  assert.equal(messagesShareIdentity(earlier, selected), false);
  assert.equal(
    messagesShareIdentity(selected, { ...selected, id: "cache-copy" }),
    true,
  );
});
