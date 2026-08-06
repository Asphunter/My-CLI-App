import assert from "node:assert/strict";
import test from "node:test";
import { TurnInputBroker } from "./turnInputBroker.mjs";

test("multiple priority-now inputs cross the broker in FIFO order", async () => {
  const accepted = [];
  const broker = new TurnInputBroker({
    onAccepted: (entry, attempt) => accepted.push([entry.inputId, attempt]),
  });
  broker.enqueue({ inputId: "00000000-0000-4000-8000-000000000001", text: "első" });
  broker.enqueue({ inputId: "00000000-0000-4000-8000-000000000002", text: "második" });

  const iterator = broker.beginAttempt("attempt-1")[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.message.content, "első");
  assert.equal(first.value.priority, "now");
  assert.deepEqual(first.value.origin, { kind: "human" });
  assert.equal(first.value.shouldQuery, true);
  assert.equal(first.value.isSynthetic, false);
  assert.deepEqual(accepted, [], "reading the Rust frame alone is not an ACK");

  const second = await iterator.next();
  assert.equal(second.value.message.content, "második");
  assert.deepEqual(accepted, [
    ["00000000-0000-4000-8000-000000000001", "attempt-1"],
  ]);
  await iterator.return();
  assert.deepEqual(accepted, [
    ["00000000-0000-4000-8000-000000000001", "attempt-1"],
    ["00000000-0000-4000-8000-000000000002", "attempt-1"],
  ]);
});

test("the initial prompt and live inputs share one bidirectional stream", async () => {
  const accepted = [];
  const broker = new TurnInputBroker({
    onAccepted: (entry) => accepted.push(entry.inputId),
  });
  const stream = broker.beginAttempt("attempt-stream", "initial request");

  const initial = await stream.next();
  assert.equal(initial.value.message.content, "initial request");
  assert.deepEqual(initial.value.origin, { kind: "human" });
  assert.equal(initial.value.shouldQuery, true);

  broker.enqueue({ inputId: "live-1", text: "steer now" });
  const live = await stream.next();
  assert.equal(live.value.message.content, "steer now");
  assert.equal(live.value.priority, "now");
  assert.deepEqual(live.value.origin, { kind: "human" });

  broker.finishAttempt("attempt-stream");
  const done = await stream.next();
  assert.equal(done.done, true);
  assert.deepEqual(accepted, ["live-1"]);
});

test("a priority-now interruption does not close the stream before its own result", async () => {
  const broker = new TurnInputBroker();
  const stream = broker.beginAttempt("attempt-steer", "initial request");

  await stream.next();
  broker.enqueue({ inputId: "live-1", text: "steer now" });
  await stream.next();

  assert.equal(
    broker.recordResult("attempt-steer"),
    false,
    "the interrupted original response is only the first of two results",
  );
  assert.equal(
    broker.recordResult("attempt-steer"),
    true,
    "the stream may close after the steered response also finishes",
  );
  broker.finishAttempt("attempt-steer");
  assert.equal((await stream.next()).done, true);
});

test("a turn without steering closes after its first result", async () => {
  const broker = new TurnInputBroker();
  const stream = broker.beginAttempt("attempt-single", "initial request");
  await stream.next();

  assert.equal(broker.recordResult("attempt-single"), true);
  broker.finishAttempt("attempt-single");
  assert.equal((await stream.next()).done, true);
});

test("input ids are idempotent across pending and delivered states", async () => {
  const broker = new TurnInputBroker();
  assert.deepEqual(broker.enqueue({ inputId: "same", text: "one" }), {
    accepted: true,
  });
  assert.deepEqual(broker.enqueue({ inputId: "same", text: "one" }), {
    accepted: false,
    code: "duplicate_input",
  });
  const iterator = broker.beginAttempt("attempt")[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return();
  assert.deepEqual(broker.enqueue({ inputId: "same", text: "one" }), {
    accepted: false,
    code: "duplicate_input",
  });
});

test("closing rejects queued but not already delivered input", async () => {
  const rejected = [];
  const broker = new TurnInputBroker({
    onRejected: (entry, code) => rejected.push([entry.inputId, code]),
  });
  broker.enqueue({ inputId: "delivered", text: "one" });
  broker.enqueue({ inputId: "pending", text: "two" });
  const iterator = broker.beginAttempt("attempt")[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return();
  broker.close("run_cancelled", "stopped");

  assert.deepEqual(rejected, [["pending", "run_cancelled"]]);
  assert.equal(broker.pendingCount, 0);
  assert.deepEqual(broker.enqueue({ inputId: "late", text: "late" }), {
    accepted: false,
    code: "run_cancelled",
  });
});

test("an undelivered item survives an attempt boundary for retry", async () => {
  const broker = new TurnInputBroker();
  broker.enqueue({ inputId: "retry-me", text: "instruction" });
  const firstAttempt = broker.beginAttempt("attempt-1")[Symbol.asyncIterator]();
  broker.endAttempt("attempt-1");
  assert.equal((await firstAttempt.next()).done, true);

  const retry = broker.beginAttempt("attempt-2")[Symbol.asyncIterator]();
  assert.equal((await retry.next()).value.message.content, "instruction");
  await retry.return();
});

test("a yielded but unacknowledged input is replayed after an SDK attempt fails", async () => {
  const accepted = [];
  const broker = new TurnInputBroker({
    onAccepted: (entry) => accepted.push(entry.inputId),
  });
  broker.enqueue({ inputId: "retry-me", text: "keep me" });

  const first = broker.beginAttempt("attempt-1")[Symbol.asyncIterator]();
  assert.equal((await first.next()).value.uuid, "retry-me");
  broker.endAttempt("attempt-1");
  assert.deepEqual(accepted, []);

  const second = broker.beginAttempt("attempt-2")[Symbol.asyncIterator]();
  assert.equal((await second.next()).value.uuid, "retry-me");
  const waiting = second.next();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(accepted, ["retry-me"]);
  broker.close();
  await waiting;
});
