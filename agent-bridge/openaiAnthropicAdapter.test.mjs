import test from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicSseEncoder,
  anthropicToOpenAiRequest,
  openAiToAnthropicResponse,
  startKimiOpenAdapter,
} from "./openaiAnthropicAdapter.mjs";

test("Anthropic messages become Kimi Chat Completions without losing tools or reasoning", () => {
  const translated = anthropicToOpenAiRequest({
    model: "ignored-by-built-in-route",
    max_tokens: 4096,
    system: [{ type: "text", text: "System" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need a file", signature: "opaque" },
          { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "a.txt" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "hello" }],
      },
    ],
    tools: [{
      name: "Read",
      description: "Read a file",
      input_schema: { type: "object", properties: { file_path: { type: "string" } } },
    }],
    tool_choice: { type: "auto" },
    stream: true,
  }, { model: "kimi-k3", reasoningEffort: "max" });

  assert.equal(translated.model, "kimi-k3");
  assert.equal(translated.reasoning_effort, "max");
  assert.equal(translated.messages[0].role, "system");
  assert.equal(translated.messages[2].reasoning_content, "Need a file");
  assert.deepEqual(JSON.parse(translated.messages[2].tool_calls[0].function.arguments), {
    file_path: "a.txt",
  });
  assert.deepEqual(translated.messages[3], {
    role: "tool",
    tool_call_id: "call-1",
    content: "hello",
  });
  assert.equal(translated.tools[0].function.name, "Read");
  assert.equal(translated.parallel_tool_calls, false);
});

test("OpenAI tool responses become valid Anthropic content blocks", () => {
  const translated = openAiToAnthropicResponse({
    id: "chat-1",
    model: "kimi-k3",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: null,
        reasoning_content: "I should inspect it.",
        tool_calls: [{
          id: "call-2",
          type: "function",
          function: { name: "Read", arguments: "{\"file_path\":\"b.txt\"}" },
        }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 7 },
  });

  assert.equal(translated.stop_reason, "tool_use");
  assert.equal(translated.content[0].type, "thinking");
  assert.deepEqual(translated.content[1].input, { file_path: "b.txt" });
  assert.deepEqual(translated.usage, { input_tokens: 10, output_tokens: 7 });
});

test("Kimi translation preserves initial and tool-returned images", () => {
  const translated = anthropicToOpenAiRequest({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-image", name: "Read", input: { file_path: "x.png" } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call-image",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQ==" } }],
        }],
      },
    ],
    stream: true,
  });

  assert.equal(translated.messages[0].content[1].image_url.url, "data:image/png;base64,AA==");
  assert.equal(translated.messages[2].role, "tool");
  assert.equal(translated.messages[3].role, "user");
  assert.equal(translated.messages[3].content[1].image_url.url, "data:image/png;base64,AQ==");
});

test("SSE encoder preserves split reasoning, text and tool arguments", () => {
  const encoder = new AnthropicSseEncoder({ model: "kimi-k3" });
  let output = "";
  output += encoder.feed({ id: "chat-2", choices: [{ delta: { reasoning_content: "Think" } }] });
  output += encoder.feed({ choices: [{ delta: { content: "Answer" } }] });
  output += encoder.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-3", function: { name: "Read", arguments: "{\"file_" } }] } }] });
  output += encoder.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "path\":\"c.txt\"}" } }] }, finish_reason: "tool_calls" }] });
  output += encoder.finish();

  assert.match(output, /event: message_start/);
  assert.match(output, /thinking_delta/);
  assert.match(output, /signature_delta/);
  assert.match(output, /text_delta/);
  assert.match(output, /input_json_delta/);
  assert.match(output, /\\"file_/);
  assert.match(output, /\\"c\.txt\\"/);
  assert.match(output, /"stop_reason":"tool_use"/);
  assert.match(output, /event: message_stop/);
});

test("loopback adapter keeps the real key on the upstream hop", async () => {
  let observed;
  const upstreamSse = [
    'data: {"id":"chat-3","model":"kimi-k3","choices":[{"delta":{"content":"OK"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join("\n");
  const adapter = await startKimiOpenAdapter({
    apiKey: "sk-kimi-secret",
    upstreamBaseUrl: "https://unit.test/v1",
    fetchImpl: async (url, init) => {
      observed = { url, init, body: JSON.parse(init.body) };
      return new Response(upstreamSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    const response = await fetch(`${adapter.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "min-local-kimi-proxy",
      },
      body: JSON.stringify({
        model: "kimi-k3",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "say OK" }],
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(observed.url, "https://unit.test/v1/chat/completions");
    assert.equal(observed.init.headers.authorization, "Bearer sk-kimi-secret");
    assert.equal(observed.body.model, "kimi-k3");
    assert.match(text, /"text":"OK"/);
    assert.doesNotMatch(text, /sk-kimi-secret/);
  } finally {
    await adapter.close();
  }
});
