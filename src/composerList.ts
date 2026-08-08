/**
 * Számozott lista a composerben: folytatás, szintváltás és kilépés.
 *
 * A korábbi viselkedés csak folytatni tudott (`1)` → `2)` → …), kilépni nem:
 * egy lista után minden Shift+Enter újabb sorszámot rakott ki, tehát nem lehetett
 * lista alatt sima bekezdést írni. Két szint van: számok a külső, betűk a beljebb
 * húzott szinten — ennél mélyebbre a chatben úgysem megy senki.
 */

const NUMBERED = /^(\s*)(\d+)\)(\s?)(.*)$/;
const LETTERED = /^(\s*)([a-z])\)(\s?)(.*)$/;

/** Egy `1) ` marker szélessége — a betűs szint pont alá húzódik be. */
const INDENT = "   ";

export type ComposerEdit = {
  /** A csere kezdete a teljes szövegben. */
  from: number;
  /** A csere vége (a kurzor). */
  to: number;
  /** A beírandó szöveg. */
  text: string;
};

/** A kurzort tartalmazó sor kezdete és a kurzorig tartó része. */
export const currentLine = (value: string, cursor: number) => {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  return { start, text: value.slice(start, cursor) };
};

const nextLetter = (letter: string) =>
  letter >= "z" ? "z" : String.fromCharCode(letter.charCodeAt(0) + 1);

/**
 * A beljebb húzott blokk fölötti számozott szint következő sorszáma: kilépéskor
 * ide tér vissza a lista, nem 1-ről kezdi újra.
 */
const parentNumberAfter = (value: string, lineStart: number) => {
  const lines = value.slice(0, lineStart).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const numbered = NUMBERED.exec(lines[index]);
    if (numbered) return Number(numbered[2]) + 1;
  }
  return 1;
};

/**
 * Shift+Enter a listában. `null`, ha a sor nem listaelem — a hívó ilyenkor
 * hagyja érvényesülni a sima soremelést.
 */
export const listBreak = (value: string, cursor: number): ComposerEdit | null => {
  const { start, text: line } = currentLine(value, cursor);
  const numbered = NUMBERED.exec(line);
  const lettered = LETTERED.exec(line);
  const match = numbered ?? lettered;
  if (!match) return null;

  // Üres listaelem = kilépési szándék. Betűsnél egy szinttel feljebb, számosnál
  // ki a listából: a marker eltűnik, és sima új sor jön helyette.
  if (!match[4].trim()) {
    if (lettered)
      return {
        from: start,
        to: cursor,
        text: `${parentNumberAfter(value, start)}) `,
      };
    // A marker eltűnik, a kurzor az így üresen maradt soron marad — innen sima
    // bekezdés írható, nem kell még egy soremelés.
    return { from: start, to: cursor, text: "" };
  }

  const marker = numbered
    ? `${Number(numbered[2]) + 1})`
    : `${nextLetter(lettered![2])})`;
  return { from: cursor, to: cursor, text: `\n${match[1]}${marker} ` };
};

/**
 * Tab / Shift+Tab a listában: a számozott elem betűssé és beljebb húzottá válik,
 * visszafelé pedig újra számozottá. `null`, ha a sor nem listaelem.
 */
export const listIndent = (
  value: string,
  cursor: number,
  direction: "in" | "out",
): ComposerEdit | null => {
  const { start, text: line } = currentLine(value, cursor);
  const numbered = NUMBERED.exec(line);
  const lettered = LETTERED.exec(line);
  if (direction === "in") {
    if (!numbered) return null;
    return {
      from: start,
      to: cursor,
      text: `${numbered[1]}${INDENT}a) ${numbered[4]}`,
    };
  }
  if (!lettered) return null;
  const outdented = lettered[1].slice(
    0,
    Math.max(0, lettered[1].length - INDENT.length),
  );
  return {
    from: start,
    to: cursor,
    text: `${outdented}${parentNumberAfter(value, start)}) ${lettered[4]}`,
  };
};
