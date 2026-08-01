/**
 * FIFO bridge between Rust JSONL control frames and Claude's SDK input stream.
 *
 * An item is acknowledged only when the SDK consumer asks for the following
 * item (or closes the iterator). `Query.streamInput()` does that after its
 * transport write has completed, so merely reading a Rust frame is never
 * reported as provider acceptance.
 */
export class TurnInputBroker {
  constructor({ onAccepted = () => {}, onRejected = () => {} } = {}) {
    this.onAccepted = onAccepted;
    this.onRejected = onRejected;
    this.queue = [];
    this.knownInputIds = new Set();
    this.deliveredInputIds = new Set();
    this.closed = null;
    this.activeAttempt = null;
  }

  enqueue(input) {
    const inputId = typeof input?.inputId === "string" ? input.inputId.trim() : "";
    const text = typeof input?.text === "string" ? input.text.trim() : "";
    if (!inputId || !text) {
      return { accepted: false, code: "unsupported_payload" };
    }
    if (this.closed) return { accepted: false, code: this.closed.code };
    if (this.knownInputIds.has(inputId)) {
      return { accepted: false, code: "duplicate_input" };
    }
    const entry = {
      inputId,
      text,
      receivedAt: new Date().toISOString(),
      meta: input.meta ?? {},
    };
    this.knownInputIds.add(inputId);
    this.queue.push(entry);
    this.activeAttempt?.wake?.();
    return { accepted: true };
  }

  beginAttempt(attemptId) {
    if (this.activeAttempt && !this.activeAttempt.ended) {
      this.endAttempt(this.activeAttempt.id);
    }
    const attempt = {
      id: attemptId,
      ended: false,
      wake: null,
      yielded: null,
    };
    this.activeAttempt = attempt;
    const broker = this;

    const acknowledgeYielded = () => {
      if (!attempt.yielded) return;
      const delivered = attempt.yielded;
      attempt.yielded = null;
      broker.deliveredInputIds.add(delivered.inputId);
      broker.onAccepted(delivered, attemptId);
    };

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        acknowledgeYielded();
        while (true) {
          if (broker.closed || attempt.ended) return { done: true, value: undefined };
          const entry = broker.queue.shift();
          if (entry) {
            attempt.yielded = entry;
            return {
              done: false,
              value: {
                type: "user",
                message: { role: "user", content: entry.text },
                parent_tool_use_id: null,
                priority: "now",
                uuid: entry.inputId,
                timestamp: entry.receivedAt,
              },
            };
          }
          await new Promise((resolve) => {
            attempt.wake = resolve;
          });
          attempt.wake = null;
        }
      },
      async return() {
        acknowledgeYielded();
        attempt.ended = true;
        return { done: true, value: undefined };
      },
    };
  }

  endAttempt(attemptId) {
    const attempt = this.activeAttempt;
    if (!attempt || attempt.id !== attemptId || attempt.ended) return;
    // Consumption without the iterator asking for its next item is not an
    // ACK: streamInput may have failed before its transport write completed.
    // Put that item back at the front so the SDK retry sees it exactly once.
    if (attempt.yielded) {
      this.queue.unshift(attempt.yielded);
      attempt.yielded = null;
    }
    attempt.ended = true;
    attempt.wake?.();
  }

  close(code = "no_active_turn", message = "A Claude turn lezárult.") {
    if (this.closed) return;
    this.closed = { code, message };
    if (this.activeAttempt && !this.activeAttempt.ended) {
      if (this.activeAttempt.yielded) {
        const entry = this.activeAttempt.yielded;
        this.activeAttempt.yielded = null;
        this.onRejected(entry, code, message);
      }
      this.activeAttempt.ended = true;
      this.activeAttempt.wake?.();
    }
    const pending = this.queue.splice(0);
    for (const entry of pending) this.onRejected(entry, code, message);
  }

  get pendingCount() {
    return this.queue.length;
  }
}
