# LiteEdit

Editor kode **super ringan** pengganti VS Code untuk **Windows** — dibangun dengan
[Tauri v2](https://tauri.app) (backend Rust + WebView2, tanpa Electron).

Fitur v0.2: editor multi-tab + syntax highlighting (CodeMirror 6, tema Tokyo
Night), activity bar (Explorer / Search / Source Control), file explorer
dengan menu konteks (file/folder baru, rename, hapus), breadcrumbs, status
bar (branch, posisi kursor, bahasa), command palette (`Ctrl+Shift+P`),
quick open (`Ctrl+P`), pencarian teks global (`Ctrl+Shift+F`) & di-file
(`Ctrl+F`), multi-terminal + split berdampingan (PTY asli dengan auto-resize,
shell mengikuti OS), panel Git (status +
commit), dan autocompletion berbasis kata.

Detail rancangan ada di [SPEC.md](SPEC.md).

## Syarat (di Windows)

- [Rust](https://rustup.rs) (via `rustup`)
- [Node.js](https://nodejs.org) 18+
- WebView2 — biasanya sudah bawaan Windows 10/11
- [Git for Windows](https://git-scm.com) — untuk panel Git

## Jalan cepat

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
├── LICENSE-MIT          # lisensi MIT
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
Perubahan tiap versi dicatat di [CHANGELOG.md](CHANGELOG.md).

## Lisensi

LiteEdit berlisensi **MIT** — lihat [LICENSE-MIT](LICENSE-MIT). Bebas dipakai,
dimodifikasi, dan didistribusikan ulang (termasuk untuk keperluan komersial)
selama pemberitahuan hak cipta tetap disertakan.

Dibangun di atas proyek open source: [Tauri](https://tauri.app),
[CodeMirror 6](https://codemirror.net), [xterm.js](https://xtermjs.org),
dan [portable-pty](https://github.com/wez/wezterm) — terima kasih kepada
para maintainernya.

## Catatan

- v0.1 adalah scaffold yang sudah terverifikasi kompilasinya (lihat SPEC §5),
  tapi binary Windows-nya harus dibangun di mesin Windows.
- Autocompletion v0.1 masih berbasis kata dari dokumen — LSP semantik
  masuk roadmap (SPEC §7).
