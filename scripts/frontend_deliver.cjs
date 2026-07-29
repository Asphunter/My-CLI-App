#!/usr/bin/env node
/**
 * A frontend átadása a futó appnak, üres pillanat nélkül.
 *
 * A `tauri dev` a `dist/`-et szolgálja ki (a `tauri.conf.json`-ban nincs
 * `devUrl`), a `vite build` viszont kiüríti a `dist/`-et. A néhány másodperces
 * lyukban a webview 404-et kap a 127.0.0.1:1430-ról, és ott is marad — a futó
 * beszélgetés élő panele elveszik.
 *
 * Ezért a build külön mappába megy, és onnan kerül át: először az új eszközök
 * (a régiek érintetlenül), utána az `index.html`, és csak a legvégén törlődik,
 * ami már senkinek nem kell. Így a lap bármelyik pillanatban újratölthető.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const staging = path.join(root, ".frontend-build");
const dist = path.join(root, "dist");
// A csomagok JS-belépőpontja, nem a `.cmd` burkoló: a Node Windowson
// EINVAL-lal áll meg, ha shell nélkül `.cmd`-t indítanánk.
const run = (bin, args) =>
  execFileSync(process.execPath, [path.join(root, "node_modules", bin), ...args], {
    cwd: root,
    stdio: "inherit",
  });

run("typescript/lib/tsc.js", ["-b"]);
run("vite/bin/vite.js", ["build", "--outDir", ".frontend-build", "--emptyOutDir"]);

const walk = (dir, base = "") =>
  fs
    .readdirSync(path.join(dir, base), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = path.join(base, entry.name);
      return entry.isDirectory() ? walk(dir, rel) : [rel];
    });

const key = (rel) => rel.split(path.sep).join("/");
const built = walk(staging);
// Az `index.html` az utolsó: amíg át nem íródik, a betöltött lap a régi
// eszközökre mutat — és azok még a helyükön vannak.
const ordered = [
  ...built.filter((rel) => key(rel) !== "index.html"),
  ...built.filter((rel) => key(rel) === "index.html"),
];
for (const rel of ordered) {
  const target = path.join(dist, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(staging, rel), target);
}

const keep = new Set(built.map(key));
let pruned = 0;
if (fs.existsSync(dist))
  for (const rel of walk(dist))
    if (!keep.has(key(rel))) {
      fs.rmSync(path.join(dist, rel));
      pruned += 1;
    }
fs.rmSync(staging, { recursive: true, force: true });
console.log(`frontend átadva: ${built.length} fájl, ${pruned} elavult törölve`);
