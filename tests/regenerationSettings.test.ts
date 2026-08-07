import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveRegenerationRequestSettings } from "../src/regenerationSettings.ts";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

const compact = {
  provider: "codex",
  accessProfile: null,
  model: "gpt-5.6-luna",
  effort: "high",
};

test("a részletes fázison kiválasztott új modell kerül a regenerálásba", () => {
  const stage = {
    provider: "anthropic",
    accessProfile: "claude",
    model: "claude-opus-5",
    effort: "max",
  };
  assert.deepEqual(resolveRegenerationRequestSettings(compact, stage), stage);
});

test("egyszerű válasznál a composer aktuális modellje marad", () => {
  assert.deepEqual(resolveRegenerationRequestSettings(compact), compact);
});

test("az aktuális composer mód dönti el a regenerálás futási módját", () => {
  const regenerateBlock = app.slice(
    app.indexOf("const regenerateAnswer ="),
    app.indexOf("const rerunChainFromReview ="),
  );
  assert.match(regenerateBlock, /const regenerationStageIndex = answerStageIndex \?\? 0/);
  assert.doesNotMatch(regenerateBlock, /setShowDetailedTrace\(false\)/);
  assert.match(
    app,
    /const runPipeline = detailedRequest && Boolean\(activePipelineRecipe\)/,
  );
  assert.match(app, /const regenerationStageIndex = answerStageIndex \?\? 0/);
  assert.match(
    app,
    /source: \{ \.\.\.regenerationBase\.source, detailed: detailedRequest \}/,
  );
  assert.match(
    app,
    /index === regenerationBase\.sourceIndex[\s\S]*?\{ \.\.\.message, detailed: detailedRequest \}/,
  );
  assert.match(app, /if \(runPipeline && activePipelineRecipe && isTauri\)/);
  assert.match(
    app,
    /replaceMessageId: regeneration\?\.originalAnswer\.id \?\? null/,
  );
});
