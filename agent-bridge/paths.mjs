//! Windows path normalization for the workspace containment guard.
//!
//! Rust canonicalizes the project root before handing it to the bridge, and on
//! Windows `canonicalize` returns the extended-length form (`\\?\C:\...`).
//! Claude, meanwhile, sends plain absolute paths (`C:\...`) — `Edit` and
//! `Write` require absolute `file_path` values. Comparing the two forms with a
//! prefix test fails, so an in-project edit gets denied as "outside the
//! workspace". Relative paths happened to survive because they were resolved
//! against the extended-length root, which is why reads worked and edits did
//! not. Both sides are reduced to the same plain form here.

import path from "node:path";

const EXTENDED_PREFIX = "\\\\?\\";
const EXTENDED_UNC_PREFIX = "\\\\?\\UNC\\";

/**
 * Removes a Windows extended-length prefix, leaving an ordinary absolute path.
 * Paths without the prefix — and every POSIX path — are returned unchanged.
 */
export function stripExtendedLengthPrefix(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith(EXTENDED_UNC_PREFIX)) {
    return `\\\\${value.slice(EXTENDED_UNC_PREFIX.length)}`;
  }
  if (value.startsWith(EXTENDED_PREFIX)) {
    return value.slice(EXTENDED_PREFIX.length);
  }
  return value;
}

/** Resolves a path to the single comparable form used by the guard. */
export function normalizeGuardPath(value) {
  return path.resolve(stripExtendedLengthPrefix(value));
}

/** True only for the workspace root itself or one of its descendants. */
export function isInsideWorkspace(root, candidate) {
  const resolvedRoot = normalizeGuardPath(root);
  const resolvedCandidate = normalizeGuardPath(candidate);
  return resolvedCandidate === resolvedRoot
    || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

/** Blocks both escapes from the workspace and this client's private state. */
export function containsForbiddenPath(candidate, cwd) {
  if (!isInsideWorkspace(cwd, candidate)) return true;
  const relative = path.relative(cwd, candidate).replaceAll("\\", "/").toLowerCase();
  return relative.split("/").some((segment) =>
    [".git", ".min", "conversation audits", "artifacts"].includes(segment),
  );
}

/**
 * Finds absolute paths embedded in a shell command without truncating quoted
 * Windows paths at their first space. That truncation used to turn
 * `cd "C:/Users/.../My Project"` into `C:/Users/.../My`, so a command that
 * explicitly entered its own workspace was denied as an escape.
 */
export function commandAppearsOutsideWorkspace(command, cwd) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (/\.git(?:[\\/]|$)|\.min(?:[\\/]|$)|conversation audits/i.test(command)) return true;

  const quotedPaths = [];
  for (const pattern of [/"([A-Za-z]:[\\/][^"]*)"/g, /'([A-Za-z]:[\\/][^']*)'/g]) {
    for (const match of command.matchAll(pattern)) quotedPaths.push(match[1]);
  }
  const unquoted = command.replace(/"[^"]*"|'[^']*'/g, " ");
  const windowsPaths = unquoted.match(/[A-Za-z]:[\\/][^\s"';&|<>]*/g) ?? [];
  const unixPaths = unquoted.match(/(?:^|\s)(\/(?:[^\s"';&|<>]+))/g) ?? [];
  return [...quotedPaths, ...windowsPaths, ...unixPaths.map((value) => value.trim())]
    .some((value) => containsForbiddenPath(path.resolve(cwd, value), cwd));
}
