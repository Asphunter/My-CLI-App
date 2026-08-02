import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSdkPrompt, imageBlocks } from "./multimodalPrompt.mjs";

test("text-only prompts keep the ordinary SDK string path", () => {
  assert.equal(createSdkPrompt("hello", [], process.cwd()), "hello");
});

test("workspace images become base64 SDK content without exposing a path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "min-image-prompt-"));
  try {
    const filePath = path.join(root, "shot.png");
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const prompt = createSdkPrompt(
      "inspect",
      [{ path: filePath, name: "shot.png", mimeType: "image/png" }],
      root,
    );
    const messages = [];
    for await (const message of prompt) messages.push(message);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.content[0].text, "inspect");
    assert.equal(messages[0].message.content[1].source.media_type, "image/png");
    assert.equal(messages[0].message.content[1].source.data, "iVBORw==");
    assert.doesNotMatch(JSON.stringify(messages), /shot\.png/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("image prompt paths cannot escape the workspace", () => {
  const root = mkdtempSync(path.join(tmpdir(), "min-image-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "min-image-outside-"));
  try {
    const filePath = path.join(outside, "shot.png");
    writeFileSync(filePath, "x");
    assert.throws(
      () => imageBlocks([{ path: filePath, mimeType: "image/png" }], root),
      /workspace-en kívülre/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
