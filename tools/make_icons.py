#!/usr/bin/env python3
"""Membuat ikon LiteEdit (PNG + ICO berisi PNG) murni dengan stdlib.
Ikon: kotak gelap dengan kursor hijau — gaya editor.
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "src-tauri", "icons")
os.makedirs(OUT, exist_ok=True)

BG = (30, 30, 30)      # #1e1e1e
GREEN = (74, 222, 128)  # #4ade80


def draw(size):
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            # bingkai membulat sederhana
            r = size * 0.18
            corner = (
                (x < r and y < r and (x - r) ** 2 + (y - r) ** 2 > r**2)
                or (x > size - r and y < r and (x - (size - r)) ** 2 + (y - r) ** 2 > r**2)
                or (x < r and y > size - r and (x - r) ** 2 + (y - (size - r)) ** 2 > r**2)
                or (x > size - r and y > size - r
                    and (x - (size - r)) ** 2 + (y - (size - r)) ** 2 > r**2)
            )
            if corner:
                row.append(None)
                continue
            # kursor hijau vertikal di tengah-kiri
            cx0, cx1 = int(size * 0.42), int(size * 0.54)
            cy0, cy1 = int(size * 0.25), int(size * 0.75)
            if cx0 <= x <= cx1 and cy0 <= y <= cy1:
                row.append(GREEN)
            else:
                row.append(BG)
        rows.append(row)
    return rows


def png_bytes(size):
    rows = draw(size)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    raw = b""
    for row in rows:
        raw += b"\x00"
        for px in row:
            raw += struct.pack("BBBB", 0, 0, 0, 0) if px is None else struct.pack("BBB", *px)
    # pakai RGBA (color type 6) agar sudut transparan
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def write_png(path, size):
    with open(path, "wb") as f:
        f.write(png_bytes(size))
    print("tulis", path)


def write_ico(path, sizes):
    pngs = [(s, png_bytes(s)) for s in sizes]
    n = len(pngs)
    header = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16 * n
    entries, blob = b"", b""
    for size, pb in pngs:
        bsize = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", bsize, bsize, 0, 0, 1, 32, len(pb), offset)
        offset += len(pb)
        blob += pb
    with open(path, "wb") as f:
        f.write(header + entries + blob)
    print("tulis", path)


write_png(os.path.join(OUT, "32x32.png"), 32)
write_png(os.path.join(OUT, "128x128.png"), 128)
write_png(os.path.join(OUT, "128x128@2x.png"), 256)
write_ico(os.path.join(OUT, "icon.ico"), [32, 128, 256])
