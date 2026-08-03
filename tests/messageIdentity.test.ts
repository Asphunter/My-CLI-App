import assert from "node:assert/strict";
import test from "node:test";

import {
  appendInterruptedAnswerMarker,
  beginAssistantRegeneration,
  bothAssistantVersionsAreSettled,
  collapseRepeatedAssistantText,
  collapseAbandonedRegenerationRetries,
  coalesceMessageIdentities,
  hasInterruptedAnswerMarker,
  messageIdentityKeys,
  isNewerSettledAssistantVersion,
  isSettledHistoricalAssistant,
  mergeInterruptedAssistantVersions,
  messagesShareIdentity,
  type MessageIdentityLike,
} from "../src/messageIdentity.ts";

type TestMessage = MessageIdentityLike & {
  live?: boolean;
  final?: boolean;
};

const mergeVersions = (existing: TestMessage, incoming: TestMessage) => {
  const final = Boolean(existing.final || incoming.final);
  const preferIncoming = isNewerSettledAssistantVersion(existing, incoming);
  return {
    ...existing,
    id: preferIncoming ? incoming.id ?? existing.id : existing.id ?? incoming.id,
    text: preferIncoming
      ? incoming.text
      : bothAssistantVersionsAreSettled(existing, incoming)
        ? existing.text
        : incoming.text.trim().length > existing.text.trim().length
          ? incoming.text
          : existing.text,
    live: final ? false : Boolean(existing.live || incoming.live),
    final,
    itemId: preferIncoming
      ? incoming.itemId ?? existing.itemId
      : existing.itemId ?? incoming.itemId,
    sequence: preferIncoming
      ? incoming.sequence ?? existing.sequence
      : existing.sequence ?? incoming.sequence,
    turnId: existing.turnId ?? incoming.turnId,
  };
};

test("a megszakítás megőrzi a részválaszt és pontosan egy jelölést tesz utána", () => {
  const once = appendInterruptedAnswerMarker("Már elkészült rész.");
  const twice = appendInterruptedAnswerMarker(once);
  assert.equal(once, "Már elkészült rész.\n\nA válasz megszakítva.");
  assert.equal(twice, once);
  assert.equal(hasInterruptedAnswerMarker(twice), true);
});

test("üres részválaszból is tartós megszakítási jelölés készül", () => {
  assert.equal(appendInterruptedAnswerMarker(""), "A válasz megszakítva.");
});

test("a cache részválasza és az adatbázis stop jelölése együtt marad", () => {
  const partial = {
    role: "assistant" as const,
    text: "Tesztelés alatt: lefuttatom a projekt tesztjeit.",
    turnId: "request:cancelled",
    sequence: 42,
    live: false,
    final: true,
  };
  const stopped = {
    ...partial,
    text: "A válasz megszakítva.",
  };

  assert.deepEqual(mergeInterruptedAssistantVersions(partial, stopped), {
    text: `${partial.text}\n\nA válasz megszakítva.`,
    interrupted: true,
  });
  assert.deepEqual(mergeInterruptedAssistantVersions(stopped, partial), {
    text: `${partial.text}\n\nA válasz megszakítva.`,
    interrupted: true,
  });
});

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

test("a steer uses inputId identity and cannot merge into its parent prompt", () => {
  const root: TestMessage = {
    id: "root",
    role: "user",
    text: "Build it",
    turnId: "request:root",
  };
  const steer: TestMessage = {
    id: "steer-a",
    role: "user",
    text: "No CSS",
    turnId: "request:root",
    interaction: { kind: "steer", inputId: "input-1" },
  };
  const duplicate = { ...steer, id: "steer-b" };
  const result = coalesceMessageIdentities(
    [root, steer, duplicate],
    mergeVersions,
  );

  assert.equal(result.length, 2);
  assert.equal(result[0].text, "Build it");
  assert.equal(result[1].text, "No CSS");
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

test("a newer settled answer replaces a longer stale same-turn alias", () => {
  const result = coalesceMessageIdentities<TestMessage>(
    [
      {
        id: "stale-alias",
        role: "assistant",
        text: "PPHASE1012_RESPONSE_INSPECT_OKHASE1012_RESPONSE_INSPECT_OK",
        sequence: 10,
        turnId: "request:canonical",
        final: true,
      },
      {
        id: "canonical-answer",
        role: "assistant",
        text: "PHASE1012_FINAL_GUI_ACCEPTANCE_OK",
        sequence: 20,
        turnId: "request:canonical",
        final: true,
      },
    ],
    mergeVersions,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "canonical-answer");
  assert.equal(result[0].sequence, 20);
  assert.equal(result[0].text, "PHASE1012_FINAL_GUI_ACCEPTANCE_OK");
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

test("answers from different turns stay separate even with a shared item id", () => {
  // The bridge labels the first content block of every answer `assistant-0`,
  // so a conversation-wide item identity merged all answers into one and the
  // earlier replies disappeared while the questions stayed.
  const first = messageIdentityKeys({
    role: "assistant",
    id: "answer-1",
    turnId: "request:turn-1",
    itemId: "assistant-0",
  });
  const second = messageIdentityKeys({
    role: "assistant",
    id: "answer-2",
    turnId: "request:turn-2",
    itemId: "assistant-0",
  });

  assert.equal(
    first.some((key) => second.includes(key)),
    false,
    "two answers from different turns must not share an identity key",
  );

  // Within one turn the item id still collapses the streaming placeholder onto
  // the final answer, which is what the cleanup was for.
  const streaming = messageIdentityKeys({
    role: "assistant",
    id: "live-row",
    turnId: "request:turn-1",
    itemId: "assistant-0",
  });
  assert.equal(
    streaming.some((key) => first.includes(key)),
    true,
    "the same turn must still coalesce onto one answer",
  );
});

test("a glued cached answer must not beat the authoritative one", () => {
  const authoritative: TestMessage = {
    id: "answer-1",
    role: "assistant",
    text: "Elkeszult a superhet.svg.",
    turnId: "request:svg-turn",
    itemId: "assistant-0",
    sequence: 101,
    live: false,
    final: true,
  };
  // What the old merge left behind in a device's cache: this answer with a
  // second, unrelated answer appended. It is longer, so the length heuristic
  // used to hand it the win on every single reload.
  const glued: TestMessage = {
    ...authoritative,
    text: "Elkeszult a superhet.svg.Yes. Two files: AGENTS.md es AGENTS.md",
  };

  assert.equal(bothAssistantVersionsAreSettled(authoritative, glued), true);
  assert.equal(
    isNewerSettledAssistantVersion(authoritative, glued),
    false,
    "the glued copy has no newer sequence, so it must not be preferred",
  );

  // The synced copy is the primary source, the cached one comes second.
  const result = coalesceMessageIdentities<TestMessage>(
    [authoritative, glued],
    mergeVersions,
  );
  assert.equal(result.length, 1);
  assert.equal(
    result[0].text,
    "Elkeszult a superhet.svg.",
    "the authoritative answer must survive a longer, glued cache entry",
  );
});

test("an unfinished answer may still grow to the longer version", () => {
  const streaming: TestMessage = {
    id: "answer-2",
    role: "assistant",
    text: "Elkesz",
    turnId: "request:svg-turn",
    sequence: 101,
    live: true,
    final: false,
  };
  const complete: TestMessage = {
    ...streaming,
    text: "Elkeszult a superhet.svg.",
    live: false,
    final: true,
  };

  assert.equal(
    bothAssistantVersionsAreSettled(streaming, complete),
    false,
    "a live row is not settled, so the length heuristic must still apply",
  );
});

test("completed regeneration revisions collapse to the newest answer", () => {
  const result = collapseAbandonedRegenerationRetries<TestMessage>([
    {
      id: "user-1",
      role: "user",
      text: "Teszt",
      sequence: 10,
      turnId: "request:original",
    },
    {
      id: "answer-1",
      role: "assistant",
      text: "Első válasz",
      sequence: 11,
      turnId: "request:original",
      final: true,
    },
    {
      id: "answer-2",
      role: "assistant",
      text: "Második válasz",
      sequence: 12,
      turnId: "request:retry-1",
      final: true,
    },
    {
      id: "answer-3",
      role: "assistant",
      text: "Legújabb válasz",
      sequence: 13,
      turnId: "request:retry-2",
      final: true,
    },
  ]);

  assert.deepEqual(result.map((message) => message.id), ["user-1", "answer-3"]);
});

test("same-turn assistant blocks are not mistaken for regeneration", () => {
  const result = collapseAbandonedRegenerationRetries<TestMessage>([
    { id: "user-1", role: "user", text: "Teszt", turnId: "request:one" },
    {
      id: "answer-a",
      role: "assistant",
      text: "Első blokk",
      turnId: "request:one",
      final: true,
    },
    {
      id: "answer-b",
      role: "assistant",
      text: "Második blokk",
      turnId: "request:one",
      final: true,
    },
  ]);

  assert.deepEqual(result.map((message) => message.id), [
    "user-1",
    "answer-a",
    "answer-b",
  ]);
});
