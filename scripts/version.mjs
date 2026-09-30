// scripts/version.mjs — SATU sumber versi: package.json.
// Menyalin versi ke src-tauri/tauri.conf.json dan src-tauri/Cargo.toml.
//
//   node scripts/version.mjs           -> sinkronkan (dipanggil otomatis tiap build)
//   node scripts/version.mjs --check   -> exit 1 kalau ada yang tidak konsisten (dipakai CI)
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error("versi package.json tidak valid:", version);
  process.exit(1);
}

const check = process.argv.includes("--check");
let ok = true;

// 1. tauri.conf.json
const confPath = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
if (conf.version !== version) {
  if (check) {
    console.error(`tauri.conf.json (${conf.version}) != package.json (${version})`);
    ok = false;
  } else {
    conf.version = version;
    writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
    console.log("tauri.conf.json ->", version);
  }
}

// 2. Cargo.toml — baris `version` di bawah [package]
const cargoPath = "src-tauri/Cargo.toml";
const lines = readFileSync(cargoPath, "utf8").split("\n");
let inPkg = false;
let done = false;
for (let i = 0; i < lines.length && !done; i++) {
  if (/^\[package\]/.test(lines[i])) inPkg = true;
  else if (/^\[/.test(lines[i])) inPkg = false;
  else if (inPkg && /^version\s*=/.test(lines[i])) {
    const cur = lines[i].match(/"([^"]+)"/)?.[1];
    if (cur !== version) {
      if (check) {
        console.error(`Cargo.toml (${cur}) != package.json (${version})`);
        ok = false;
      } else {
        lines[i] = `version = "${version}"`;
        console.log("Cargo.toml ->", version);
      }
    }
    done = true;
  }
}
if (!check) writeFileSync(cargoPath, lines.join("\n"));

if (check) {
  if (!ok) process.exit(1);
  console.log("versi konsisten:", version);
} else {
  console.log("versi:", version);
}
