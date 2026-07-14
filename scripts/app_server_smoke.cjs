"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const projectsRoot = path.resolve(__dirname, "..");
const codexBinary = resolveCodexBinary();
const useWindowsShell = process.env.MIN_CODEX_SHELL === "1" && process.platform === "win32";
const keepFixtures = process.argv.includes("--keep");
const smokeTimeoutMs = Number(process.env.MIN_SMOKE_TIMEOUT_MS || "60000");

function resolveCodexBinary() {
  if (process.env.MIN_CODEX_BIN) return process.env.MIN_CODEX_BIN;
  const workspaceBinary = path.join(
    projectsRoot,
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
  if (process.platform === "win32" && fs.existsSync(workspaceBinary)) return workspaceBinary;
  const home = process.env.USERPROFILE || process.env.HOME;
  const managedBinary = home
    ? path.join(home, ".codex", "plugins", ".plugin-appserver", process.platform === "win32" ? "codex.exe" : "codex")
    : null;
  return managedBinary && fs.existsSync(managedBinary) ? managedBinary : "codex";
}

function createFixtures() {
  const gitRoot = fs.mkdtempSync(path.join(projectsRoot, ".min-app-server-smoke-git-"));
  const plainRoot = fs.mkdtempSync(path.join(projectsRoot, ".min-app-server-smoke-plain-"));
  execFileSync("git", ["init", "--quiet"], { cwd: gitRoot, stdio: "ignore" });
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: gitRoot, stdio: "ignore" });
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: plainRoot,
      stdio: "ignore",
    });
    throw new Error("A plain fixture váratlanul Git-repónak látszik.");
  } catch (error) {
    if (error?.message?.includes("váratlanul")) throw error;
  }
  return [
    { label: "git", root: gitRoot },
    { label: "non-git", root: plainRoot },
  ];
}

function runSmoke(fixture) {
  return new Promise((resolve) => {
    let child;
    let buffer = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (process.platform === "win32" && child?.pid) {
          execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
          });
        } else {
          child?.kill();
        }
      } catch {
        // The process may already have exited.
        try {
          child?.kill();
        } catch {
          // Ignore a process that is already gone.
        }
      }
      resolve({ ...fixture, ...result });
    };
    const timer = setTimeout(
      () => finish({
        ok: false,
        stage: "thread/start",
        error: `${Math.round(smokeTimeoutMs / 1000)}s timeout`,
      }),
      smokeTimeoutMs,
    );

    try {
      const command = useWindowsShell ? process.env.ComSpec || "cmd.exe" : codexBinary;
      const args = useWindowsShell
        ? ["/d", "/s", "/c", `"${codexBinary}" app-server --stdio`]
        : ["app-server", "--stdio"];
      child = spawn(command, args, {
        cwd: fixture.root,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({ ok: false, stage: "spawn", error: String(error) });
      return;
    }
    child.once("error", (error) => finish({ ok: false, stage: "spawn", error: String(error) }));
    child.stderr.on("data", (chunk) => process.stderr.write(`[${fixture.label} stderr] ${chunk}`));
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch (error) {
          finish({ ok: false, stage: "protocol", error: `Érvénytelen JSON: ${error}`, line });
          return;
        }
        if (value.id === 1) {
          if (value.error) {
            finish({ ok: false, stage: "initialize", error: JSON.stringify(value.error) });
            return;
          }
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(
            `${JSON.stringify({
              id: 2,
              method: "thread/start",
              params: {
                cwd: fixture.root,
                approvalPolicy: "on-request",
                approvalsReviewer: "user",
                sandbox: "workspace-write",
                serviceName: "min-smoke",
              },
            })}\n`,
          );
        } else if (value.id === 2) {
          const threadId = value.result?.thread?.id;
          finish({
            ok: typeof threadId === "string" && threadId.length > 0,
            stage: "thread/start",
            threadId: threadId ?? null,
            error: value.error ? JSON.stringify(value.error) : null,
          });
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "min-smoke", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      })}\n`,
    );
  });
}

function cleanup(fixtures) {
  if (keepFixtures) return;
  for (const fixture of fixtures) {
    const resolved = path.resolve(fixture.root);
    if (
      resolved.startsWith(`${projectsRoot}${path.sep}`) &&
      path.basename(resolved).startsWith(".min-app-server-smoke-")
    ) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

async function main() {
  const fixtures = createFixtures();
  try {
    const results = [];
    for (const fixture of fixtures) results.push(await runSmoke(fixture));
    console.log(JSON.stringify({ codexBinary, useWindowsShell, results }, null, 2));
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  } finally {
    cleanup(fixtures);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
