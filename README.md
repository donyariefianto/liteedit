# LiteEdit

[![CI](https://github.com/donyariefianto/liteedit/actions/workflows/ci.yml/badge.svg)](https://github.com/donyariefianto/liteedit/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/donyariefianto/liteedit)](https://github.com/donyariefianto/liteedit/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Editor kode **super ringan** pengganti VS Code untuk **Windows** — dibangun dengan
[Tauri v2](https://tauri.app) (backend Rust + WebView2, tanpa Electron).

## Fitur

- Editor multi-tab + syntax highlighting (CodeMirror 6, tema Tokyo Night)
- Activity bar ala VS Code: Explorer, Search, Source Control
- File explorer dengan menu konteks (file/folder baru, rename, hapus)
- Breadcrumbs, status bar (branch git, posisi kursor, bahasa file)
- Command palette (`Ctrl+Shift+P`), quick open (`Ctrl+P`)
- Pencarian teks global (`Ctrl+Shift+F`) & di dalam file (`Ctrl+F`)
- Multi-terminal (PTY asli → `cmd.exe`)
- Panel Git (status + commit), autocompletion berbasis kata

Detail rancangan ada di [SPEC.md](SPEC.md), riwayat perubahan di
[CHANGELOG.md](CHANGELOG.md).

## Instalasi

Unduh installer terbaru dari halaman
[Releases](https://github.com/donyariefianto/liteedit/releases)
(`LiteEdit_X.Y.Z_x64-setup.exe` untuk Windows).

## Pengembangan

Syarat (di Windows):

- [Rust](https://rustup.rs) (via `rustup`)
- [Node.js](https://nodejs.org) 18+
- WebView2 — biasanya sudah bawaan Windows 10/11
- [Git for Windows](https://git-scm.com) — untuk panel Git

```powershell
cd liteedit
npm install
npm run tauri dev     # mode pengembangan
npm run tauri build   # hasilkan installer + .exe di src-tauri/target/release/bundle
```

Ikon aplikasi (`src-tauri/icons/`) tidak ikut ke git karena file biner —
otomatis di-generate saat build via `scripts/make-icons.mjs`.

## Struktur

```
liteedit/
├── .github/workflows/        # CI (build+test) & Release otomatis
├── src/                      # frontend (dibundel esbuild → dist/)
│   ├── index.html
│   ├── styles.css
│   └── main.js               # CodeMirror, xterm.js, tab, explorer, git UI
├── src-tauri/
│   ├── src/main.rs           # perintah Tauri: file I/O, git CLI, PTY
│   ├── tauri.conf.json
│   └── icons/                # di-generate otomatis saat build
├── scripts/
│   ├── build.mjs             # build frontend (cross-platform)
│   ├── make-icons.mjs        # generator ikon PNG + ICO
│   └── version.mjs           # sinkronisasi versi package.json → Rust/Tauri
├── SPEC.md
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## Cara pakai

1. Isi path folder di kolom Explorer, tekan **Buka** (atau Enter).
2. Klik file untuk buka di tab. `Ctrl+S` menyimpan.
3. Terminal di panel bawah — `cmd.exe` asli, bisa `cd`, `git`, dll.
4. Tab **Git** di sidebar: **Refresh status** untuk lihat perubahan,
   isi pesan lalu **Commit**.

## Versioning & rilis

Satu sumber versi: `package.json`. Script `scripts/version.mjs`
otomatis menyamakan `src-tauri/tauri.conf.json` dan `src-tauri/Cargo.toml`
setiap kali `npm run build` dijalankan (CI juga mengecek konsistensinya).

```powershell
npm version minor        # atau patch / major, atau eksplisit: npm version 0.3.0
git push origin main --tags
```

Push tag `v*` memicu workflow **Release**: GitHub Actions otomatis build
installer Windows & Linux lalu publish sebagai GitHub Release.
Setiap push ke `main` menjalankan workflow **CI** (build + cargo check + test).

## Lisensi

LiteEdit dirilis di bawah [lisensi MIT](LICENSE).
