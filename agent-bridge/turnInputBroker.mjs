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

  beginAttempt(attemptId, initialPrompt = null) {
    if (this.activeAttempt && !this.activeAttempt.ended) {
      this.endAttempt(this.activeAttempt.id);
    }
    const attempt = {
      id: attemptId,
      ended: false,
      wake: null,
      yielded: null,
      messageCount: 0,
      resultCount: 0,
    };
    this.activeAttempt = attempt;
    const broker = this;
    const initialIterator =
      typeof initialPrompt === "string"
        ? (async function* initialTextMessage() {
            yield {
              type: "user",
              message: { role: "user", content: initialPrompt },
              parent_tool_use_id: null,
              origin: { kind: "human" },
              shouldQuery: true,
            };
          })()
        : initialPrompt?.[Symbol.asyncIterator]?.() ?? null;
    let initialDone = initialIterator == null;

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
          if (!initialDone) {
            const initial = await initialIterator.next();
            if (!initial.done) {
              attempt.messageCount += 1;
              return {
                done: false,
                value: {
                  ...initial.value,
                  origin: initial.value?.origin ?? { kind: "human" },
                  shouldQuery: initial.value?.shouldQuery ?? true,
                },
              };
            }
            initialDone = true;
          }
          const entry = broker.queue.shift();
          if (entry) {
            attempt.yielded = entry;
            attempt.messageCount += 1;
            return {
              done: false,
              value: {
                type: "user",
                message: { role: "user", content: entry.text },
                parent_tool_use_id: null,
                priority: "now",
                origin: { kind: "human" },
                shouldQuery: true,
                isSynthetic: false,
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

  /**
   * Egy priority=now input ket provider-eredmenyt okozhat: az elso az eppen
   * futo valasz megszakitasat zarja le, a kovetkezo mar a terelt uzenet
   * eredmenye. A stdin csak akkor zarhato, amikor minden kiirt user uzenethez
   * megerkezett az eredmeny; kulonben a terelt kor tool-permission valaszai mar
   * egy lezart streamre probalnak irni.
   */
  recordResult(attemptId) {
    const attempt = this.activeAttempt;
    if (!attempt || attempt.id !== attemptId || attempt.ended) return false;
    attempt.resultCount += 1;
    return (
      attempt.messageCount > 0 &&
      attempt.resultCount >= attempt.messageCount &&
      this.queue.length === 0
    );
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

  /**
   * A provider eredmenye bizonyitja, hogy az utoljara kiirt input eljutott a
   * turnhoz. Zarjuk le az eleve ketiranyu prompt-streamet, hogy a CLI tisztan
   * befejezhesse ezt az egy GUI-szakaszt.
   */
  finishAttempt(attemptId) {
    const attempt = this.activeAttempt;
    if (!attempt || attempt.id !== attemptId || attempt.ended) return;
    if (attempt.yielded) {
      const delivered = attempt.yielded;
      attempt.yielded = null;
      this.deliveredInputIds.add(delivered.inputId);
      this.onAccepted(delivered, attemptId);
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
