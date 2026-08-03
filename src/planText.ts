/**
 * A terv szövegének olvasása.
 *
 * A lánc terv-szakasza egy MD-fájlt ír, és minden más ebből él: a LÉPÉSEK
 * listája a számozott fő pontokból, a RAW nézet pedig ugyanezeket külön
 * kiemelhető blokkokként tartja meg. Egy szöveg, egy lista.
 */

const NUMBERED_LINE = /^(\d+)[.)]\s+\S/;
const HEADING_LINE = /^#{1,6}\s/;

/**
 * A terv fő lépés-futamának sorindexei.
 *
 * A tervben nem csak a lépések számozottak: a Kockázatok szakasz pontjait is
 * be szokta számozni a modell, és a „minden számozott sor lépés" olvasat a
 * 8 lépés mellé 4-6 kockázatot is a LÉPÉSEK listára tett. Egy lépés-futam
 * összefüggően számozódik (minden sor az előző +1), és nem szakítja meg
 * fejléc — a Kockázatok újra 1-ről indul és `##` cím előzi meg, tehát külön
 * futam. A leghosszabb futam a lépéslista; egyenlőségnél a korábbi.
 */
const mainStepRun = (lines: string[]): number[] => {
  type NumberedRow = { index: number; number: number };
  const runs: NumberedRow[][] = [];
  let headingSinceLast = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (HEADING_LINE.test(trimmed)) {
      headingSinceLast = true;
      continue;
    }
    const match = trimmed.match(NUMBERED_LINE);
    if (!match) continue;
    const number = Number(match[1]);
    const current = runs[runs.length - 1];
    const previous = current?.[current.length - 1];
    if (previous && !headingSinceLast && number === previous.number + 1) {
      current.push({ index, number });
    } else {
      runs.push([{ index, number }]);
    }
    headingSinceLast = false;
  }
  let best: NumberedRow[] = [];
  for (const run of runs) if (run.length > best.length) best = run;
  return best.map((row) => row.index);
};

type PlanStepRange = {
  from: number;
  to: number;
};

const planStepRanges = (lines: string[]): PlanStepRange[] => {
  const starts = mainStepRun(lines);
  return starts.map((from, stepIndex) => {
    if (stepIndex + 1 < starts.length)
      return { from, to: starts[stepIndex + 1] };
    let to = lines.length;
    for (let index = from + 1; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (HEADING_LINE.test(trimmed) || NUMBERED_LINE.test(trimmed)) {
        to = index;
        break;
      }
    }
    return { from, to };
  });
};

export type PlanTextSegment =
  | { kind: "context"; text: string }
  | { kind: "step"; text: string; stepIndex: number; number: number };

/**
 * The complete plan as renderable blocks. Numbered main steps stay distinct so
 * the UI can highlight one of them without replacing the full RAW document.
 */
export const planTextSegments = (text: string): PlanTextSegment[] => {
  const lines = text.split(/\r?\n/);
  const ranges = planStepRanges(lines);
  if (ranges.length === 0)
    return text.trim() ? [{ kind: "context", text: text.trim() }] : [];
  const segments: PlanTextSegment[] = [];
  let cursor = 0;
  ranges.forEach((range, stepIndex) => {
    const before = lines.slice(cursor, range.from).join("\n").trim();
    if (before) segments.push({ kind: "context", text: before });
    const stepText = lines.slice(range.from, range.to).join("\n").trim();
    if (stepText)
      segments.push({
        kind: "step",
        text: stepText,
        stepIndex,
        number: stepIndex + 1,
      });
    cursor = range.to;
  });
  const after = lines.slice(cursor).join("\n").trim();
  if (after) segments.push({ kind: "context", text: after });
  return segments;
};

/**
 * A terv szövegének az a szelete, ami az adott sorszámú ponthoz tartozik: a
 * számozott sorától a futam következő pontjáig; az utolsó pontnál a következő
 * fejlécig vagy számozott sorig (hogy a Kockázatok ne ragadjon hozzá).
 */
export const planStepSlice = (text: string, stepIndex: number) => {
  const lines = text.split(/\r?\n/);
  const ranges = planStepRanges(lines);
  if (stepIndex < 0 || stepIndex >= ranges.length) return "";
  const { from, to } = ranges[stepIndex];
  return lines.slice(from, to).join("\n").trim();
};

/** A terv lépés-futamának sorai, nyersen — a lépés-következtetés ezekben keres. */
export const numberedPlanLines = (text: string) => {
  const lines = text.split(/\r?\n/);
  return mainStepRun(lines).map((index) => lines[index].trim());
};

/**
 * Egy terv-pont rövid címe. A pontok `1. **Cím** – hosszú magyarázat` alakúak;
 * a LÉPÉSEK listába a cím való, a magyarázat pedig a teljes RAW terv
 * kiemelhető blokkjába. Cím nélkül a hat pont hat bekezdésként állt egymás alatt: a lista
 * a terv szó szerinti másolata volt.
 */
export const planStepTitle = (line: string) => {
  const body = line
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^#+\s*/, "")
    .trim();
  const bold = body.match(/^\*\*(.+?)\*\*/) ?? body.match(/^__(.+?)__/);
  // Vastag fej nélkül az első gondolatjel vagy kettőspont a cím határa. A
  // kötőjel csak szóközök között választ — a „Smith-chart" egy szó marad.
  const head = bold ? bold[1] : body.split(/\s+[–—]\s+|\s+-\s+|:\s+/)[0];
  // A szó belseji aláhúzás nem kiemelés, hanem a név része: a
  // `smith_tline_anim.py`-ból „smithtlineanim.py" lett a listán. Csak a
  // szóhatáron álló (markdown-kiemelő) aláhúzás esik ki; a záró írásjelek
  // közé a mondatzáró pont is beletartozik.
  const clean = head
    .replace(/[`*]/g, "")
    .replace(/(^|\s)_+/g, "$1")
    .replace(/_+(\s|$)/g, "$1")
    .replace(/[\s:.–—-]+$/, "")
    .trim();
  const title = clean || body.replace(/[`*]/g, "").trim();
  return title.length > 90 ? `${title.slice(0, 88).trimEnd()}…` : title;
};

/** A terv számozott fő pontjai — a LÉPÉS lista közös forrása. */
export const numberedPlanSteps = (text: string) =>
  numberedPlanLines(text).map((line, index) => ({
    id: `carried-plan-${index}`,
    step: planStepTitle(line),
  }));
