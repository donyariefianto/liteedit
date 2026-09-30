//! LiteEdit — backend Rust.
//! Perintah Tauri: file I/O, git (via CLI), dan PTY asli untuk terminal.
//! Target utama Windows (cmd.exe), tapi kode PTY-nya cross-platform.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

// ---------------- file ----------------

#[derive(Serialize, Clone)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn get_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    for e in rd {
        let e = e.map_err(|e| e.to_string())?;
        let ft = e.file_type().map_err(|e| e.to_string())?;
        out.push(DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
            is_dir: ft.is_dir(),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// ---------------- git (via CLI, harus terinstal) ----------------

#[derive(Serialize)]
struct GitFile {
    path: String,
    status: String,
}

fn git(args: &[&str], cwd: &str) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git tidak ditemukan / gagal dijalankan: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
fn git_status(repo: String) -> Result<Vec<GitFile>, String> {
    let s = git(&["status", "--porcelain=v1"], &repo)?;
    Ok(s
        .lines()
        .filter(|l| l.len() > 3)
        .map(|l| GitFile {
            status: l[..2].trim().to_string(),
            path: l[3..].to_string(),
        })
        .collect())
}

#[tauri::command]
fn git_commit(repo: String, message: String) -> Result<String, String> {
    git(&["add", "-A"], &repo)?;
    git(&["commit", "-m", &message], &repo)
}

// ---------------- PTY (terminal asli) ----------------

struct PtySession {
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

struct PtyState {
    next_id: u64,
    sessions: HashMap<String, PtySession>,
}
type SharedPty = Mutex<PtyState>;

#[derive(Serialize, Clone)]
struct PtyData {
    id: String,
    /// output terminal, di-base64 karena belum tentu UTF-8 valid
    data: String,
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<SharedPty>,
    cols: u16,
    rows: u16,
    cwd: String,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(default_shell());
    if !cwd.is_empty() {
        cmd.cwd(cwd);
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let mut st = state.lock().map_err(|e| e.to_string())?;
    st.next_id += 1;
    let id = format!("pty-{}", st.next_id);
    let emit_id = id.clone();
    let app_c = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app_c.emit(
                        "pty-data",
                        PtyData {
                            id: emit_id.clone(),
                            data: STANDARD.encode(&buf[..n]),
                        },
                    );
                }
            }
        }
    });
    st.sessions.insert(id.clone(), PtySession { writer, child });
    Ok(id)
}

#[tauri::command]
fn pty_write(state: State<SharedPty>, id: String, data: String) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    let s = st
        .sessions
        .get_mut(&id)
        .ok_or_else(|| "pty tidak ditemukan".to_string())?;
    s.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill(state: State<SharedPty>, id: String) -> Result<(), String> {
    let mut st = state.lock().map_err(|e| e.to_string())?;
    if let Some(mut s) = st.sessions.remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

// ---------------- main ----------------

#[derive(Serialize)]
struct SearchMatch {
    path: String,
    line: usize,
    preview: String,
}

const SKIP_DIRS: &[&str] = &[
    ".git", ".hg", ".svn", "node_modules", "target", "dist", "build",
    "__pycache__", ".venv", "venv", ".idea", ".vscode",
];

fn skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

fn looks_binary(p: &Path) -> bool {
    use std::io::Read;
    let mut f = match std::fs::File::open(p) {
        Ok(f) => f,
        Err(_) => return true,
    };
    let mut buf = [0u8; 8000];
    let n = f.read(&mut buf).unwrap_or(0);
    buf[..n].contains(&0)
}

/// Daftar semua file (relatif thd root) — untuk Quick Open (Ctrl+P).
#[tauri::command]
fn walk_files(path: String) -> Result<Vec<String>, String> {
    let root = std::path::PathBuf::from(&path);
    if !root.is_dir() {
        return Err("folder tidak valid".into());
    }
    let mut out = Vec::new();
    fn rec(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>) -> Result<(), String> {
        let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
        for e in entries {
            let e = e.map_err(|e| e.to_string())?;
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if p.is_dir() {
                if !skip_dir(&name) {
                    rec(root, &p, out)?;
                }
            } else if p.is_file() {
                if out.len() >= 10000 {
                    return Ok(());
                }
                if let Ok(rel) = p.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        Ok(())
    }
    rec(&root, &root, &mut out)?;
    out.sort();
    Ok(out)
}

/// Cari teks di semua file (case-sensitive) — untuk panel Search.
#[tauri::command]
fn search_text(path: String, query: String) -> Result<Vec<SearchMatch>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let root = std::path::PathBuf::from(&path);
    if !root.is_dir() {
        return Err("folder tidak valid".into());
    }
    let mut out = Vec::new();
    fn rec(
        root: &Path,
        dir: &Path,
        query: &str,
        out: &mut Vec<SearchMatch>,
    ) -> Result<(), String> {
        if out.len() >= 500 {
            return Ok(());
        }
        let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
        for e in entries {
            let e = e.map_err(|e| e.to_string())?;
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if p.is_dir() {
                if !skip_dir(&name) {
                    rec(root, &p, query, out)?;
                }
                continue;
            }
            if !p.is_file() {
                continue;
            }
            if p.metadata().map(|m| m.len() > 512 * 1024).unwrap_or(true) {
                continue;
            }
            if looks_binary(&p) {
                continue;
            }
            let text = match std::fs::read_to_string(&p) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let rel = p
                .strip_prefix(root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            for (i, line) in text.lines().enumerate() {
                if line.contains(query) {
                    out.push(SearchMatch {
                        path: rel.clone(),
                        line: i + 1,
                        preview: line.trim().chars().take(120).collect(),
                    });
                    if out.len() >= 500 {
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }
    rec(&root, &root, &query, &mut out)?;
    Ok(out)
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&p)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn git_branch(repo: String) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(["-C", &repo, "branch", "--show-current"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("bukan repo git".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(PtyState {
            next_id: 0,
            sessions: HashMap::new(),
        }))
        .invoke_handler(tauri::generate_handler![
            get_cwd,
            list_dir,
            read_file,
            write_file,
            git_status,
            git_commit,
            git_branch,
            search_text,
            walk_files,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            pty_spawn,
            pty_write,
            pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("gagal menjalankan LiteEdit");
}

// ---------------- test ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_default_tidak_kosong() {
        assert!(!default_shell().is_empty());
    }

    /// Tes paling penting: PTY benar-benar bisa menjalankan perintah
    /// dan mengembalikan outputnya (tanpa GUI Tauri).
    #[test]
    fn pty_bisa_echo() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("gagal buka pty");
        let mut cmd = CommandBuilder::new(default_shell());
        #[cfg(windows)]
        cmd.args(["/C", "echo hello-pty"]);
        #[cfg(not(windows))]
        cmd.args(["-c", "echo hello-pty"]);
        let mut child = pair.slave.spawn_command(cmd).expect("gagal spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("gagal reader");
        drop(pair.master);

        let mut out = String::new();
        let mut buf = [0u8; 1024];
        for _ in 0..100 {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
                Err(_) => break,
            }
            if out.contains("hello-pty") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = child.wait();
        assert!(out.contains("hello-pty"), "output tak terduga: {out}");
    }

    fn tmpdir(nama: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("liteedit-test-{nama}"));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn file_ops_dan_search() {
        let root = tmpdir("search");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(root.join("a.txt"), "hello world\nbaris dua\n").unwrap();
        std::fs::write(sub.join("b.rs"), "fn main() {\n  // hello\n}\n").unwrap();
        std::fs::write(root.join("bin.dat"), [0u8, 1, 2, 0, 3]).unwrap();
        let r = root.to_string_lossy().into_owned();

        // walk_files
        let files = walk_files(r.clone()).unwrap();
        assert!(files.contains(&"a.txt".to_string()));
        assert!(files.contains(&"sub/b.rs".to_string()));

        // search_text menemukan, tapi skip file biner
        let hits = search_text(r.clone(), "hello".into()).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.path == "a.txt" && h.line == 1));

        // create / rename / delete
        create_file(format!("{r}/baru/deep.txt")).unwrap();
        assert!(root.join("baru/deep.txt").exists());
        rename_path(
            format!("{r}/baru/deep.txt"),
            format!("{r}/baru/ganti.txt"),
        )
        .unwrap();
        assert!(root.join("baru/ganti.txt").exists());
        delete_path(format!("{r}/baru")).unwrap();
        assert!(!root.join("baru").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn git_branch_bukan_repo_gagal() {
        let root = tmpdir("nogit");
        let r = root.to_string_lossy().into_owned();
        assert!(git_branch(r).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
