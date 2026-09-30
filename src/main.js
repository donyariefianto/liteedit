// LiteEdit — frontend. Berjalan di dalam WebView Tauri (Windows: WebView2).
// Editor: CodeMirror 6 · Terminal: xterm.js · Backend: Rust (invoke).

import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { autocompletion } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const tauri = window.__TAURI__;
if (!tauri) {
  document.body.innerHTML =
    "<p style='padding:2rem;font-family:sans-serif'>LiteEdit harus dijalankan lewat aplikasi Tauri, bukan browser biasa.</p>";
  throw new Error("Tauri API tidak tersedia");
}
const invoke = tauri.core.invoke;
const listen = tauri.event.listen;

// ---------------- state ----------------
let currentFolder = localStorage.getItem("liteedit.folder") || "";
const tabs = []; // { path, view, dirty }
let activeTab = -1;
let ptyId = null;

// ---------------- bahasa dari ekstensi file ----------------
function langFor(path) {
  const ext = path.split(".").pop().toLowerCase();
  switch (ext) {
    case "js": case "mjs": case "cjs": case "ts": return javascript();
    case "py": return python();
    case "html": case "htm": return html();
    case "css": return css();
    case "json": return json();
    case "md": case "markdown": return markdown();
    case "rs": return rust();
    default: return [];
  }
}
const shortName = (p) => p.split(/[\\/]/).pop();

// ---------------- file explorer ----------------
function makeTreeItem(e) {
  const div = document.createElement("div");
  div.className = "tree-item";
  div.textContent = (e.is_dir ? "📁 " : "📄 ") + e.name;
  div.title = e.path;
  div.onclick = e.is_dir ? () => toggleDir(div, e.path) : () => openFile(e.path);
  return div;
}

async function toggleDir(div, path) {
  const next = div.nextElementSibling;
  if (next && next.classList.contains("tree-sub")) { next.remove(); return; }
  try {
    const entries = await invoke("list_dir", { path });
    const sub = document.createElement("div");
    sub.className = "tree-sub";
    for (const e of entries) sub.appendChild(makeTreeItem(e));
    div.after(sub);
  } catch (err) {
    alert("Gagal buka folder: " + err);
  }
}

async function renderTree() {
  const tree = document.getElementById("filetree");
  tree.innerHTML = "";
  if (!currentFolder) {
    tree.innerHTML = "<div class='hint'>Isi path folder lalu tekan Buka.</div>";
    return;
  }
  try {
    const entries = await invoke("list_dir", { path: currentFolder });
    for (const e of entries) tree.appendChild(makeTreeItem(e));
  } catch (err) {
    tree.innerHTML = `<div class='err'>${err}</div>`;
  }
}

async function openFolder(path) {
  path = path.trim();
  if (!path) return;
  currentFolder = path;
  localStorage.setItem("liteedit.folder", path);
  document.getElementById("folder-input").value = path;
  await renderTree();
}

// ---------------- tab + editor ----------------
function hideEmptyHint() {
  const h = document.getElementById("editor-empty");
  if (h) h.style.display = "none";
}

async function openFile(path) {
  const existing = tabs.findIndex((t) => t.path === path);
  if (existing >= 0) { activateTab(existing); return; }
  let content;
  try {
    content = await invoke("read_file", { path });
  } catch (err) {
    alert("Gagal buka file: " + err);
    return;
  }
  hideEmptyHint();
  const tab = { path, dirty: false, view: null };
  const state = EditorState.create({
    doc: content,
    extensions: [
      basicSetup,
      langFor(path),
      autocompletion(), // autocompletion berbasis kata (v1)
      keymap.of([{
        key: "Ctrl-s", mac: "Cmd-s",
        run: () => { saveFile(tab); return true; },
      }]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !tab.dirty) {
          tab.dirty = true; renderTabs(); updateStatus();
        }
      }),
    ],
  });
  tab.view = new EditorView({ state, parent: document.getElementById("editor") });
  tabs.push(tab);
  activateTab(tabs.length - 1);
}

function activateTab(i) {
  activeTab = i;
  tabs.forEach((t, j) => { t.view.dom.style.display = j === i ? "block" : "none"; });
  if (tabs[i]) tabs[i].view.focus();
  renderTabs();
  updateStatus();
}

function renderTabs() {
  const bar = document.getElementById("tabbar");
  bar.innerHTML = "";
  tabs.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (i === activeTab ? " active" : "");
    const label = document.createElement("span");
    label.textContent = (t.dirty ? "● " : "") + shortName(t.path);
    label.onclick = () => activateTab(i);
    const x = document.createElement("button");
    x.textContent = "×";
    x.onclick = (ev) => { ev.stopPropagation(); closeTab(i); };
    el.append(label, x);
    bar.appendChild(el);
  });
}

async function saveFile(tab) {
  try {
    await invoke("write_file", { path: tab.path, content: tab.view.state.doc.toString() });
    tab.dirty = false;
    renderTabs(); updateStatus();
  } catch (err) {
    alert("Gagal simpan: " + err);
  }
}

function closeTab(i) {
  const t = tabs[i];
  if (t.dirty && !confirm(`Tutup ${shortName(t.path)} tanpa menyimpan?`)) return;
  t.view.destroy();
  tabs.splice(i, 1);
  if (tabs.length === 0) { activeTab = -1; renderTabs(); updateStatus(); return; }
  activateTab(Math.min(i, tabs.length - 1));
}

// ---------------- terminal (pty asli) ----------------
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

async function initTerminal() {
  const term = new Terminal({
    cursorBlink: true, fontSize: 14,
    theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("terminal"));
  fit.fit();
  let cwd = currentFolder;
  if (!cwd) {
    try { cwd = await invoke("get_cwd"); } catch { cwd = ""; }
  }
  try {
    ptyId = await invoke("pty_spawn", { cols: term.cols, rows: term.rows, cwd });
  } catch (err) {
    term.writeln("Gagal membuka terminal: " + err);
    return;
  }
  await listen("pty-data", (e) => {
    if (e.payload.id !== ptyId) return;
    term.write(base64ToBytes(e.payload.data));
  });
  term.onData((d) => invoke("pty_write", { id: ptyId, data: d }));
  document.getElementById("terminal-toggle").onclick = () => {
    const pane = document.getElementById("terminal");
    const hidden = pane.style.display === "none";
    pane.style.display = hidden ? "block" : "none";
    document.getElementById("terminal-toggle").textContent = hidden ? "–" : "+";
    if (hidden) fit.fit();
  };
}

// ---------------- git ----------------
async function refreshGit() {
  const box = document.getElementById("git-files");
  if (!currentFolder) {
    box.innerHTML = "<div class='hint'>Buka folder dulu.</div>";
    return;
  }
  try {
    const files = await invoke("git_status", { repo: currentFolder });
    box.innerHTML = files.length ? "" : "<div class='hint'>Bersih — tidak ada perubahan.</div>";
    for (const f of files) {
      const d = document.createElement("div");
      d.className = "git-file";
      const st = document.createElement("span");
      st.className = "git-st"; st.textContent = f.status || "?";
      const nm = document.createElement("span");
      nm.textContent = f.path;
      d.append(st, nm);
      box.appendChild(d);
    }
  } catch (err) {
    box.innerHTML = `<div class='err'>${err}</div>`;
  }
}

// ---------------- wiring ----------------
function switchPane(which) {
  const ex = which === "explorer";
  document.getElementById("tab-explorer").classList.toggle("active", ex);
  document.getElementById("tab-git").classList.toggle("active", !ex);
  document.getElementById("pane-explorer").classList.toggle("hidden", !ex);
  document.getElementById("pane-git").classList.toggle("hidden", ex);
}

function updateStatus() {
  const t = tabs[activeTab];
  document.getElementById("status-file").textContent = t ? t.path : "";
  document.getElementById("status-saved").textContent =
    t ? (t.dirty ? "● belum disimpan" : "✓ tersimpan") : "";
}

document.getElementById("tab-explorer").onclick = () => switchPane("explorer");
document.getElementById("tab-git").onclick = () => { switchPane("git"); refreshGit(); };
document.getElementById("folder-open").onclick = () =>
  openFolder(document.getElementById("folder-input").value);
document.getElementById("folder-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") openFolder(e.target.value);
});
document.getElementById("git-refresh").onclick = refreshGit;
document.getElementById("git-commit").onclick = async () => {
  const msg = document.getElementById("git-msg").value.trim();
  if (!msg) { alert("Isi pesan commit dulu."); return; }
  try {
    const out = await invoke("git_commit", { repo: currentFolder, message: msg });
    document.getElementById("git-out").textContent = out;
    document.getElementById("git-msg").value = "";
    refreshGit();
  } catch (err) {
    document.getElementById("git-out").textContent = "Gagal: " + err;
  }
};

// ---------------- boot ----------------
(async function boot() {
  document.getElementById("folder-input").value = currentFolder;
  if (currentFolder) {
    try { await invoke("list_dir", { path: currentFolder }); }
    catch { currentFolder = ""; }
  }
  if (!currentFolder) {
    try { currentFolder = await invoke("get_cwd"); } catch { /* abaikan */ }
    document.getElementById("folder-input").value = currentFolder;
  }
  await renderTree();
  await initTerminal();
})();
