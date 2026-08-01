export type CompactAnswerEvent = {
  id: string;
  itemId?: string;
  turnId?: string;
  sequence?: number;
  text: string;
  live?: boolean;
};

export type CompactTraceEvent = {
  id: string;
  turnId?: string;
  sequence?: number;
  /** Consecutive internal rows collapse to their latest state in the UI. */
  kind?: "internal" | "activity";
  presentation?:
    | "narrative"
    | "reasoning"
    | "command"
    | "tool"
    | "file"
    | "status";
  /** One-line text used by the collapsed technical timeline. */
  summary?: string;
  /** Full safe detail; shown only after an explicit second-level expansion. */
  detail?: string;
  /** Errors and user decisions stay outside routine technical groups. */
  important?: boolean;
};

export type CompactTraceSection =
  | { kind: "primary"; id: string; item: CompactTraceEvent }
  | {
      kind: "technical";
      id: string;
      items: CompactTraceEvent[];
      label: string;
    };

export type CompactFinalAnswer = {
  id: string;
  turnId?: string;
  text: string;
  live?: boolean;
};

export type CompactAnswerBlock = {
  id: string;
  turnId?: string;
  itemId?: string;
  sequenceStart: number;
  sequenceEnd: number;
  text: string;
  final: boolean;
  live: boolean;
  pending: boolean;
  trace: CompactTraceEvent[];
};

export type CompactAnswerTimelineInput = {
  answers: CompactAnswerEvent[];
  trace: CompactTraceEvent[];
  finalAnswer?: CompactFinalAnswer;
  streaming: boolean;
  turnId?: string;
};

const finiteSequence = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const consumeAnswerPrefix = (text: string, answers: CompactAnswerEvent[]) => {
  let rest = text.trimStart();
  let consumedAny = false;
  for (const answer of answers) {
    const candidate = answer.text.trim();
    if (!candidate || !rest.startsWith(candidate)) continue;
    rest = rest.slice(candidate.length).trimStart();
    consumedAny = true;
  }
  return consumedAny ? rest : text;
};

const hungarianWords = new Set([
  "a",
  "az",
  "egy",
  "és",
  "hogy",
  "is",
  "meg",
  "már",
  "most",
  "nem",
  "van",
  "vagy",
  "kell",
  "ezt",
  "itt",
  "lett",
  "majd",
  "minden",
  "sikerült",
  "ellenőrzöm",
  "ellenőrzés",
]);

/** Language is a display fallback only; provider metadata remains authoritative. */
export const looksHungarianNarrative = (value: string) => {
  const words = value
    .toLocaleLowerCase("hu-HU")
    .match(/[a-záéíóöőúüű]+/giu) ?? [];
  const commonWordCount = words.filter((word) => hungarianWords.has(word)).length;
  const accentedWordCount = words.filter((word) => /[áéíóöőúüű]/iu.test(word)).length;
  return commonWordCount >= 2 || (commonWordCount >= 1 && accentedWordCount >= 1);
};

const technicalGroupLabel = (items: CompactTraceEvent[]) => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label =
      item.presentation === "reasoning"
        ? "gondolat"
        : item.presentation === "command"
          ? "parancs"
          : item.presentation === "tool"
            ? "eszköz"
            : item.presentation === "file"
              ? "fájlművelet"
              : "státusz";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const details = [...counts].map(([label, count]) => `${count} ${label}`);
  return `Technikai részletek — ${details.join(" • ")}`;
};

/**
 * Keeps Hungarian/user-facing narration prominent while reducing every run of
 * routine reasoning, command, tool and file events to one collapsed row.
 */
export const buildCompactTraceSections = (
  trace: CompactTraceEvent[],
): CompactTraceSection[] => {
  const sections: CompactTraceSection[] = [];
  let technical: CompactTraceEvent[] = [];
  const flushTechnical = () => {
    if (technical.length === 0) return;
    const items = technical;
    technical = [];
    sections.push({
      kind: "technical",
      id: `technical:${items[0].id}:${items.at(-1)!.id}`,
      items,
      label: technicalGroupLabel(items),
    });
  };
  for (const item of trace) {
    if (item.presentation === "narrative" || item.important) {
      flushTechnical();
      sections.push({ kind: "primary", id: item.id, item });
      continue;
    }
    technical.push(item);
  }
  flushTechnical();
  return sections;
};

/**
 * Provider-neutral projection for the compact response UI.
 *
 * Assistant deltas are grouped by provider item identity. Every trace event is
 * then assigned exactly once: to the first assistant output that follows it,
 * or to the live pending/final output at the end of the turn.
 */
export const buildCompactAnswerTimeline = ({
  answers,
  trace,
  finalAnswer,
  streaming,
  turnId,
}: CompactAnswerTimelineInput): CompactAnswerBlock[] => {
  const grouped = new Map<string, CompactAnswerEvent>();
  answers.forEach((answer, index) => {
    if (!answer.text.trim()) return;
    const key = `${answer.turnId ?? turnId ?? "turn"}:${answer.itemId ?? answer.id}`;
    const sequence = finiteSequence(answer.sequence, index + 1);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...answer, sequence });
      return;
    }
    existing.text += answer.text;
    existing.sequence = Math.min(
      finiteSequence(existing.sequence, sequence),
      sequence,
    );
    existing.live = existing.live || answer.live;
  });

  const orderedAnswers = [...grouped.values()].sort(
    (left, right) =>
      finiteSequence(left.sequence, Number.MAX_SAFE_INTEGER) -
        finiteSequence(right.sequence, Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
  );
  const orderedTrace = [...trace]
    .map((event, index) => ({
      ...event,
      sequence: finiteSequence(event.sequence, index + 0.5),
    }))
    .sort(
      (left, right) =>
        finiteSequence(left.sequence, 0) - finiteSequence(right.sequence, 0) ||
        left.id.localeCompare(right.id),
    );

  const blocks: CompactAnswerBlock[] = [];
  const usedTraceIds = new Set<string>();
  let previousBoundary = Number.NEGATIVE_INFINITY;
  const traceUntil = (boundary: number) =>
    orderedTrace.filter((event) => {
      const sequence = finiteSequence(event.sequence, 0);
      if (
        usedTraceIds.has(event.id) ||
        sequence <= previousBoundary ||
        sequence > boundary
      )
        return false;
      usedTraceIds.add(event.id);
      return true;
    });

  for (const answer of orderedAnswers) {
    const boundary = finiteSequence(
      answer.sequence,
      previousBoundary === Number.NEGATIVE_INFINITY ? 1 : previousBoundary + 1,
    );
    blocks.push({
      id: `answer:${answer.turnId ?? turnId ?? "turn"}:${answer.itemId ?? answer.id}`,
      turnId: answer.turnId ?? turnId,
      itemId: answer.itemId,
      sequenceStart: boundary,
      sequenceEnd: boundary,
      text: answer.text,
      final: false,
      live: Boolean(answer.live),
      pending: false,
      trace: traceUntil(boundary),
    });
    previousBoundary = boundary;
  }

  const finalText = finalAnswer?.text.trim()
    ? consumeAnswerPrefix(finalAnswer.text, orderedAnswers)
    : "";
  if (finalText.trim()) {
    const pendingIdentity = `next:${finalAnswer?.turnId ?? turnId ?? "turn"}`;
    blocks.push({
      id: streaming ? pendingIdentity : `final:${finalAnswer!.id}`,
      turnId: finalAnswer?.turnId ?? turnId,
      sequenceStart: previousBoundary,
      sequenceEnd: Number.POSITIVE_INFINITY,
      text: finalText,
      final: true,
      live: streaming || Boolean(finalAnswer?.live),
      pending: false,
      trace: traceUntil(Number.POSITIVE_INFINITY),
    });
  } else if (streaming) {
    blocks.push({
      id: `next:${finalAnswer?.turnId ?? turnId ?? "turn"}`,
      turnId: finalAnswer?.turnId ?? turnId,
      sequenceStart: previousBoundary,
      sequenceEnd: Number.POSITIVE_INFINITY,
      text: "",
      final: false,
      live: true,
      pending: true,
      trace: traceUntil(Number.POSITIVE_INFINITY),
    });
  } else if (blocks.length > 0 && finalAnswer?.text.trim()) {
    // A completed provider may repeat its final item as commentary and as the
    // turn result. Keep one visual block while retaining final-answer status.
    blocks[blocks.length - 1].final = true;
  }

  return blocks;
};
