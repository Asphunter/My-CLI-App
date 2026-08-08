/**
 * A FÁJLOK / VÁLTOZÁSOK panel nézeti logikája.
 *
 * A panel nyers listája érkezési sorrendben jön, és mindent egyformán mutat.
 * Egy 45 fájlos futáson mérve ez azt jelentette, hogy a `.gitignore +2`
 * vezetett, a `device.py +267` a 21. sor volt, 19 sor `+0 −0` zajt vitt (csupa
 * `.pyc`), a `ÚJ` badge és a `−0` oszlop pedig mind a 45 soron ott volt anélkül,
 * hogy bármit megkülönböztetett volna. Két `README.md` sor ráadásul
 * megkülönböztethetetlen volt, mert a panel csak a fájlnevet mutatja.
 *
 * Ez a modul csak rendez és címkéz — a lista tartalmát nem szűri: ami a
 * futásban változott, az mind megjelenik.
 */

export type ChangeSummaryRow = {
  path: string;
  status: "modified" | "added" | "removed";
  added: number;
  removed: number;
  sourcePath?: string;
};

/** Mennyit mozdult a fájl. Ez adja a sorrendet, nem az érkezés vagy a név. */
export const churnOf = (file: Pick<ChangeSummaryRow, "added" | "removed">) =>
  file.added + file.removed;

/**
 * Csak a fájlnév. A hash-elt, mély útvonalak (`.gradle-check/native/1def…/…`)
 * szélesebbre nyomták a panelt, mint a válasz maga.
 */
export const fileNameOf = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Fájlnév a szülőmappájával — ütköző nevek feloldására. */
const withParentDir = (path: string) => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts.slice(-2).join("/") : (parts.at(-1) ?? path);
};

/**
 * Soronkénti címke. Ahol két fájl neve egybeesne (két `README.md` külön
 * mappából), ott a szülőmappa is kiíródik — enélkül a két sor csak a
 * számaiban különbözik, és nem lehet eldönteni, melyik melyik.
 */
export const changeRowLabels = (files: readonly ChangeSummaryRow[]) => {
  const nameCounts = new Map<string, number>();
  for (const file of files) {
    const name = fileNameOf(file.path);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  return files.map((file) => {
    const name = fileNameOf(file.path);
    return (nameCounts.get(name) ?? 0) > 1 ? withParentDir(file.path) : name;
  });
};

/**
 * Churn szerint csökkenő, döntetlennél név szerint. A rendezés stabil és
 * determinisztikus: ugyanaz a lista ugyanabban a sorrendben jelenik meg két
 * renderelés között is.
 */
export const sortChangeSummary = <T extends ChangeSummaryRow>(
  files: readonly T[],
): T[] =>
  [...files].sort((left, right) => {
    const byChurn = churnOf(right) - churnOf(left);
    if (byChurn !== 0) return byChurn;
    return fileNameOf(left.path).localeCompare(fileNameOf(right.path));
  });

/**
 * A panel megjelenítendő alakja: az érdemi sorok elöl, a nulla-változásúak
 * (jellemzően generált melléktermék: `.pyc`, lockfile, cache) egyetlen,
 * alapból csukott csoportban a végén.
 *
 * Fontos: ez **nem** a régi „fejléc + 5 sor" korlát visszahozása. Az
 * darabszám szerint vágott, és érdemi fájlokat is elrejtett; ez churn szerint
 * választ, tehát amit a futás ténylegesen írt, az mindig látszik.
 */
export const changeSummaryView = <T extends ChangeSummaryRow>(
  files: readonly T[],
) => {
  const sorted = sortChangeSummary(files);
  const changed = sorted.filter((file) => churnOf(file) > 0);
  const untouched = sorted.filter((file) => churnOf(file) === 0);
  return {
    changed,
    untouched,
    /** Van-e egyáltalán törlés — enélkül a `−0` oszlop csak zaj. */
    showRemoved: files.some((file) => file.removed > 0),
    /**
     * Az ÚJ/TÖRÖLT badge csak akkor mond valamit, ha a listában többféle
     * státusz van. Ha minden fájl új, a badge mind a 45 soron ugyanaz.
     */
    showStatus: new Set(files.map((file) => file.status)).size > 1,
  };
};
