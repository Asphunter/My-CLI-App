/**
 * Félkész JSON-ból olvasott string mező.
 *
 * A modell az eszközhívás bemenetét darabokban küldi (`input_json_delta`): a
 * `{"file_path":"…","content":"…` sosem áll össze egyben, amíg a hívás tart.
 * Az élő kódnézet viszont pont a *közben* látszó tartalomból él, ezért a
 * növekvő nyers szövegből ki kell tudni venni egy mező eddigi értékét.
 *
 * Nem teljes JSON-elemző: egyetlen string mezőt keres, és annyit dekódol
 * belőle, amennyi hiánytalanul megérkezett. A darabhatár bárhol lehet — akár
 * egy escape-szekvencia közepén —, ezért a végén álló csonka escape kimarad,
 * és a következő darabbal együtt jelenik meg. A dekódolás a hídé: a felület
 * sosem lát félkész JSON-t, csak szöveget.
 */

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SIMPLE_ESCAPES = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Egy string mező jelenlegi értéke a növekvő JSON-pufferből.
 *
 * `null`, ha a mező kulcsa (a nyitó idézőjelig) még meg sem érkezett — ez nem
 * hiba, csak annyit jelent, hogy még nincs mit mutatni. Egyébként `{ value,
 * complete }`: az érték az eddig biztos rész, a `complete` pedig azt mondja
 * meg, hogy a string lezárult-e (onnantól már nem változik).
 */
export function streamedStringField(buffer, field) {
  const opening = new RegExp(`"${escapeForRegExp(field)}"\\s*:\\s*"`).exec(buffer);
  if (!opening) return null;
  let index = opening.index + opening[0].length;
  let value = "";
  while (index < buffer.length) {
    const char = buffer[index];
    if (char === '"') return { value, complete: true };
    if (char !== "\\") {
      value += char;
      index += 1;
      continue;
    }
    // Az escape a puffer végén csonka lehet: a jelölő megjött, a jelentése
    // még nem. Ilyenkor a mostani érték az, ami biztos.
    if (index + 1 >= buffer.length) return { value, complete: false };
    const marker = buffer[index + 1];
    if (marker === "u") {
      const digits = buffer.slice(index + 2, index + 6);
      if (digits.length < 4) return { value, complete: false };
      const code = Number.parseInt(digits, 16);
      if (Number.isNaN(code)) return { value, complete: false };
      value += String.fromCharCode(code);
      index += 6;
      continue;
    }
    // Ismeretlen escape: a JSON szerint hibás, de a folyamot nem állítjuk meg
    // egy karakter miatt — a jelölt karakter önmagát jelenti.
    value += SIMPLE_ESCAPES[marker] ?? marker;
    index += 2;
  }
  return { value, complete: false };
}
