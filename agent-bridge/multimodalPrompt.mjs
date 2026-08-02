import { readFileSync } from "node:fs";
import path from "node:path";

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function plainWindowsPath(value) {
  return String(value ?? "").replace(/^\\\\\?\\/, "");
}

function resolveInsideWorkspace(cwd, value) {
  const root = path.resolve(plainWindowsPath(cwd));
  const candidate = path.resolve(plainWindowsPath(value));
  const relative = path.relative(root, candidate);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new Error("A képcsatolmány a workspace-en kívülre mutat.");
}

function normalizedMimeType(value) {
  const mimeType = String(value ?? "").trim().toLowerCase();
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

export function imageBlocks(images, cwd) {
  if (!Array.isArray(images) || images.length === 0) return [];
  if (images.length > MAX_IMAGES) {
    throw new Error(`Legfelj ${MAX_IMAGES} kép küldhető egy kérésben.`);
  }
  return images.map((image) => {
    const mimeType = normalizedMimeType(image?.mimeType);
    if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
      throw new Error(`Nem támogatott képtípus: ${mimeType || "ismeretlen"}.`);
    }
    const filePath = resolveInsideWorkspace(cwd, image?.path);
    const bytes = readFileSync(filePath);
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`A képcsatolmány mérete érvénytelen: ${image?.name || path.basename(filePath)}.`);
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType,
        data: bytes.toString("base64"),
      },
    };
  });
}

/**
 * Claude Agent SDK only accepts multimodal input through its SDKUserMessage
 * stream. Keep the ordinary string path for text-only turns so resume and
 * live steering retain the behavior already exercised in production.
 */
export function createSdkPrompt(prompt, images, cwd) {
  const blocks = imageBlocks(images, cwd);
  if (blocks.length === 0) return prompt;
  return (async function* initialUserMessage() {
    yield {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }, ...blocks],
      },
      parent_tool_use_id: null,
    };
  })();
}
