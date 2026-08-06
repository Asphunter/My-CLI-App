import assert from "node:assert/strict";
import test from "node:test";
import {
  alignChecklistToExpectedPlan,
  expectedPlanTitleFor,
  expectedPlanTitlesFromPrompt,
  isChecklistMetaTask,
  planFromTasks,
  updatedChecklistTask,
} from "./policy.mjs";

const codePrompt = `[EREDETI FELADAT]\nMarker.\n\n[ELŐZMÉNY]\nA tervező terve:\n1. UTÁNA marker és regresszió — marker, tesztek, demo.\n\n**Kockázatok:** nincs.\n\n[SZEREP]\nTe vagy a kódoló. Hajtsd végre.`;

test("coding prompts expose the exact accepted planner titles", () => {
  assert.deepEqual(expectedPlanTitlesFromPrompt(codePrompt), ["UTÁNA marker és regresszió"]);
  assert.equal(
    expectedPlanTitleFor("UTÁNA marker és regresszió", ["UTÁNA marker és regresszió"]),
    "UTÁNA marker és regresszió",
  );
  assert.equal(
    expectedPlanTitleFor("0. Kódolás előkészítése és a terv értelmezése", ["UTÁNA marker és regresszió"]),
    null,
  );
});

test("invented preparation rows cannot replace a one-step accepted plan", () => {
  const expected = ["UTÁNA marker és regresszió"];
  const aligned = alignChecklistToExpectedPlan([
    { id: "0", step: "0. Kódolás előkészítése és a terv értelmezése", status: "completed" },
    { id: "1", step: "UTÁNA marker és regresszió", status: "in_progress" },
  ], expected);
  assert.deepEqual(aligned, [
    { id: "1", step: "UTÁNA marker és regresszió", status: "in_progress" },
  ]);

  const tasks = new Map([
    ["prep", { subject: "0. Kódolás előkészítése", status: "completed", hidden: true }],
    ["real", { planId: "real", subject: "UTÁNA marker és regresszió", status: "pending" }],
  ]);
  assert.deepEqual(planFromTasks(tasks), [
    { id: "real", step: "UTÁNA marker és regresszió", status: "pending" },
  ]);

  const hiddenAfterProgress = updatedChecklistTask(
    tasks.get("prep"),
    { taskId: "1", status: "in_progress" },
    "prep",
  );
  assert.equal(hiddenAfterProgress.hidden, true);
  assert.deepEqual(planFromTasks(new Map([["prep", hiddenAfterProgress]])), []);
  assert.equal(
    isChecklistMetaTask("0. Kódolás előkészítése és a terv értelmezése"),
    true,
  );
  assert.equal(isChecklistMetaTask("1. Igazított lépéslista"), false);
});

test("review prompts keep their independent checklist", () => {
  assert.deepEqual(
    expectedPlanTitlesFromPrompt(codePrompt.replace("Te vagy a kódoló.", "Te vagy a bíráló.")),
    [],
  );
});
