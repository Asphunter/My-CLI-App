import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkLogGroups,
  findActiveWorkGroup,
  mergePlanHistoryRecords,
  messageBelongsToWorkGroup,
  settleHistoricalPlan,
} from "../src/chatTimeline.ts";

const completedPlan = (turnId: string, startedAt: number) => ({
  turnId,
  explanation: "",
  startedAt,
  completedAt: startedAt + 5,
  steps: [{ id: "step", status: "completed" }],
});

test("a completed plan creates its own card without any work item", () => {
  const messages = [
    { id: "u1", role: "user" as const, text: "one", sequence: 100 },
    { id: "a1", role: "assistant" as const, text: "A", sequence: 101 },
    { id: "u2", role: "user" as const, text: "two", sequence: 200 },
    { id: "a2", role: "assistant" as const, text: "B", sequence: 201 },
  ];
  const groups = buildWorkLogGroups({
    messages,
    activities: [
      { id: 110, turnId: "turn-1", kind: "reasoning" },
    ],
    planHistory: {
      "turn-1": completedPlan("turn-1", 105),
      "turn-2": completedPlan("turn-2", 205),
    },
    commentary: [],
  });

  assert.equal(groups.length, 2);
  assert.equal(groups[0].userMessageKey, "u1");
  assert.equal(groups[1].userMessageKey, "u2");
  assert.equal(groups[1].activities.length, 0);
  assert.equal(messageBelongsToWorkGroup(messages, 1, groups[0]), true);
  assert.equal(messageBelongsToWorkGroup(messages, 3, groups[1]), true);
});

test("starting a new stream never reuses the previous historical card", () => {
  const messages = [
    { id: "u-old", role: "user" as const, text: "old", sequence: 10 },
    {
      id: "a-old",
      role: "assistant" as const,
      text: "old answer",
      sequence: 11,
      turnId: "request:old",
      final: true,
    },
    { id: "u-new", role: "user" as const, text: "new", sequence: 20 },
    {
      id: "a-new",
      role: "assistant" as const,
      text: "",
      sequence: 21,
      turnId: "request:new",
      live: true,
      final: false,
    },
  ];
  const groups = buildWorkLogGroups({
    messages,
    activities: [{ id: 12, turnId: "request:old" }],
    planHistory: {
      "request:old": completedPlan("request:old", 10),
      "request:new": {
        turnId: "request:new",
        startedAt: 20,
        steps: [{ id: "client-pre-plan", status: "inProgress" }],
      },
    },
    commentary: [],
    activeTurnKey: "request:new",
  });
  const active = findActiveWorkGroup(groups, messages, "request:new");

  assert.equal(groups.length, 2);
  assert.equal(active?.userMessageKey, "u-new");
  assert.notEqual(active?.key, groups[0].key);
  assert.equal(messageBelongsToWorkGroup(messages, 1, groups[0]), true);
});

test("a no-tool turn remains a card after streaming completes", () => {
  const messages = [
    { id: "u", role: "user" as const, text: "hello", sequence: 100 },
    {
      id: "a",
      role: "assistant" as const,
      text: "hello back",
      sequence: 101,
      turnId: "request:no-tools",
      live: false,
      final: true,
    },
  ];
  const groups = buildWorkLogGroups({
    messages,
    activities: [],
    planHistory: {
      "request:no-tools": completedPlan("request:no-tools", 100),
    },
    commentary: [],
  });

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].activities, []);
  assert.equal(messageBelongsToWorkGroup(messages, 1, groups[0]), true);
});

test("explicit mismatched turn ids are never paired by proximity", () => {
  const messages = [
    { id: "u", role: "user" as const, text: "hello", sequence: 1 },
    {
      id: "a",
      role: "assistant" as const,
      text: "answer",
      sequence: 2,
      turnId: "answer-turn",
    },
  ];
  const groups = buildWorkLogGroups({
    messages,
    activities: [{ id: 3, turnId: "trace-turn" }],
    planHistory: {},
    commentary: [],
  });
  const traceOnlyGroup = {
    ...groups[0],
    turnKeys: ["trace-turn"],
  };

  assert.equal(messageBelongsToWorkGroup(messages, 1, traceOnlyGroup), false);
});

test("a repeated fallback turn id cannot collapse two user sessions", () => {
  const messages = [
    { id: "u1", role: "user" as const, text: "one", sequence: 10 },
    { id: "a1", role: "assistant" as const, text: "A", sequence: 12 },
    { id: "u2", role: "user" as const, text: "two", sequence: 20 },
    { id: "a2", role: "assistant" as const, text: "B", sequence: 22 },
  ];
  const groups = buildWorkLogGroups({
    messages,
    activities: [
      { id: 11, turnId: "thread:fallback" },
      { id: 21, turnId: "thread:fallback" },
    ],
    planHistory: {},
    commentary: [],
  });

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.userMessageKey),
    ["u1", "u2"],
  );
});

test("sync merge cannot replace a settled plan with a stale live snapshot", () => {
  const settled = completedPlan("turn", 100);
  const stale = {
    turnId: "turn",
    startedAt: 100,
    steps: [{ id: "step", status: "inProgress" }],
  };
  const merged = mergePlanHistoryRecords(
    { turn: settled },
    { turn: stale },
  );

  assert.equal(merged.turn.completedAt, 105);
  assert.equal(merged.turn.steps[0].status, "completed");
});

test("JSON restart round-trip preserves deterministic turn ownership", () => {
  const snapshot = JSON.parse(
    JSON.stringify({
      messages: [
        { id: "u", role: "user", text: "q", sequence: 50 },
        {
          id: "a",
          role: "assistant",
          text: "a",
          sequence: 51,
          turnId: "request:persisted",
          final: true,
        },
      ],
      planHistory: {
        "request:persisted": completedPlan("request:persisted", 50),
      },
    }),
  );
  const groups = buildWorkLogGroups({
    messages: snapshot.messages,
    activities: [],
    planHistory: snapshot.planHistory,
    commentary: [],
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].userMessageKey, "u");
  assert.equal(
    messageBelongsToWorkGroup(snapshot.messages, 1, groups[0]),
    true,
  );
});

test("restart settles a persisted running step instead of keeping a spinner", () => {
  const plan = {
    turnId: "request:interrupted",
    startedAt: 100,
    steps: [
      { id: "done", status: "completed", step: "done" },
      { id: "running", status: "inProgress", step: "running" },
      { id: "later", status: "pending", step: "later" },
    ],
    stepTimes: {
      done: { startedAt: 100, completedAt: 105 },
      running: { startedAt: 106 },
    },
  };

  const settled = settleHistoricalPlan(plan);

  assert.equal(settled.completedAt, 106);
  assert.equal(settled.steps[1].status, "error");
  assert.equal(settled.steps[2].status, "pending");
  assert.equal(settled.stepTimes.running.completedAt, 106);
  assert.equal(plan.steps[1].status, "inProgress");
});
