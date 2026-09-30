// Build frontend LiteEdit — cross-platform (Windows/Linux/macOS).
// Menggantikan `cp` ala Unix yang tidak ada di Windows.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

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
