# SPEC — LiteEdit

> Editor kode **super ringan** pengganti VS Code untuk **Windows**.
> Status: scaffold v0.1 (2026-09-30). Nama "LiteEdit" masih nama kerja.

## 1. Tujuan

Bangun editor kode desktop yang jauh lebih ringan dari VS Code, dengan empat
fitur inti yang dibutuhkan dony:

1. **Nulis kode** — editor multi-tab + syntax highlighting.
2. **Terminal** — terminal terintegrasi (PTY asli, bukan semu).
3. **Git** — lihat status perubahan + commit dari dalam aplikasi.
4. **Autocompletion** — saran kata saat mengetik.

Prinsip: tanpa AI, tanpa Electron. Semua yang bisa dihitung/dikerjakan secara
langsung (file I/O, proses, PTY) dikerjakan native oleh backend Rust.

## 2. Kenapa ringan

| | VS Code | LiteEdit |
|---|---|---|
| Runtime UI | Electron (Chromium bundel, ±200 MB) | WebView2 bawaan Windows (±10 MB binary) |
| Backend | Node.js | Rust native |
| RAM idle tipikal | 500 MB – 1 GB+ | target < 150 MB |

Tauri memakai WebView2 yang sudah ada di Windows 10/11, jadi yang dibundel
hanya kode aplikasi + runtime Rust yang kecil.

## 3. Arsitektur

```
┌─────────────────────────────────────────────┐
│ WebView2 (Windows)                          │
│  index.html + styles.css                    │
│  bundle.js: CodeMirror 6 (editor)           │
│             xterm.js (terminal)             │
│             logika tab / explorer / git UI  │
└──────────────▲ invoke / event ▲──────────────┘
               │                 │
┌──────────────┴─────────────────┴──────────────┐
│ Rust (src-tauri/src/main.rs)                 │
│  • get_cwd / list_dir / read_file /          │
│    write_file        → file I/O               │
│  • git_status / git_commit → via git CLI     │
│  • pty_spawn / pty_write / pty_kill          │
│      → portable-pty (cmd.exe di Windows,     │
│        $SHELL di Linux/macOS)                │
│  • output PTY di-stream via event            │
│    "pty-data" (payload base64)               │
└──────────────────────────────────────────────┘
```

Alur terminal: `xterm.onData` → `pty_write` → PTY → thread reader →
event `pty-data` → `term.write()`. Dua arah, real-time.

## 4. Fitur v0.1 (sudah di-scaffold)

- Explorer: buka folder, tree rekursif (expand per klik).
- Editor: multi-tab, syntax highlighting (JS/TS, Python, HTML, CSS, JSON,
  Markdown, Rust), `Ctrl+S` simpan, indikator ● belum disimpan.
- Terminal: PTY asli, `cmd.exe` di Windows; resize mengikuti ukuran xterm
  saat spawn; toggle show/hide.
- Git: panel status (`git status --porcelain`), commit (`add -A` + `commit`).
- Autocompletion: berbasis kata dari dokumen (CodeMirror `autocompletion()`).

## 5. Yang diverifikasi (2026-09-30, di Linux)

- `npm run build` → `dist/bundle.js` + `bundle.css` sukses (esbuild).
- `cargo check` di `src-tauri` → kompilasi Rust sukses.
- `cargo test pty_bisa_echo` → PTY spawn + baca output lolos.
- Ikon PNG + ICO tergenerate (`tools/make_icons.py`).

## 6. Batasan jujur v0.1

- **Binary Windows belum dibangun** — harus di-build di mesin Windows
  (`npm run tauri build`). VM ini Linux, jadi belum ada `.exe`/installer.
- Autocompletion masih sederhana (kata dari dokumen), belum LSP
  (belum ada analisis semantik / saran API).
- PTY resize setelah spawn belum diimplementasikan.
- Git: belum ada diff view, history/log, push/pull, branch.
- Belum ada: pencarian global, settings/tema, multi-window, auto-update,
  ekstensi.

## 7. Langkah lanjut yang masuk akal

1. Build & uji di Windows 10/11 (WebView2, `cmd.exe`, Git for Windows).
2. LSP: sambungkan `tower-lsp` atau client LSP generik untuk autocompletion
   semantik (rust-analyzer, pyright, typescript-language-server).
3. `pty_resize` (simpan `MasterPty` + writer lewat channel).
4. Git diff view + log history.
5. Pencarian global (ripgrep via Rust) + settings JSON + tema terang/gelap.

## 8. Keputusan terbuka

- Nama final (LiteEdit = nama kerja).
- Distribusi: installer NSIS vs portable `.exe`.
- Bahasa UI: Indonesia / Inggris (sekarang campur, cenderung Indonesia).
