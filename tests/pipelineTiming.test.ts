import assert from "node:assert/strict";
import test from "node:test";

import {
  mergePipelineStageTiming,
  pipelineChainTimingBounds,
} from "../src/pipelineTiming.ts";

test("a szinkronizált szakasz-időzítés a teljes ismert intervallumot őrzi", () => {
  assert.deepEqual(
    mergePipelineStageTiming(
      { startedAt: 2_000, completedAt: 8_000 },
      { startedAt: 1_000, completedAt: 9_000 },
    ),
    { startedAt: 1_000, completedAt: 9_000 },
  );
});

test("a pipeline időzítése az első szakasz kezdetétől az utolsó végéig tart", () => {
  assert.deepEqual(
    pipelineChainTimingBounds([
      { startedAt: 1_000, completedAt: 4_000 },
      { startedAt: 4_100, completedAt: 7_000 },
      { startedAt: 7_200, completedAt: 9_500 },
    ]),
    { startedAt: 1_000, completedAt: 9_500 },
  );
});

test("a régi, lezárási idő nélküli futáshoz nem talál ki 0:00 értéket", () => {
  assert.deepEqual(
    pipelineChainTimingBounds([{ startedAt: 1_000 }, { startedAt: 4_000 }]),
    { startedAt: 1_000, completedAt: undefined },
  );
});
