import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_RUN_INPUT_STATE,
  followUpsForConversation,
  resolveRunInputTarget,
  runInputReducer,
  type QueuedFollowUp,
  type RunInputPayload,
  type RunInputRunLike,
} from "../src/runInput.ts";

const payload = (inputId = "input-1"): RunInputPayload => ({
  inputId,
  mode: "steer",
  text: "A styles.css-hez ne nyúlj.",
  modelPrompt: "A styles.css-hez ne nyúlj.",
  quoteRefs: [],
  images: [],
  createdAt: "2026-08-01T10:00:00.000Z",
});

const run = (overrides: Partial<RunInputRunLike> = {}): RunInputRunLike => ({
  requestId: "root-1",
  ownerConversationId: "conversation-a",
  provider: "codex",
  threadId: "thread-1",
  providerTurnId: "turn-1",
  stageEpoch: 1,
  status: "streaming",
  turnCompleted: false,
  ...overrides,
});

test("a target is resolved from the owning conversation, not the visible run", () => {
  const target = resolveRunInputTarget(
    "conversation-b",
    [run(), run({ requestId: "root-2", ownerConversationId: "conversation-b" })],
  );
  assert.equal(target?.rootRequestId, "root-2");
  assert.equal(target?.conversationId, "conversation-b");
});

test("the active pipeline stage supplies its own request and epoch", () => {
  const target = resolveRunInputTarget("conversation-a", [run()], {
    runId: "pipeline-1",
    requestId: "root-1-stage-2",
    stageIndex: 2,
    role: "code",
    stageEpoch: 3,
    phase: "started",
  });
  assert.deepEqual(target, {
    conversationId: "conversation-a",
    rootRequestId: "root-1",
    providerRequestId: "root-1-stage-2",
    provider: "codex",
    providerThreadId: "thread-1",
    providerTurnId: "turn-1",
    pipelineRunId: "pipeline-1",
    stageIndex: 2,
    stageRole: "code",
    stageEpoch: 3,
  });
});

test("finalizing or turn-completed runs cannot be steered", () => {
  assert.equal(
    resolveRunInputTarget("conversation-a", [run({ status: "finalizing" })]),
    null,
  );
  assert.equal(
    resolveRunInputTarget("conversation-a", [run({ turnCompleted: true })]),
    null,
  );
  assert.equal(
    resolveRunInputTarget("conversation-a", [run({ providerTurnId: undefined })]),
    null,
  );
});

test("delivery transitions are correlated by stable input id", () => {
  const sending = runInputReducer(EMPTY_RUN_INPUT_STATE, {
    type: "send_started",
    payload: payload(),
    sentAt: "2026-08-01T10:00:01.000Z",
  });
  const accepted = runInputReducer(sending, {
    type: "accepted",
    inputId: "input-1",
    acceptedAt: "2026-08-01T10:00:02.000Z",
    target: resolveRunInputTarget("conversation-a", [run()])!,
  });
  assert.equal(accepted.inputs["input-1"].delivery.status, "accepted");

  const lateFailure = runInputReducer(accepted, {
    type: "failed",
    inputId: "input-1",
    code: "transport_closed",
    message: "closed",
    failedAt: "2026-08-01T10:00:03.000Z",
  });
  assert.equal(lateFailure, accepted, "an accepted input cannot regress to failed");
});

const followUp = (
  id: string,
  conversationId: string,
  position: number,
): QueuedFollowUp => ({
  id,
  conversationId,
  position,
  body: id,
  modelPrompt: id,
  quoteRefs: [],
  attachments: [],
  requestSettings: {
    mode: "coding",
    provider: "codex",
    detailed: false,
    pipelineEnabled: false,
  },
  createdAt: `2026-08-01T10:00:0${position}.000Z`,
  updatedAt: `2026-08-01T10:00:0${position}.000Z`,
});

test("follow-up queues stay per conversation and preserve FIFO ordering", () => {
  const hydrated = runInputReducer(EMPTY_RUN_INPUT_STATE, {
    type: "hydrate_follow_ups",
    followUps: [
      followUp("a-2", "conversation-a", 9),
      followUp("b-1", "conversation-b", 0),
      followUp("a-1", "conversation-a", 2),
    ],
  });
  assert.deepEqual(
    followUpsForConversation(hydrated, "conversation-a").map((item) => item.id),
    ["a-1", "a-2"],
  );

  const moved = runInputReducer(hydrated, {
    type: "move_follow_up",
    id: "a-2",
    direction: -1,
  });
  assert.deepEqual(
    followUpsForConversation(moved, "conversation-a").map((item) => item.id),
    ["a-2", "a-1"],
  );
  assert.deepEqual(
    followUpsForConversation(moved, "conversation-b").map((item) => item.id),
    ["b-1"],
  );
});
