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

test("an accepted steer stays in its parent work group and never starts a new user bucket", () => {
  const messages = [
    {
      id: "root-user",
      role: "user" as const,
      text: "Build it",
      sequence: 10,
      turnId: "request:root",
    },
    {
      id: "steer-1",
      role: "user" as const,
      text: "Do not touch CSS",
      sequence: 12,
      turnId: "request:root",
      interaction: {
        kind: "steer" as const,
        inputId: "input-1",
        parentTurnId: "request:root",
      },
    },
    {
      id: "answer",
      role: "assistant" as const,
      text: "Done",
      sequence: 20,
      turnId: "request:root",
      final: true,
    },
  ];
  const groups = buildWorkLogGroups({
    messages,
    activities: [{ id: 11, turnId: "request:root" }],
    planHistory: {},
    commentary: [],
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].userMessageKey, "root-user");
  assert.equal(messageBelongsToWorkGroup(messages, 1, groups[0]), true);
});

test("a pipeline steer targets only the stage named by its interaction metadata", () => {
  const messages = [
    { id: "u", role: "user" as const, text: "Build", sequence: 1 },
    {
      id: "plan-answer",
      role: "assistant" as const,
      text: "Plan",
      sequence: 5,
      turnId: "request:run-stage-0",
      pipeline: { runId: "run", stageIndex: 0 },
    },
    {
      id: "steer",
      role: "user" as const,
      text: "Use rows",
      sequence: 7,
      interaction: {
        kind: "steer" as const,
        inputId: "input",
        parentTurnId: "request:root",
        pipelineRunId: "run",
        stageIndex: 1,
      },
    },
    {
      id: "other-code-answer",
      role: "assistant" as const,
      text: "Other run code",
      sequence: 8,
      turnId: "request:other-run-stage-1",
      pipeline: { runId: "other-run", stageIndex: 1 },
    },
    {
      id: "code-answer",
      role: "assistant" as const,
      text: "Code",
      sequence: 10,
      turnId: "request:run-stage-1",
      pipeline: { runId: "run", stageIndex: 1 },
    },
  ];
  const groups = buildWorkLogGroups({
    messages,
    activities: [],
    planHistory: {},
    commentary: [],
  });
  const plan = groups.find((group) => group.key.includes("::run:run#0"))!;
  const code = groups.find((group) => group.key.includes("::run:run#1"))!;
  const otherCode = groups.find((group) =>
    group.key.includes("::run:other-run#1"),
  )!;

  assert.equal(messageBelongsToWorkGroup(messages, 2, plan), false);
  assert.equal(messageBelongsToWorkGroup(messages, 2, code), true);
  assert.equal(messageBelongsToWorkGroup(messages, 2, otherCode), false);
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

test("a recovered trace card can never sort before its user prompt", () => {
  const messages = [
    { id: "u", role: "user" as const, text: "question", sequence: 100 },
    { id: "a", role: "assistant" as const, text: "answer", sequence: 101 },
  ];
  const groups = buildWorkLogGroups({
    messages,
    // Historical timing may be equal to or older than the prompt sequence.
    activities: [{ id: 100, turnId: "legacy-trace" }],
    planHistory: {
      "legacy-trace": completedPlan("legacy-trace", 100),
    },
    commentary: [],
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].userMessageKey, "u");
  assert.ok(groups[0].sequence > messages[0].sequence!);
  assert.ok(groups[0].sequence < messages[1].sequence!);
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

test("a reused provider session id cannot put the newest answer in an older panel", () => {
  const messages = [
    { id: "u1", role: "user" as const, text: "first", sequence: 10 },
    {
      id: "a1",
      role: "assistant" as const,
      text: "first answer",
      sequence: 12,
      turnId: "deepseek-session-1",
      final: true,
    },
    { id: "u2", role: "user" as const, text: "second", sequence: 20 },
    {
      id: "a2",
      role: "assistant" as const,
      text: "second answer",
      sequence: 22,
      turnId: "deepseek-session-1",
      final: true,
    },
  ];
  const groups = buildWorkLogGroups({
    messages,
    activities: [
      { id: 11, turnId: "deepseek-session-1" },
      { id: 21, turnId: "deepseek-session-1" },
    ],
    planHistory: {},
    commentary: [],
  });

  assert.equal(groups.length, 2);
  assert.equal(messageBelongsToWorkGroup(messages, 1, groups[0]), true);
  assert.equal(messageBelongsToWorkGroup(messages, 3, groups[0]), false);
  assert.equal(messageBelongsToWorkGroup(messages, 1, groups[1]), false);
  assert.equal(messageBelongsToWorkGroup(messages, 3, groups[1]), true);
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
