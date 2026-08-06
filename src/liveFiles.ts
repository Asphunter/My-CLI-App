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

/**
 * A live-file path has two representations: the first spelling we show to the
 * user, and a canonical identity used for merging events. Claude, Codex and
 * the backfill path are allowed to disagree about slashes, `./` and casing;
 * none of those differences may create a second tab.
 */
export const canonicalLiveFilePath = (
  value: string,
  projectRoot?: string,
): string => {
  const normalize = (input: string) =>
    input.trim().replace(/^\\\\\?\\/, "").replaceAll("\\", "/");
  let path = normalize(value);
  const root = normalize(projectRoot ?? "").replace(/\/+$/, "");
  if (root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`))
    path = path.slice(root.length + 1);

  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length > 0) {
      const previous = segments.at(-1);
      if (previous && previous !== ".." && !/^[a-zA-Z]:$/.test(previous)) {
        segments.pop();
        continue;
      }
    }
    segments.push(segment);
  }
  return segments.join("/");
};

/** Case-folded identity; the display path keeps the first observed casing. */
export const liveFilePathKey = (value: string, projectRoot?: string) =>
  canonicalLiveFilePath(value, projectRoot).toLowerCase();

const dedupeLiveFiles = (files: LiveFile[]): LiveFile[] => {
  const result: LiveFile[] = [];
  const indexes = new Map<string, number>();
  for (const raw of files) {
    const path = canonicalLiveFilePath(raw.path);
    const key = liveFilePathKey(path);
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, result.length);
      result.push({ ...raw, path });
      continue;
    }
    const current = result[index];
    const newer = raw.sequence >= current.sequence ? raw : current;
    result[index] = {
      ...current,
      ...newer,
      path: current.path,
      closed: current.closed && raw.closed,
    };
  }
  return result;
};

/** A modell hozzányúlt egy fájlhoz: új fül, vagy a meglévő frissítése. */
export const touchLiveFile = (
  state: LiveFileState,
  touch: LiveFileTouch,
  projectRoot?: string,
): LiveFileState => {
  const path = canonicalLiveFilePath(touch.path, projectRoot);
  const key = liveFilePathKey(path);
  const existingFiles = dedupeLiveFiles(state.files);
  const existing = existingFiles.findIndex(
    (file) => liveFilePathKey(file.path) === key,
  );
  const targetPath = existing >= 0 ? existingFiles[existing].path : path;
  const files =
    existing >= 0
      ? existingFiles.map((file, index) =>
          index === existing
            ? {
                ...file,
                content: touch.content,
                streaming: touch.streaming,
                mode: touch.mode,
                highlight: touch.highlight ?? file.highlight,
                sequence: touch.sequence,
                // Amihez a modell újra hozzányúl, az visszakerül a sávra: a
                // bezárás azt jelentette, hogy addig nem érdekes.
                closed: false,
              }
            : file,
        )
      : [...existingFiles, { ...touch, path: targetPath }];
  const activePath = state.following
    ? targetPath
    : state.activePath
      ? files.find(
          (file) =>
            liveFilePathKey(file.path) === liveFilePathKey(state.activePath!),
        )?.path ?? state.activePath
      : targetPath;
  return {
    files,
    // A követés a munkát nézi; kézi választás után az olvasó marad, ahol van.
    activePath,
    following: state.following,
  };
};

/** Kézi fülválasztás: innentől az olvasó vezet, nem a futás. */
export const selectLiveFile = (
  state: LiveFileState,
  path: string,
): LiveFileState =>
  state.files.find((file) => liveFilePathKey(file.path) === liveFilePathKey(path))
    ? {
        ...state,
        activePath:
          state.files.find(
            (file) => liveFilePathKey(file.path) === liveFilePathKey(path),
          )?.path ?? path,
        following: false,
      }
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
  const key = liveFilePathKey(path);
  const index = state.files.findIndex(
    (file) => liveFilePathKey(file.path) === key,
  );
  if (index < 0) return state;
  const files = state.files.map((file) =>
    liveFilePathKey(file.path) === key ? { ...file, closed: true } : file,
  );
  if (liveFilePathKey(state.activePath ?? "") !== key)
    return { ...state, files };
  // A bezárt fül helyén a szomszédja marad, ahogy egy szerkesztőben szokás.
  const open = files.filter((file) => !file.closed);
  const next =
    open.find((file) => files.indexOf(file) > index) ?? open.at(-1) ?? null;
  return { files, activePath: next?.path ?? null, following: false };
};

/**
 * Sikertelen provider-iraskor az elo nezeti fajl nem valtozas: a modell csak
 * elkezdte kisugarozni a tervezett tartalmat, de az nem kerult lemezre.
 */
export const removeLiveFile = (
  state: LiveFileState,
  path: string,
): LiveFileState => {
  const key = liveFilePathKey(path);
  const files = state.files.filter(
    (file) => liveFilePathKey(file.path) !== key,
  );
  if (files.length === state.files.length) return state;
  const removedWasActive =
    liveFilePathKey(state.activePath ?? "") === key;
  return {
    ...state,
    files,
    activePath: removedWasActive
      ? files.filter((file) => !file.closed).at(-1)?.path ?? null
      : state.activePath,
  };
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
  return (
    open.find(
      (file) =>
        liveFilePathKey(file.path) === liveFilePathKey(state.activePath ?? ""),
    ) ?? open.at(-1)
  );
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
  // The disk can contain CRLF while a model sends LF (or the other way
  // around). Normalize only the live projection so the edit still lands on
  // its real file line instead of falling back to a patch at line 1.
  const displayBase = base.replace(/\r\n?/g, "\n");
  const displayOld = oldString.replace(/\r\n?/g, "\n");
  const displayNew = newString.replace(/\r\n?/g, "\n");
  if (!displayOld) return null;
  const at = displayBase.indexOf(displayOld);
  if (at < 0) return null;
  const content =
    displayBase.slice(0, at) +
    displayNew +
    displayBase.slice(at + displayOld.length);
  const from = displayBase.slice(0, at).split("\n").length;
  const inserted = displayNew.split("\n").length;
  return { content, highlight: { from, to: from + Math.max(0, inserted - 1) } };
};

/** Új fájl írásakor a kiemelés az egész tartalom. */
export const wholeFileHighlight = (content: string) => ({
  from: 1,
  to: Math.max(1, content.split("\n").length),
});
