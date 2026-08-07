import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nativeShell = readFileSync(
  new URL("../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);

test("a megszakítás azonnal leveszi a Windows taskbar futásjelzését", () => {
  assert.match(
    nativeShell,
    /fn acknowledge_work_cancellation[\s\S]*set_taskbar_terminal\(app, false\)/,
  );
  for (const command of [
    "pipeline_cancel",
    "pipeline_cancel_request",
    "agent_cancel",
    "claude_cancel",
    "codex_cancel",
  ]) {
    assert.match(
      nativeShell,
      new RegExp(
        `fn ${command}\\([\\s\\S]*?acknowledge_work_cancellation\\(&app`,
      ),
    );
  }
});

test("a STOP-olt provider drain már nem blokkolja az ablak bezárását", () => {
  assert.match(nativeShell, /fn close_blocking_work\(\)/);
  assert.match(
    nativeShell,
    /fn acknowledge_work_cancellation[\s\S]*work\.remove\(request_id\)/,
  );
  assert.match(
    nativeShell,
    /WindowEvent::CloseRequested[\s\S]*active_close_blocking_count\(\) > 0/,
  );
});
