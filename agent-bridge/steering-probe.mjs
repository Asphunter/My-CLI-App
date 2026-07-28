/**
 * Does a Claude turn accept input while it is already running?
 *
 * The whole mid-turn steering feature rests on one uncertainty: `query()` takes
 * either a string or an `AsyncIterable<SDKUserMessage>`, and the types show a
 * `priority: 'now' | 'next' | 'later'` on those messages — but types do not say
 * whether a turn still *completes* while the input stream stays open, or waits
 * for it to close. Getting that wrong would hang every Claude turn in the app,
 * so it is answered here, outside the app, before the bridge is touched.
 *
 * Run:  node agent-bridge/steering-probe.mjs
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const say = (message) => process.stdout.write(`${message}\n`);

/** Emits the task, then a steer a moment later, then closes. */
async function* steeredPrompt(steerAfterMs) {
  yield {
    type: "user",
    message: {
      role: "user",
      content:
        "Számolj el lassan 1-től 20-ig, soronként egy számot írva. Ne használj eszközt.",
    },
    parent_tool_use_id: null,
  };
  await new Promise((resolve) => setTimeout(resolve, steerAfterMs));
  say(`[probe] terelés beküldve ${steerAfterMs} ms után`);
  yield {
    type: "user",
    message: {
      role: "user",
      content: "Változás: hagyd abba a számolást, és írd ki csak azt: TERELVE.",
    },
    parent_tool_use_id: null,
    priority: "now",
  };
}

async function main() {
  const started = Date.now();
  let sawSteerAcknowledged = false;
  let finalText = "";
  let turns = 0;

  const stream = query({
    prompt: steeredPrompt(3000),
    options: {
      model: "claude-fable-5",
      effort: "low",
      maxTurns: 4,
      permissionMode: "default",
      allowedTools: [],
      tools: [],
      settingSources: [],
      includePartialMessages: false,
      env: process.env,
    },
  });

  for await (const event of stream) {
    if (event?.type === "assistant") {
      const text = (event.message?.content ?? [])
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("");
      if (text.includes("TERELVE")) sawSteerAcknowledged = true;
    }
    if (event?.type === "result") {
      turns = event.num_turns ?? 0;
      finalText = typeof event.result === "string" ? event.result : "";
    }
  }

  const elapsed = Date.now() - started;
  say("");
  say("=== EREDMÉNY ===");
  say(`a turn lezárult:            igen (${elapsed} ms)`);
  say(`a terelés megérkezett:      ${sawSteerAcknowledged ? "IGEN" : "nem"}`);
  say(`num_turns:                  ${turns}`);
  say(`végső szöveg (első 120):    ${finalText.slice(0, 120).replace(/\n/g, " ")}`);
  say("");
  say(
    sawSteerAcknowledged
      ? "A menet közbeni terelés működik: a nyitott input-stream nem akadályozza a turn lezárását."
      : "A turn lezárult, de a terelés nem hatott — a bridge-nek más utat kell keresnie.",
  );
}

main().catch((error) => {
  say(`[probe] HIBA: ${error?.message ?? error}`);
  process.exitCode = 1;
});
