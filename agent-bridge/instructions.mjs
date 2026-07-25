//! Project instruction files (`AGENTS.md`, `CLAUDE.md`) for the system prompt.
//!
//! The SDK can load `CLAUDE.md` on its own, but only when a setting source is
//! enabled — and enabling those would also pull in global hooks, plugins and
//! MCP servers that bypass this client's permission model. So the files are
//! read here instead: the same instructions reach the model, nothing else does.
//!
//! `AGENTS.md` is read regardless, because the SDK never looks for it.

import fs from "node:fs";
import path from "node:path";

const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];
/** How far above the project root to look for shared instructions. */
const MAX_ANCESTORS = 3;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024;

function readCapped(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.length > MAX_FILE_BYTES
      ? `${raw.slice(0, MAX_FILE_BYTES)}\n\n[levágva: a fájl túl hosszú]`
      : raw;
  } catch {
    return null;
  }
}

/**
 * Collects instruction files from the project root upwards.
 *
 * Ordered outermost-first so a project's own file is read last and therefore
 * carries the most weight when it contradicts a shared one.
 *
 * @returns {{ text: string, files: string[] }}
 */
export function collectProjectInstructions(cwd) {
  const directories = [];
  let current = path.resolve(cwd);
  for (let level = 0; level <= MAX_ANCESTORS; level += 1) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const sections = [];
  const files = [];
  let total = 0;
  // Outermost first: shared rules, then the project's own.
  for (const directory of directories.reverse()) {
    for (const name of INSTRUCTION_FILES) {
      const filePath = path.join(directory, name);
      const content = readCapped(filePath);
      if (!content) continue;
      if (total + content.length > MAX_TOTAL_BYTES) continue;
      total += content.length;
      files.push(filePath);
      sections.push(`### ${filePath}\n\n${content.trim()}`);
    }
  }

  if (sections.length === 0) return { text: "", files: [] };

  const text = [
    "## Projektutasítások",
    "",
    "Az alábbi utasításfájlok a felhasználó projektjéből származnak. Kövesd őket;",
    "ha egy konkrétabb (mélyebben lévő) fájl ellentmond egy általánosabbnak, a",
    "konkrétabb az erősebb. Szerkesztés előtt nézd meg, van-e az érintett",
    "alkönyvtárban további AGENTS.md vagy CLAUDE.md, és azt is vedd figyelembe.",
    "",
    ...sections,
  ].join("\n");

  return { text, files };
}
