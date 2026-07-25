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
