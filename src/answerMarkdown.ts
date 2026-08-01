export type AnswerMarkdownBlock =
  | { type: "text"; text: string }
  | { type: "code"; language: string; code: string; closed: boolean };

/**
 * Keeps prose and fenced code in their original order.
 *
 * The answer UI used to remove every fenced block before rendering the text.
 * That is especially dangerous for installation instructions: the sentence
 * introducing a command survived while the command itself disappeared.
 */
export const splitAnswerMarkdownBlocks = (
  source: string,
): AnswerMarkdownBlock[] => {
  const blocks: AnswerMarkdownBlock[] = [];
  const openingFence = /```([^\r\n`]*)\r?\n?/g;
  let cursor = 0;

  while (cursor < source.length) {
    openingFence.lastIndex = cursor;
    const opening = openingFence.exec(source);
    if (!opening) {
      const text = source.slice(cursor);
      if (text.trim()) blocks.push({ type: "text", text });
      break;
    }

    const before = source.slice(cursor, opening.index);
    if (before.trim()) blocks.push({ type: "text", text: before });

    const codeStart = openingFence.lastIndex;
    const closing = source.indexOf("```", codeStart);
    if (closing < 0) {
      blocks.push({
        type: "code",
        language: opening[1].trim() || "text",
        code: source.slice(codeStart).replace(/^\r?\n/, "").trimEnd(),
        closed: false,
      });
      cursor = source.length;
      break;
    }

    blocks.push({
      type: "code",
      language: opening[1].trim() || "text",
      code: source.slice(codeStart, closing).replace(/^\r?\n/, "").trimEnd(),
      closed: true,
    });
    cursor = closing + 3;
  }

  return blocks;
};
