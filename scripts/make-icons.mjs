// Generate ikon LiteEdit (PNG + ICO) — murni Node.js, tanpa dependensi.
// Ikon: kotak gelap dengan kursor hijau, gaya editor.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src-tauri", "icons");

const BG = [30, 30, 30, 255]; // #1e1e1e
const GREEN = [74, 222, 128, 255]; // #4ade80

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.18;
  const cx0 = Math.floor(size * 0.42), cx1 = Math.floor(size * 0.54);
  const cy0 = Math.floor(size * 0.25), cy1 = Math.floor(size * 0.75);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const corner =
        (x < r && y < r && (x - r) ** 2 + (y - r) ** 2 > r * r) ||
        (x > size - r && y < r && (x - (size - r)) ** 2 + (y - r) ** 2 > r * r) ||
        (x < r && y > size - r && (x - r) ** 2 + (y - (size - r)) ** 2 > r * r) ||
        (x > size - r && y > size - r &&
          (x - (size - r)) ** 2 + (y - (size - r)) ** 2 > r * r);
      const i = (y * size + x) * 4;
      if (corner) {
        px[i + 3] = 0; // transparan
        continue;
      }
      const c = (cx0 <= x && x <= cx1 && cy0 <= y && y <= cy1) ? GREEN : BG;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
    }
  }
  return px;
}

// --- CRC32 (untuk chunk PNG) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  td.copy(out, 4);
  out.writeUInt32BE(crc32(td), 8 + data.length);
  return out;
}

function pngBytes(size) {
  const px = draw(size);
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function icoBytes(sizes) {
  const pngs = sizes.map((s) => ({ s, data: pngBytes(s) }));
  const n = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(n, 4);
  let offset = 6 + 16 * n;
  const entries = [];
  const blobs = [];
  for (const { s, data } of pngs) {
    const e = Buffer.alloc(16);
    const bs = s >= 256 ? 0 : s;
    e[0] = bs; e[1] = bs; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
    blobs.push(data);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "32x32.png"), pngBytes(32));
writeFileSync(join(OUT, "128x128.png"), pngBytes(128));
writeFileSync(join(OUT, "128x128@2x.png"), pngBytes(256));
writeFileSync(join(OUT, "icon.ico"), icoBytes([32, 128, 256]));
console.log("ikon dibuat di src-tauri/icons/");
