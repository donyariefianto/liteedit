// Build frontend LiteEdit — cross-platform (Windows/Linux/macOS).
// Menggantikan `cp` ala Unix yang tidak ada di Windows.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Sinkronkan versi dulu: package.json -> tauri.conf.json & Cargo.toml
execFileSync(process.execPath, ["scripts/version.mjs"], { stdio: "inherit" });

// Ikon tidak ikut ke git (file biner) — generate otomatis kalau belum ada,
// karena tauri-build di Windows wajib menemukan src-tauri/icons/icon.ico.
if (!existsSync("src-tauri/icons/icon.ico")) {
  console.log("ikon belum ada, generate dulu...");
  execFileSync(process.execPath, ["scripts/make-icons.mjs"], { stdio: "inherit" });
}

await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "iife",
  outfile: "dist/bundle.js",
  loader: { ".css": "css" },
});

mkdirSync("dist", { recursive: true });
copyFileSync("src/index.html", "dist/index.html");
copyFileSync("src/styles.css", "dist/styles.css");

console.log("build selesai: dist/");
