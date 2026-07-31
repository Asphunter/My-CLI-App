/**
 * Az élő kódnézet állapota: melyik fájlokat érintette a futás, mit tartalmaznak
 * most, és melyik van a szemünk előtt.
 *
 * A fülek gyűlnek: amelyik fájlhoz a modell hozzányúlt, az fent marad, és az
 * új fájl mellé kerül — nem helyette. A nézet alapból követi a munkát, de egy
 * kézi fülválasztás megállítja a követést: aki olvas valamit, azt ne rángassa
 * el a következő fájl. Ugyanaz az elv, mint a lépéslistánál.
 */

export type LiveFileMode = "write" | "edit";

export type LiveFile = {
  /** Projektgyökérhez képesti útvonal — ez a fül azonossága is. */
  path: string;
  /** A fájl tartalma, ahogy most áll. Írás közben ez a leírt előtag. */
  content: string;
  /** Ír-e még bele a modell. */
  streaming: boolean;
  mode: LiveFileMode;
  /** A változás sorai (1-alapú, zárt intervallum) a kiemeléshez. */
  highlight?: { from: number; to: number };
  /** Hányadik érintés — a fülek sorrendje. */
  sequence: number;
  /** Az olvasó levette a sávról. A fájl megmarad, csak nem látszik. */
  closed?: boolean;
};

export type LiveFileState = {
  files: LiveFile[];
  activePath: string | null;
  /** Ráálljon-e magától arra a fájlra, amelyiken a modell épp dolgozik. */
  following: boolean;
};

export const EMPTY_LIVE_FILES: LiveFileState = {
  files: [],
  activePath: null,
  following: true,
};

export type LiveFileTouch = {
  path: string;
  content: string;
  streaming: boolean;
  mode: LiveFileMode;
  highlight?: { from: number; to: number };
  sequence: number;
};

/** A modell hozzányúlt egy fájlhoz: új fül, vagy a meglévő frissítése. */
export const touchLiveFile = (
  state: LiveFileState,
  touch: LiveFileTouch,
): LiveFileState => {
  const existing = state.files.findIndex((file) => file.path === touch.path);
  const files =
    existing >= 0
      ? state.files.map((file, index) =>
          index === existing
            ? {
                ...file,
                content: touch.content,
                streaming: touch.streaming,
                mode: touch.mode,
                highlight: touch.highlight ?? file.highlight,
                // Amihez a modell újra hozzányúl, az visszakerül a sávra: a
                // bezárás azt jelentette, hogy addig nem érdekes.
                closed: false,
              }
            : file,
        )
      : [...state.files, { ...touch }];
  return {
    files,
    // A követés a munkát nézi; kézi választás után az olvasó marad, ahol van.
    activePath: state.following ? touch.path : (state.activePath ?? touch.path),
    following: state.following,
  };
};

/** Kézi fülválasztás: innentől az olvasó vezet, nem a futás. */
export const selectLiveFile = (
  state: LiveFileState,
  path: string,
): LiveFileState =>
  state.files.some((file) => file.path === path)
    ? { ...state, activePath: path, following: false }
    : state;

/** Vissza a munkához: a legutóbb érintett fájl, és a követés újraindul. */
export const followLiveFiles = (state: LiveFileState): LiveFileState => ({
  ...state,
  activePath:
    state.files.filter((file) => !file.closed).at(-1)?.path ?? state.activePath,
  following: true,
});

/**
 * Fül bezárása.
 *
 * A fájl nem vész el, csak lekerül a sávról: a futás akkor is hozzányúlt, ha
 * az olvasó épp nem kíváncsi rá. Az utolsó fül bezárása így nem tünteti el a
 * panelt — visszahozható marad.
 */
export const closeLiveFile = (
  state: LiveFileState,
  path: string,
): LiveFileState => {
  const index = state.files.findIndex((file) => file.path === path);
  if (index < 0) return state;
  const files = state.files.map((file) =>
    file.path === path ? { ...file, closed: true } : file,
  );
  if (state.activePath !== path) return { ...state, files };
  // A bezárt fül helyén a szomszédja marad, ahogy egy szerkesztőben szokás.
  const open = files.filter((file) => !file.closed);
  const next =
    open.find((file) => files.indexOf(file) > index) ?? open.at(-1) ?? null;
  return { files, activePath: next?.path ?? null, following: false };
};

/** Minden elrejtett fül vissza a sávra. */
export const reopenLiveFiles = (state: LiveFileState): LiveFileState => {
  const files = state.files.map((file) => ({ ...file, closed: false }));
  return {
    files,
    activePath: state.activePath ?? files.at(-1)?.path ?? null,
    following: state.following,
  };
};

/** Ami a fülsávon látszik. */
export const openLiveFiles = (state: LiveFileState) =>
  state.files.filter((file) => !file.closed);

export const activeLiveFile = (state: LiveFileState) => {
  const open = openLiveFiles(state);
  return open.find((file) => file.path === state.activePath) ?? open.at(-1);
};

/**
 * Egy `Edit` hívás vetülete a fájlra.
 *
 * A szerkesztés csak egy foltot ad (mit mire), a fül viszont a *fájlt* mutatja.
 * A foltot a lemezen álló tartalomra illesztjük, és megmondjuk, mely sorokra
 * esett — azokat emeli ki a nézet. Ha a keresett szöveg nincs meg (a lemez
 * időközben elmozdult), `null` a válasz: ilyenkor a hívó a foltot mutatja meg
 * ahelyett, hogy félrevezető fájlt rajzolna.
 */
export const applyEditToFile = (
  base: string,
  oldString: string,
  newString: string,
): { content: string; highlight: { from: number; to: number } } | null => {
  if (!oldString) return null;
  const at = base.indexOf(oldString);
  if (at < 0) return null;
  const content = base.slice(0, at) + newString + base.slice(at + oldString.length);
  const from = base.slice(0, at).split("\n").length;
  const inserted = newString.split("\n").length;
  return { content, highlight: { from, to: from + Math.max(0, inserted - 1) } };
};

/** Új fájl írásakor a kiemelés az egész tartalom. */
export const wholeFileHighlight = (content: string) => ({
  from: 1,
  to: Math.max(1, content.split("\n").length),
});
