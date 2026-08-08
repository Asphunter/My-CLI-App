/**
 * A futás közbeni válasz-szöveg bontása bulletpontokra.
 *
 * Egy kódoló futás alatt a modell a szerszámhívások közé rövid mondatokat ír
 * („Telepítés sikeres — az APK a telefonon van. Folytatom a füstteszttel:"),
 * és ezek egyetlen, egyre hosszabb szövegtömbbé fűződnek össze a VÁLASZ
 * panelben. Így nem látszik, hol ér véget az egyik gondolat és hol kezdődik a
 * következő. Ez a bontás soronként külön bulletet ad nekik.
 *
 * A lezárt válasz **nem** megy át ezen: annak saját szerkezete van (címsorok,
 * listák, kódblokkok), és azt a rendes markdown-renderelő rajzolja.
 */

/** Egy sor önálló gondolat — kivéve a kódblokkokat, azok egyben maradnak. */
export const liveNarrationLines = (text: string): string[] => {
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let fence: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const joined = buffer.join("\n").trim();
    if (joined) chunks.push(joined);
    buffer = [];
  };

  for (const line of lines) {
    // A nyitó és a záró kerítés is a blokk része marad, hogy a markdown
    // renderelő kódblokknak lássa.
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      buffer.push(line);
      if (fenceMatch && line.trim().startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      buffer.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // Kerítésen kívül minden nem üres sor önálló bullet.
    buffer.push(line);
    flush();
  }
  flush();
  return chunks;
};
