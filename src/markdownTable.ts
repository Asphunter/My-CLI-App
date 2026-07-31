/**
 * Markdown-táblák felismerése a válaszszövegben.
 *
 * A modellek táblában adják vissza a fájl/tartalom, paraméter/érték jellegű
 * felsorolást. Nyersen kiírva ez `|---|---|` sorokká esik szét: a keret
 * karakterei kerülnek a képernyőre a szerkezet helyett. Itt csak a felismerés
 * történik — a kirendelés a hívóé.
 */

/** Egy táblasor cellái. A szélső üres cellák a keret, nem tartalom. */
export const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** A `|---|:--:|` alakú sor a fejléc és a törzs határa, nem tartalom. */
export const isTableSeparator = (line: string) =>
  line.includes("|") &&
  line.includes("-") &&
  tableCells(line).every((cell) => /^:?-+:?$/.test(cell));

/** Táblasor-e egyáltalán: cellahatár nélkül nincs mit sorba rendezni. */
export const isTableRow = (line: string) => line.trim().includes("|");

export type MarkdownTable = {
  header: string[];
  rows: string[][];
  /** Az első sor, ami már nem a tábláé. */
  end: number;
};

/**
 * A `start` indextől kezdődő tábla, ha ott tábla kezdődik.
 *
 * A fejlécet kötelezően szeparátor követi — enélkül egy sima, csővel tagolt
 * mondat is táblává állna össze. Két oszlop az alsó határ: egyetlen oszlopnál
 * a tábla nem mond többet a bekezdésnél.
 */
export const markdownTableAt = (
  lines: string[],
  start: number,
): MarkdownTable | null => {
  if (start + 1 >= lines.length) return null;
  if (!isTableRow(lines[start]) || isTableSeparator(lines[start])) return null;
  if (!isTableSeparator(lines[start + 1])) return null;
  const header = tableCells(lines[start]);
  if (header.length < 2) return null;
  const rows: string[][] = [];
  let index = start + 2;
  for (; index < lines.length; index += 1) {
    if (!isTableRow(lines[index]) || isTableSeparator(lines[index])) break;
    rows.push(tableCells(lines[index]));
  }
  return { header, rows, end: index };
};
