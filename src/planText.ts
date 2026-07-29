/**
 * A terv szövegének olvasása.
 *
 * A lánc terv-szakasza egy MD-fájlt ír, és minden más ebből él: a LÉPÉSEK
 * listája a számozott fő pontokból, a DETAIL nézet egy pont szeletéből, a
 * kódoló szakasz pedig ugyanezt a listát örökli. Egy szöveg, egy lista.
 */

const NUMBERED_LINE = /^\d+[.)]\s+\S/;

/** Legfeljebb ennyi pontot vesz át a lista — egy elszabadult felsorolás nem
 *  nyomhatja szét a panelt. */
const MAX_STEPS = 12;

/**
 * A terv szövegének az a szelete, ami az adott sorszámú ponthoz tartozik: a
 * számozott sorától a következő számozott sorig (vagy a szöveg végéig).
 */
export const planStepSlice = (text: string, stepIndex: number) => {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (NUMBERED_LINE.test(line.trim())) starts.push(index);
  });
  if (stepIndex < 0 || stepIndex >= starts.length) return "";
  const from = starts[stepIndex];
  const to = stepIndex + 1 < starts.length ? starts[stepIndex + 1] : lines.length;
  return lines.slice(from, to).join("\n").trim();
};

/** A terv számozott sorai, nyersen — a lépés-következtetés ezekben keres. */
export const numberedPlanLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => NUMBERED_LINE.test(line))
    .slice(0, MAX_STEPS);

/**
 * Egy terv-pont rövid címe. A pontok `1. **Cím** – hosszú magyarázat` alakúak;
 * a LÉPÉSEK listába a cím való, a magyarázat a RAW nézetbe és a DETAIL
 * szeletébe. Cím nélkül a hat pont hat bekezdésként állt egymás alatt: a lista
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
  const clean = head
    .replace(/[`*_]/g, "")
    .replace(/[\s:–—-]+$/, "")
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
