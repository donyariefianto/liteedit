# Changelog LiteEdit

Format: [Keep a Changelog](https://keepachangelog.com/id/1.1.0/).

## [Unreleased]
### Ditambah
- Terminal: command Rust `pty_resize` + `syncTermSize` — ukuran PTY selalu
  sinkron dengan viewport xterm (spawn terukur, ganti tab, resize panel /
  window via ResizeObserver) di Windows, Linux, dan macOS
- Split terminal berdampingan ala VS Code (grup pane flex-row + garis pemisah)
- Run Python memakai `python3` di Linux/macOS; font terminal & editor
  cross-platform (Cascadia/Cascadia Code, SF Mono/Menlo, DejaVu Sans Mono)
- Ganti tab editor memicu re-measure agar konten selalu pas
### Diperbaiki
- Backend kini menyimpan `MasterPty` selama sesi hidup — di Windows,
  drop master menutup ConPTY sehingga terminal mati/aneh (root cause
  kegagalan `pty_bisa_echo` di Windows; tes ditulis ulang dgn pola yg sama
  dan kini lolos 4/4 di Windows)
- Tambah `src-tauri/capabilities/default.json` (`core:default`): tanpa ini
  event `pty-data` diblokir Tauri v2 → terminal blank walau invoke lain jalan;
  `listen` di boot kini gagal dgn notifikasi LOUD + log diagnosa aliran event
- Sembunyikan jendela console luar di build rilis Windows
  (`windows_subsystem = "windows"`): terminal hanya tampil di panel dalam app
### Lisensi
- Lisensi MIT: file `LICENSE-MIT`, header SPDX di source, metadata lisensi
  (`package.json`, `Cargo.toml`, `tauri.conf.json`), dan bagian lisensi +
  kredit di README/SPEC

## [0.2.0] - 2026-10-01
### Ditambah
- Activity bar (Explorer / Search / Source Control) ala VS Code
- Status bar: branch git, posisi kursor (Ln/Col), bahasa file
- Command palette (`Ctrl+Shift+P`) dan Quick Open (`Ctrl+P`)
- Pencarian teks global (`Ctrl+Shift+F`) dan di dalam file (`Ctrl+F`)
- Menu konteks explorer: file/folder baru, rename, hapus
- Multi-terminal, breadcrumbs, ikon file berwarna per bahasa
- Tema UI & editor "Tokyo Night" yang lebih nyaman di mata
- Command Rust baru: `walk_files`, `search_text`, `create_file`, `create_dir`,
  `rename_path`, `delete_path`, `git_branch`
- CI GitHub Actions + release otomatis via tag `v*`
- `scripts/version.mjs`: satu sumber versi (`package.json`)

### Diperbaiki
- Build script cross-platform (tanpa perintah `cp` ala Unix)
- `tauri dev` serve `dist/` langsung tanpa dev server
- Ikon di-generate otomatis saat build (tanpa Python)
- Frontend memakai `@tauri-apps/api` resmi (pengganti `window.__TAURI__`)

## [0.1.0] - 2026-09-30
### Ditambah
- Rilis awal: editor multi-tab + syntax highlighting (CodeMirror 6)
- File explorer, terminal terintegrasi (PTY asli → `cmd.exe`)
- Panel Git (status + commit), autocompletion berbasis kata
