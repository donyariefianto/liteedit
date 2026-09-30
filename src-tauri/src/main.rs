//! LiteEdit — backend Rust.
//! Perintah Tauri: file I/O, git (via CLI), dan PTY asli untuk terminal.
//! Target utama Windows (cmd.exe), tapi kode PTY-nya cross-platform.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
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
}
