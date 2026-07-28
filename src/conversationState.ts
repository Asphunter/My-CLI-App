/**
 * Beszélgetés-ID-vel címzett állapot.
 *
 * A cross-conversation hiba oka nem hiányzó guard volt, hanem az, hogy minden
 * írás a *nézetnek* szólt: „ami épp a képernyőn van". Váltás közben a nézet és
 * az író órája szükségszerűen széttart, ezért egy futó válasz idegen
 * beszélgetésbe került — és a mentőhurok véglegesítette a lemezen.
 *
 * Itt a címzés explicit: minden írás megnevezi a tulajdonos beszélgetést. A
 * nézet ebből csak *kiválaszt*; sosem ő a tárolás forrása. A gazdátlan írás
 * nem „mindenhová", hanem sehová megy.
 */

/** A tárolt slice-ok egy beszélgetésre. A konkrét sortípusokat a hívó adja. */
export type ConversationRecords<Record_> = Record<string, Record_>;

/** Írás célja a tulajdonos és az épp nézett beszélgetés viszonyából. */
export type WriteTarget = "store-and-view" | "store-only" | "drop";

/**
 * A címzés egyetlen döntése.
 *
 * - gazdátlan írás → eldobás (a korábbi default — „ha nincs gazda, mindenhol
 *   látszik" — pont a szivárgást engedte át);
 * - a tulajdonos az épp nézett beszélgetés → tárba és nézetbe;
 * - más beszélgetés → csak tárba, a nézet nem mozdul.
 */
export const writeTarget = (
  ownerId: string | null | undefined,
  viewId: string | null | undefined,
): WriteTarget => {
  const owner = ownerId?.trim();
  if (!owner) return "drop";
  return owner === viewId?.trim() ? "store-and-view" : "store-only";
};

export const readConversation = <Record_,>(
  store: ConversationRecords<Record_>,
  conversationId: string | null | undefined,
): Record_ | undefined => {
  const id = conversationId?.trim();
  return id ? store[id] : undefined;
};

/**
 * Címzett írás a tárba. Gazdátlan írásra a tár változatlanul tér vissza —
 * ugyanaz a referencia, tehát a React sem renderel újra miatta.
 */
export const writeConversation = <Record_,>(
  store: ConversationRecords<Record_>,
  conversationId: string | null | undefined,
  update: (current: Record_ | undefined) => Record_,
): ConversationRecords<Record_> => {
  const id = conversationId?.trim();
  if (!id) return store;
  const next = update(store[id]);
  if (next === store[id]) return store;
  return { ...store, [id]: next };
};

export const forgetConversation = <Record_,>(
  store: ConversationRecords<Record_>,
  conversationId: string | null | undefined,
): ConversationRecords<Record_> => {
  const id = conversationId?.trim();
  if (!id || !(id in store)) return store;
  const next = { ...store };
  delete next[id];
  return next;
};

/**
 * A render-kulcs (`${project.path}/${title}`) írásmódja gépenként és
 * rétegenként eltér: a store kanonizált `\\?\C:\…` alakot ír, a böngésző-cache
 * sima `C:\…`-t. Ez a normalizálás az egyetlen igazság a kulcs-hasonlításra.
 */
export const normalizeConversationKey = (key: string) =>
  key
    .replaceAll("/", "\\")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\+$/, "")
    .toLowerCase();

export const conversationKeyParts = (key: string) => {
  const normalized = normalizeConversationKey(key);
  const separator = normalized.lastIndexOf("\\");
  return {
    path: separator >= 0 ? normalized.slice(0, separator) : "",
    title: separator >= 0 ? normalized.slice(separator + 1) : normalized,
  };
};

const keyPathTail = (path: string) =>
  path.split("\\").filter(Boolean).slice(-3).join("\\");

/** Két kulcs ugyanazt a beszélgetést nevezi meg, írásmódtól függetlenül. */
export const conversationKeysMatch = (left: string, right: string) => {
  if (normalizeConversationKey(left) === normalizeConversationKey(right))
    return true;
  const leftParts = conversationKeyParts(left);
  const rightParts = conversationKeyParts(right);
  if (leftParts.title !== rightParts.title) return false;
  const leftTail = keyPathTail(leftParts.path);
  const rightTail = keyPathTail(rightParts.path);
  if (!leftTail || !rightTail) return false;
  return leftParts.path.endsWith(rightTail) || rightParts.path.endsWith(leftTail);
};

/**
 * Kulcs → beszélgetés-ID. Előbb pontos, aztán írásmód-toleráns egyezés: az
 * exact-string lookup csendes eldobása volt az egyik módja annak, hogy egy
 * írás sehol se érkezzen meg.
 */
export const conversationIdForKey = (
  index: Record<string, string>,
  key: string,
): string | null => {
  const direct = index[key];
  if (direct?.trim()) return direct.trim();
  for (const [candidate, id] of Object.entries(index)) {
    if (id?.trim() && conversationKeysMatch(candidate, key)) return id.trim();
  }
  return null;
};

/**
 * A kulcs→ID index az elnevezett beszélgetésekből. Egy ID több kulcson is
 * szerepelhet (átnevezés, kanonizált path), az olvasás ezt elviseli.
 */
export const conversationKeyIndex = (
  cache: Record<string, { id?: string | null }>,
): Record<string, string> => {
  const index: Record<string, string> = {};
  for (const [key, value] of Object.entries(cache)) {
    const id = value?.id?.trim();
    if (id) index[key] = id;
  }
  return index;
};
