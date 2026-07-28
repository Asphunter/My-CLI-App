/**
 * Determinisztikus sor-azonosítók — ugyanaz a képlet, mint a Rust oldalon.
 *
 * Egy válasznak eddig két azonossága volt: a runtime a `(beszélgetés, kérés)`
 * párból képzett v5 UUID-t írta a store-ba, a frontend meg egy random v4-est a
 * saját sorára. Két ID, két sor — a takarítás (turn_id szerinti törlés) csak
 * utólag fésülte össze őket, és csak beszélgetésen belül.
 *
 * Innentől a frontend ugyanazt az ID-t képezi, amit a runtime fog: egy sor,
 * egy azonosság, az első képkockától kezdve.
 *
 * A képlet a Rust `stable_id`-jével azonos:
 *   uuid_v5(NAMESPACE_OID, `min:local:{kind}:{key}`)
 */

const NAMESPACE_OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

const rotateLeft = (value: number, bits: number) =>
  ((value << bits) | (value >>> (32 - bits))) >>> 0;

/**
 * SHA-1 a v5 UUID-hoz. A Web Crypto csak aszinkron digestet ad, a sor-ID-t
 * viszont a küldés pillanatában, szinkron kell megkapni.
 */
const sha1 = (bytes: Uint8Array) => {
  const length = bytes.length;
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[length] = 0x80;
  const bitLength = length * 8;
  const view = new DataView(padded.buffer);
  // A hossz 64 bites big-endian mező; a felső 32 bit itt mindig 0 marad, mert
  // ekkora bemenet nem fordul elő.
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);

  let [h0, h1, h2, h3, h4] = [
    0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0,
  ];
  const words = new Uint32Array(80);

  for (let chunk = 0; chunk < paddedLength; chunk += 64) {
    for (let index = 0; index < 16; index += 1)
      words[index] = view.getUint32(chunk + index * 4, false);
    for (let index = 16; index < 80; index += 1)
      words[index] = rotateLeft(
        words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16],
        1,
      );

    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let index = 0; index < 80; index += 1) {
      const [mix, constant] =
        index < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : index < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : index < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const next =
        (rotateLeft(a, 5) + mix + e + constant + words[index]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  const digestView = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4].forEach((word, index) =>
    digestView.setUint32(index * 4, word, false),
  );
  return digest;
};

const uuidBytes = (uuid: string) => {
  const hex = uuid.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

const formatUuid = (bytes: Uint8Array) => {
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
};

export const uuidV5 = (namespace: string, name: string) => {
  const nameBytes = new TextEncoder().encode(name);
  const namespaceBytes = uuidBytes(namespace);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes);
  input.set(nameBytes, namespaceBytes.length);
  const digest = sha1(input).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return formatUuid(digest);
};

/** A Rust `stable_id(kind, key)` párja. */
export const stableId = (kind: string, key: string) =>
  uuidV5(NAMESPACE_OID, `min:local:${kind}:${key}`);

/**
 * Egy válasz-sor azonossága: a beszélgetés és a kérés párja. A runtime is
 * ezt írja, tehát a képernyőn álló élő sor és a lemezre kerülő sor ugyanaz.
 */
export const agentAnswerMessageId = (
  conversationId: string,
  requestId: string,
) => stableId("agent-answer", `${conversationId}:${requestId}`);
