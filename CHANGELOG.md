# Changelog LiteEdit

Format: [Keep a Changelog](https://keepachangelog.com/id/1.1.0/).

## [Unreleased]

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
