/**
 * A sync állapotának emberi olvasatra fordítása.
 *
 * Tiszta formázók: se React, se alkalmazás-állapot. Az oldalsáv és a
 * megőrzési panel egyaránt ezeket használja, ezért nem tartozhatnak
 * egyikükhöz sem.
 */

/** Egy sírkő annyija, amennyi a megnevezéséhez kell — nem a teljes rekord. */
export type TombstoneContextLike = {
  projectId?: string | null;
  relativePath?: string | null;
  pathHint?: string | null;
};

export const formatSyncHealthTime = (value: string | null | undefined) => {
  if (!value) return "még nincs";
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return value;
  return new Intl.DateTimeFormat("hu-HU", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(timestamp));
};

export const syncHealthStatusLabel = (status: string) => {
  if (status === "healthy") return "Rendben · írható";
  if (status === "empty") return "Üres journal";
  if (status === "quarantine") return "Quarantine · csak olvasás";
  return status;
};

export const syncTombstoneTypeLabel = (entityType: string) =>
  entityType === "project" ? "Projekt" : "Beszélgetés";

export const syncTombstoneProjectContext = (
  tombstone: TombstoneContextLike,
) => {
  const path = tombstone.relativePath ?? tombstone.pathHint;
  const projectName = path
    ?.replace(/[\/]+$/, "")
    .split(/[\/]/)
    .filter(Boolean)
    .pop();
  if (projectName) return `Projekt: ${projectName}`;
  return tombstone.projectId
    ? `Projekt ID: ${tombstone.projectId.slice(0, 8)}`
    : "";
};
