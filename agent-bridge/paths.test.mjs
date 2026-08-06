import assert from "node:assert/strict";
import test from "node:test";
import {
  commandAppearsOutsideWorkspace,
  containsForbiddenPath,
  isInsideWorkspace,
} from "./paths.mjs";

const cwd = "C:\\Users\\danis\\OneDrive\\my projects\\V4 Flash Fixed E2E";

test("quoted workspace paths with spaces are not truncated into false escapes", () => {
  assert.equal(
    commandAppearsOutsideWorkspace(
      'cd "C:/Users/danis/OneDrive/my projects/V4 Flash Fixed E2E" && python -m pytest -q',
      cwd,
    ),
    false,
  );
  assert.equal(
    commandAppearsOutsideWorkspace(
      'python "C:/Users/danis/OneDrive/my projects/V4 Flash Fixed E2E/tools/smoke.py"',
      cwd,
    ),
    false,
  );
});

test("quoted siblings and protected internal paths remain blocked", () => {
  assert.equal(
    commandAppearsOutsideWorkspace(
      'cd "C:/Users/danis/OneDrive/my projects/Other Project" && python -m pytest',
      cwd,
    ),
    true,
  );
  assert.equal(
    commandAppearsOutsideWorkspace(
      'type "C:/Users/danis/OneDrive/my projects/V4 Flash Fixed E2E/.git/config"',
      cwd,
    ),
    true,
  );
});

test("direct path checks keep the same containment boundary", () => {
  assert.equal(isInsideWorkspace(cwd, `${cwd}\\rf_bench\\cli.py`), true);
  assert.equal(containsForbiddenPath(`${cwd}\\artifacts\\trace.log`, cwd), true);
  assert.equal(containsForbiddenPath(`${cwd}\\rf_bench\\cli.py`, cwd), false);
});
