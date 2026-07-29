/**
 * Képletek felismerése a modellek szövegében.
 *
 * A tervek és a válaszok TeX-jelöléssel írják a képleteket — `\(...\)`,
 * `\[...\]`, `$$...$$`, néha `$...$` —, és eddig nyersen látszottak:
 * `\Gamma_L=\frac{50-100}{50+100}` a szöveg közepén. Ez a modul csak
 * felismeri és rendbe teszi a kifejezést; a kirendelés a KaTeX dolga.
 */

/**
 * A `$...$` csak akkor képlet, ha van benne TeX-re utaló jel (`\`, `^`, `_`,
 * kapcsos zárójel). Enélkül a „bruttó $5 és $10 között" is képletnek látszana,
 * és a szöveg közepe eltűnt volna egy piros hibajelzésben.
 */
export const mathPattern =
  /\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$\$[\s\S]+?\$\$|\$[^\n$]*[\\^_{}][^\n$]*\$/;

/**
 * A modellek néha kétszer escape-elik a vezérjeleket (`\\Omega`, `\\,`), és a
 * TeX ebből sortörést olvasna. Betű vagy írásjel előtt a dupla visszaper
 * sosem szándékos, tehát egyre húzzuk vissza; a mátrixok soremelése (`\\` után
 * szóköz vagy sorvég) érintetlen marad.
 */
const normalizeTex = (body: string) =>
  body.replace(/\\\\(?=[A-Za-z,;:!])/g, "\\").trim();

export type MathExpression = { tex: string; display: boolean };

/** Egy illeszkedő tokenből a kifejezés, vagy `null`, ha mégsem képlet. */
export const parseMath = (value: string): MathExpression | null => {
  const display =
    (value.startsWith("\\[") && value.endsWith("\\]")) ||
    (value.startsWith("$$") && value.endsWith("$$"));
  const inline =
    (value.startsWith("\\(") && value.endsWith("\\)")) ||
    (!display && value.startsWith("$") && value.endsWith("$"));
  if (!display && !inline) return null;
  const body =
    display || value.startsWith("\\(")
      ? value.slice(2, -2)
      : value.slice(1, -1);
  const tex = normalizeTex(body);
  return tex ? { tex, display } : null;
};
