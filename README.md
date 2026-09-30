# LiteEdit

Editor kode **super ringan** pengganti VS Code untuk **Windows** — dibangun dengan
[Tauri v2](https://tauri.app) (backend Rust + WebView2, tanpa Electron).

Fitur v0.1: editor multi-tab + syntax highlighting (CodeMirror 6), file
explorer, terminal terintegrasi (PTY asli → `cmd.exe`), panel Git
(status + commit), dan autocompletion berbasis kata.

Detail rancangan ada di [SPEC.md](SPEC.md).

## Syarat (di Windows)

- [Rust](https://rustup.rs) (via `rustup`)
- [Node.js](https://nodejs.org) 18+
- WebView2 — biasanya sudah bawaan Windows 10/11
- [Git for Windows](https://git-scm.com) — untuk panel Git

## Jalan cepat

```powershell
cd liteedit
python tools/make_icons.py   # generate ikon (sekali saja)
npm install
npm run tauri dev     # mode pengembangan
npm run tauri build   # hasilkan installer + .exe di src-tauri/target/release/bundle
```

## Struktur

```
liteedit/
├── src/                  # frontend (dibundel esbuild → dist/)
│   ├── index.html
│   ├── styles.css
│   └── main.js           # CodeMirror, xterm.js, tab, explorer, git UI
├── src-tauri/
│   ├── src/main.rs       # perintah Tauri: file I/O, git CLI, PTY
│   ├── tauri.conf.json
│   └── icons/            # dibuat via tools/make_icons.py
├── tools/make_icons.py   # generator ikon PNG + ICO (stdlib saja)
├── SPEC.md
└── README.md
```

## Cara pakai

1. Isi path folder di kolom Explorer, tekan **Buka** (atau Enter).
2. Klik file untuk buka di tab. `Ctrl+S` menyimpan.
3. Terminal di panel bawah — `cmd.exe` asli, bisa `cd`, `git`, dll.
4. Tab **Git** di sidebar: **Refresh status** untuk lihat perubahan,
   isi pesan lalu **Commit**.

## Catatan

- v0.1 adalah scaffold yang sudah terverifikasi kompilasinya (lihat SPEC §5),
  tapi binary Windows-nya harus dibangun di mesin Windows.
- Autocompletion v0.1 masih berbasis kata dari dokumen — LSP semantik
  masuk roadmap (SPEC §7).
