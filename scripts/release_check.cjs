"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const expectedCodexVersion = "0.144.1";
const codexBinary = path.join(
  repoRoot,
  "node_modules",
  "@openai",
  "codex-win32-x64",
  "vendor",
  "x86_64-pc-windows-msvc",
  "bin",
  "codex.exe",
);

function fail(message) {
  console.error(`release:check FAILED: ${message}`);
  process.exitCode = 1;
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function readPeMachine(filePath) {
  const handle = fs.openSync(filePath, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    fs.readSync(handle, dosHeader, 0, dosHeader.length, 0);
    assertCondition(dosHeader.toString("ascii", 0, 2) === "MZ", "A Codex nem PE/Windows bináris.");
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    fs.readSync(handle, peHeader, 0, peHeader.length, peOffset);
    assertCondition(peHeader.toString("ascii", 0, 4) === "PE\0\0", "A Codex PE-fejléce érvénytelen.");
    return peHeader.readUInt16LE(4);
  } finally {
    fs.closeSync(handle);
  }
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

function readCodexVersion() {
  const result = spawnSync(codexBinary, ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assertCondition(result.status === 0, `codex.exe --version hibával állt le: ${result.stderr || result.status}`);
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function readAuthenticode() {
  assertCondition(process.platform === "win32", "A release:check Windowson futtatható.");
  const command = [
    "$path = [Environment]::GetEnvironmentVariable('MIN_RELEASE_CODEX_BIN')",
    "$signature = Get-AuthenticodeSignature -LiteralPath $path",
    "$signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }",
    "[pscustomobject]@{ status = [string]$signature.Status; signer = $signer } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, MIN_RELEASE_CODEX_BIN: codexBinary },
  });
  if (result.error) throw result.error;
  assertCondition(result.status === 0, `Authenticode ellenőrzés sikertelen: ${result.stderr || result.status}`);
  try {
    return JSON.parse((result.stdout || "").trim());
  } catch (error) {
    throw new Error(`Az Authenticode válasza nem JSON: ${error}`);
  }
}

async function main() {
  assertCondition(process.platform === "win32", "A release:check jelenleg Windows x64 release-re van definiálva.");
  assertCondition(fs.existsSync(codexBinary), `Hiányzik a lockolt Codex: ${codexBinary}`);

  const packageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  const codexPackage = packageLock.packages?.["node_modules/@openai/codex"];
  const windowsPackage = packageLock.packages?.["node_modules/@openai/codex-win32-x64"];
  assertCondition(codexPackage?.version === expectedCodexVersion, `A package-lock Codex-verziója nem ${expectedCodexVersion}.`);
  assertCondition(windowsPackage?.version === `${expectedCodexVersion}-win32-x64`, "A lockolt Windows x64 Codex-verzió eltér.");

  const versionOutput = readCodexVersion();
  assertCondition(versionOutput.includes(`codex-cli ${expectedCodexVersion}`), `Váratlan Codex-verzió: ${versionOutput}`);
  const machine = readPeMachine(codexBinary);
  assertCondition(machine === 0x8664, `A Codex PE machine mezője nem AMD64: 0x${machine.toString(16)}`);

  const signature = readAuthenticode();
  assertCondition(signature.status === "Valid", `Az Authenticode státusz nem Valid: ${signature.status || "ismeretlen"}`);
  const sha256 = await hashFile(codexBinary);
  const stats = fs.statSync(codexBinary);

  console.log(JSON.stringify({
    codexBinary,
    version: expectedCodexVersion,
    versionOutput,
    architecture: "x64",
    sizeBytes: stats.size,
    authenticode: signature.status,
    signer: signature.signer || null,
    sha256,
  }, null, 2));
  console.log("release:check OK");
}

main().catch((error) => fail(error.message || String(error)));
