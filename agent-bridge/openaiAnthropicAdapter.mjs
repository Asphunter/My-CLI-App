import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_BODY_LIMIT = 32 * 1024 * 1024;

function textFromBlocks(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

function openAiUserContent(blocks) {
  const content = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (block?.type !== "image" || !block.source) continue;
    if (block.source.type === "base64") {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${block.source.media_type ?? "image/png"};base64,${block.source.data ?? ""}`,
        },
      });
    } else if (block.source.type === "url" && typeof block.source.url === "string") {
      content.push({ type: "image_url", image_url: { url: block.source.url } });
    }
  }
  if (content.every((part) => part.type === "text")) {
    return content.map((part) => part.text).join("\n\n");
  }
  return content;
}

function translateMessage(message) {
  const role = message?.role;
  const blocks = Array.isArray(message?.content) ? message.content : null;
  if (!blocks) {
    return [{ role, content: typeof message?.content === "string" ? message.content : "" }];
  }
  if (role === "assistant") {
    const text = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n\n");
    const reasoning = blocks
      .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
      .map((block) => block.thinking)
      .join("\n");
    const toolCalls = blocks
      .filter((block) => block?.type === "tool_use")
      .map((block, index) => ({
        id: typeof block.id === "string" ? block.id : `call_${index}`,
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "tool",
          arguments: JSON.stringify(block.input ?? {}),
        },
      }));
    return [{
      role: "assistant",
      content: text || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    }];
  }
  if (role === "user") {
    const translated = [];
    const ordinary = blocks.filter((block) => block?.type !== "tool_result");
    if (ordinary.length) translated.push({ role: "user", content: openAiUserContent(ordinary) });
    for (const block of blocks.filter((item) => item?.type === "tool_result")) {
      const resultBlocks = Array.isArray(block.content) ? block.content : [];
      const resultText = textFromBlocks(resultBlocks)
        || (typeof block.content === "string" ? block.content : "")
        || "[A tool képet adott vissza.]";
      translated.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: resultText,
      });
      const imageResults = resultBlocks.filter((item) => item?.type === "image");
      if (imageResults.length) {
        translated.push({
          role: "user",
          content: openAiUserContent([
            { type: "text", text: `A(z) ${block.tool_use_id ?? "tool"} eszköz képkimenete:` },
            ...imageResults,
          ]),
        });
      }
    }
    return translated;
  }
  return [{ role, content: openAiUserContent(blocks) }];
}

function translateToolChoice(choice) {
  if (!choice || choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return "auto";
}

export function anthropicToOpenAiRequest(body, {
  model = "kimi-k3",
  reasoningEffort = "high",
} = {}) {
  const messages = [];
  const system = textFromBlocks(body?.system);
  if (system) messages.push({ role: "system", content: system });
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    messages.push(...translateMessage(message));
  }
  const tools = Array.isArray(body?.tools)
    ? body.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.input_schema ?? { type: "object", properties: {} },
        },
      }))
    : [];
  return {
    model,
    messages,
    stream: body?.stream !== false,
    ...(Number.isFinite(body?.max_tokens) ? { max_tokens: body.max_tokens } : {}),
    ...(Number.isFinite(body?.temperature) ? { temperature: body.temperature } : {}),
    ...(Number.isFinite(body?.top_p) ? { top_p: body.top_p } : {}),
    ...(Array.isArray(body?.stop_sequences) && body.stop_sequences.length
      ? { stop: body.stop_sequences }
      : {}),
    ...(tools.length
      ? {
          tools,
          tool_choice: translateToolChoice(body?.tool_choice),
          // The Anthropic stream format keeps one content block open at a
          // time. A sequential tool loop therefore maps without lossy block
          // interleaving and also matches the Min's guarded agent workflow.
          parallel_tool_calls: false,
        }
      : {}),
    reasoning_effort: ["low", "high", "max"].includes(reasoningEffort)
      ? reasoningEffort
      : "high",
  };
}

function stopReason(value, hasTools = false) {
  if (hasTools || value === "tool_calls" || value === "function_call") return "tool_use";
  if (value === "length") return "max_tokens";
  if (value === "content_filter") return "refusal";
  return "end_turn";
}

function usageShape(usage = {}) {
  return {
    input_tokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    output_tokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
  };
}

export function openAiToAnthropicResponse(payload, fallbackModel = "kimi-k3") {
  const choice = payload?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];
  const reasoning = message.reasoning_content ?? message.reasoning;
  if (typeof reasoning === "string" && reasoning) {
    content.push({ type: "thinking", thinking: reasoning, signature: "min-kimi-open" });
  }
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    let input = {};
    try {
      input = JSON.parse(call?.function?.arguments || "{}");
    } catch {
      input = { _raw: call?.function?.arguments ?? "" };
    }
    content.push({
      type: "tool_use",
      id: call?.id ?? `call_${index}`,
      name: call?.function?.name ?? "tool",
      input,
    });
  }
  return {
    id: payload?.id ?? `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: payload?.model ?? fallbackModel,
    content,
    stop_reason: stopReason(choice.finish_reason, content.some((block) => block.type === "tool_use")),
    stop_sequence: null,
    usage: usageShape(payload?.usage),
  };
}

function event(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class AnthropicSseEncoder {
  constructor({ model = "kimi-k3" } = {}) {
    this.model = model;
    this.id = `msg_${randomUUID()}`;
    this.started = false;
    this.active = null;
    this.blockIndex = -1;
    this.finishReason = null;
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.sawTools = false;
  }

  start(payload = {}) {
    if (this.started) return "";
    this.started = true;
    this.id = payload.id ?? this.id;
    this.model = payload.model ?? this.model;
    this.usage = { ...this.usage, ...usageShape(payload.usage) };
    return event("message_start", {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.usage.input_tokens, output_tokens: 0 },
      },
    });
  }

  closeBlock() {
    if (!this.active) return "";
    let output = "";
    if (this.active.kind === "thinking") {
      output += event("content_block_delta", {
        type: "content_block_delta",
        index: this.active.index,
        delta: { type: "signature_delta", signature: "min-kimi-open" },
      });
    }
    output += event("content_block_stop", {
      type: "content_block_stop",
      index: this.active.index,
    });
    this.active = null;
    return output;
  }

  openBlock(kind, key, meta = {}) {
    if (this.active?.key === key) return "";
    let output = this.closeBlock();
    const index = ++this.blockIndex;
    this.active = { kind, key, index };
    const contentBlock = kind === "thinking"
      ? { type: "thinking", thinking: "", signature: "" }
      : kind === "tool_use"
        ? { type: "tool_use", id: meta.id, name: meta.name, input: {} }
        : { type: "text", text: "" };
    output += event("content_block_start", {
      type: "content_block_start",
      index,
      content_block: contentBlock,
    });
    return output;
  }

  feed(payload) {
    let output = this.start(payload);
    if (payload?.usage) this.usage = { ...this.usage, ...usageShape(payload.usage) };
    const choice = payload?.choices?.[0];
    if (!choice) return output;
    const delta = choice.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning) {
      output += this.openBlock("thinking", "thinking");
      output += event("content_block_delta", {
        type: "content_block_delta",
        index: this.active.index,
        delta: { type: "thinking_delta", thinking: reasoning },
      });
    }
    if (typeof delta.content === "string" && delta.content) {
      output += this.openBlock("text", "text");
      output += event("content_block_delta", {
        type: "content_block_delta",
        index: this.active.index,
        delta: { type: "text_delta", text: delta.content },
      });
    }
    for (const [position, call] of (delta.tool_calls ?? []).entries()) {
      const toolIndex = call?.index ?? position;
      const key = `tool:${toolIndex}`;
      this.sawTools = true;
      output += this.openBlock("tool_use", key, {
        id: call?.id ?? `call_${toolIndex}`,
        name: call?.function?.name ?? "tool",
      });
      const partial = call?.function?.arguments;
      if (typeof partial === "string" && partial) {
        output += event("content_block_delta", {
          type: "content_block_delta",
          index: this.active.index,
          delta: { type: "input_json_delta", partial_json: partial },
        });
      }
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return output;
  }

  finish() {
    let output = this.start();
    output += this.closeBlock();
    output += event("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: stopReason(this.finishReason, this.sawTools),
        stop_sequence: null,
      },
      usage: { output_tokens: this.usage.output_tokens },
    });
    output += event("message_stop", { type: "message_stop" });
    return output;
  }
}

async function readBody(request, limit = DEFAULT_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

async function pipeOpenAiSse(upstream, response, model) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const encoder = new AnthropicSseEncoder({ model });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data);
        if (parsed?.error) {
          response.write(event("error", {
            type: "error",
            error: {
              type: parsed.error.type ?? "api_error",
              message: parsed.error.message ?? "Kimi upstream error",
            },
          }));
          continue;
        }
        response.write(encoder.feed(parsed));
      }
    }
  }
  response.end(encoder.finish());
}

export async function startKimiOpenAdapter({
  apiKey,
  upstreamBaseUrl = "https://api.moonshot.ai/v1",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("Missing Kimi Open Platform API key.");
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch runtime nem érhető el.");
  const normalizedBase = upstreamBaseUrl.replace(/\/+$/, "");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && /\/messages\/count_tokens$/.test(url.pathname)) {
        const body = await readBody(request);
        sendJson(response, 200, {
          input_tokens: Math.max(1, Math.ceil(JSON.stringify(body).length / 4)),
        });
        return;
      }
      if (request.method !== "POST" || !/\/messages$/.test(url.pathname)) {
        sendJson(response, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
        return;
      }
      const body = await readBody(request);
      const reasoningEffort = process.env.MIN_AGENT_EFFECTIVE_EFFORT ?? "high";
      const openAiBody = anthropicToOpenAiRequest(body, {
        model: "kimi-k3",
        reasoningEffort,
      });
      const upstream = await fetchImpl(`${normalizedBase}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(openAiBody),
      });
      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 16_384);
        response.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
        response.end(detail || JSON.stringify({ error: { message: `Kimi HTTP ${upstream.status}` } }));
        return;
      }
      if (openAiBody.stream) {
        await pipeOpenAiSse(upstream, response, openAiBody.model);
      } else {
        sendJson(response, 200, openAiToAnthropicResponse(await upstream.json(), openAiBody.model));
      }
    } catch (error) {
      const status = error?.message === "request_too_large" ? 413 : 502;
      sendJson(response, status, {
        type: "error",
        error: { type: "api_error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("A Kimi loopback adapter nem kapott TCP-portot.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
