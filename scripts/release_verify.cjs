"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const targetRoot = path.resolve(
  process.env.CARGO_TARGET_DIR || path.join(process.env.LOCALAPPDATA || process.env.HOME || repoRoot, "min", "cargo-target"),
);
const releaseRoot = path.join(targetRoot, "release");
const installer = path.join(releaseRoot, "bundle", "nsis", `min_${packageJson.version}_x64-setup.exe`);
// On Windows, Tauri's resource_dir() resolves to the directory containing min.exe.
// The configured resource target is therefore emitted next to the release EXE.
const resource = path.join(releaseRoot, "codex.exe");
const sourceCodex = path.join(
  repoRoot,
  "node_modules",
  "@openai",
  "codex-win32-x64",
  "vendor",
  "x86_64-pc-windows-msvc",
  "bin",
  "codex.exe",
);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

async function main() {
  assertCondition(fs.existsSync(installer), `Hiányzik az NSIS installer: ${installer}`);
  assertCondition(fs.existsSync(resource), `Hiányzik a release resource: ${resource}`);
  assertCondition(fs.existsSync(sourceCodex), `Hiányzik a forrásból ellenőrizhető Codex: ${sourceCodex}`);

  const [installerHash, resourceHash, sourceHash] = await Promise.all([
    hashFile(installer),
    hashFile(resource),
    hashFile(sourceCodex),
  ]);
  assertCondition(resourceHash === sourceHash, "A release resource codex.exe hash-e eltér a lockolt inputtól.");

  const installerStats = fs.statSync(installer);
  const hashFilePath = `${installer}.sha256`;
  fs.writeFileSync(hashFilePath, `${installerHash}  ${path.basename(installer)}\n`, "utf8");

  console.log(JSON.stringify({
    installer,
    installerSizeBytes: installerStats.size,
    installerSha256: installerHash,
    resource,
    resourceSha256: resourceHash,
    sha256File: hashFilePath,
  }, null, 2));
  console.log("release:verify OK");
}

main().catch((error) => {
  console.error(`release:verify FAILED: ${error.message || String(error)}`);
  process.exitCode = 1;
});
