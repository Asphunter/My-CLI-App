/**
 * A DeepSeek futás közbeni válasz-szövegének bontása bulletpontokra.
 *
 * A DeepSeek a szerszámhívások közé írt rövid mondatait („Telepítés sikeres —
 * az APK a telefonon van. Folytatom a füstteszttel:") tagolás nélkül fűzi
 * egymás után, így egyetlen, egyre hosszabb szövegtömb lesz belőlük a VÁLASZ
 * panelben, és nem látszik, hol ér véget az egyik gondolat. Ez a bontás
 * soronként külön bulletet ad nekik.
 *
 * Csak a DeepSeek megy át ezen. A többi szolgáltató saját markdown-szerkezetet
 * ír (címsorok, listák, kódblokkok), és a sor-bullet arra ráültetve dupla
 * felsorolást adna; ugyanezért a lezárt válasz sem megy át rajta sehol.
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
