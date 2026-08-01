import assert from "node:assert/strict";
import test from "node:test";

import { splitAnswerMarkdownBlocks } from "../src/answerMarkdown.ts";

test("a fenced PowerShell instruction stays between its surrounding prose", () => {
  const blocks = splitAnswerMarkdownBlocks(
    [
      "Nyiss egy PowerShellt, és futtasd:",
      "",
      "```powershell",
      ".\\tools\\install_toolchain.ps1",
      ".\\tools\\build_apk.ps1",
      "```",
      "",
      "Majd csatlakoztasd a telefont.",
    ].join("\n"),
  );

  assert.deepEqual(blocks, [
    {
      type: "text",
      text: "Nyiss egy PowerShellt, és futtasd:\n\n",
    },
    {
      type: "code",
      language: "powershell",
      code: ".\\tools\\install_toolchain.ps1\n.\\tools\\build_apk.ps1",
      closed: true,
    },
    {
      type: "text",
      text: "\n\nMajd csatlakoztasd a telefont.",
    },
  ]);
});

test("an unfinished streaming fence is kept as visible code", () => {
  assert.deepEqual(
    splitAnswerMarkdownBlocks("## Telepítés\n\n```powershell\nflutter pub get"),
    [
      { type: "text", text: "## Telepítés\n\n" },
      {
        type: "code",
        language: "powershell",
        code: "flutter pub get",
        closed: false,
      },
    ],
  );
});
