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
