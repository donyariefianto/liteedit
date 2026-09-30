// LiteEdit — frontend. Berjalan di dalam WebView Tauri (Windows: WebView2).
// Editor: CodeMirror 6 · Terminal: xterm.js · Backend: Rust (invoke).

import { EditorState } from "@codemirror/state";
import { EditorView, keymap, highlightActiveLine } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { autocompletion } from "@codemirror/autocomplete";
import { bracketMatching } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
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
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tokyoNight } from "./theme.js";

function tauriMissing() {
  document.body.innerHTML =
    "<p style='padding:2rem;font-family:sans-serif'>LiteEdit harus dijalankan lewat aplikasi Tauri, bukan browser biasa.</p>";
}

// ---------------- state ----------------
let currentFolder = localStorage.getItem("liteedit.folder") || "";
const tabs = []; // { path, view, dirty }
let activeTab = -1;
const terms = []; // { id, term, fit, pane, tabEl }
let termSeq = 0;
const expanded = new Set(); // path folder yang terbuka di tree
const dirCache = new Map(); // path -> entries
let fileCache = null; // hasil walk_files untuk quick open

// ---------------- util ----------------
const shortName = (p) => p.split(/[\\/]/).pop();
const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function joinPath(base, rel) {
  const sep = base.includes("\\") ? "\\" : "/";
  return base.replace(/[/\\]$/, "") + sep + rel.split("/").join(sep);
}

// ---------------- bahasa & ikon ----------------
const LANGS = {
  js: ["JavaScript", "#e0af68"], mjs: ["JavaScript", "#e0af68"], cjs: ["JavaScript", "#e0af68"],
  ts: ["TypeScript", "#7aa2f7"], py: ["Python", "#9ece6a"], rs: ["Rust", "#ff9e64"],
  html: ["HTML", "#f7768e"], htm: ["HTML", "#f7768e"], css: ["CSS", "#7dcfff"],
  json: ["JSON", "#e0af68"], md: ["Markdown", "#a9b1d6"], markdown: ["Markdown", "#a9b1d6"],
  toml: ["TOML", "#a9b1d6"], yaml: ["YAML", "#a9b1d6"], yml: ["YAML", "#a9b1d6"],
};
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
const langLabel = (p) => (LANGS[p.split(".").pop().toLowerCase()] || ["Plain Text"])[0];
const langColor = (p) => (LANGS[p.split(".").pop().toLowerCase()] || [null, "#565f89"])[1];

const FILE_SVG = (color) =>
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8"><path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6"/></svg>`;
const FOLDER_SVG =
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7aa2f7" stroke-width="1.8"><path d="M3 5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

// ---------------- file explorer ----------------
function treeNode(e) {
  const wrap = document.createElement("div");
  wrap.className = "tnode";
  const row = document.createElement("div");
  row.className = "trow";
  row.dataset.path = e.path;
  row.title = e.path;
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = e.is_dir ? (expanded.has(e.path) ? "▾" : "▸") : "";
  const icon = document.createElement("span");
  icon.className = "ficon";
  icon.innerHTML = e.is_dir ? FOLDER_SVG : FILE_SVG(langColor(e.name));
  const nm = document.createElement("span");
  nm.className = "fname";
  nm.textContent = e.name;
  row.append(caret, icon, nm);
  const kids = document.createElement("div");
  kids.className = "tchildren";
  kids.style.display = "none";
  row.onclick = () => (e.is_dir ? toggleNode(e, row, kids, caret) : openFile(e.path));
  row.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); ctxForEntry(ev, e); };
  wrap.append(row, kids);
  if (tabs.some((t) => t.path === e.path && t.dirty)) row.classList.add("dirty");
  if (e.is_dir && expanded.has(e.path)) toggleNode(e, row, kids, caret, true);
  return wrap;
}

async function toggleNode(e, row, kids, caret, forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : kids.style.display === "none";
  if (open) {
    let entries = dirCache.get(e.path);
    if (!entries) {
      try { entries = await invoke("list_dir", { path: e.path }); }
      catch (err) { alert("Gagal buka folder: " + err); return; }
      dirCache.set(e.path, entries);
    }
    kids.innerHTML = "";
    for (const c of entries) kids.appendChild(treeNode(c));
    kids.style.display = "block";
    caret.textContent = "▾";
    expanded.add(e.path);
  } else {
    kids.style.display = "none";
    caret.textContent = "▸";
    expanded.delete(e.path);
  }
}

async function renderTree() {
  const tree = $("tree");
  tree.innerHTML = "";
  dirCache.clear();
  if (!currentFolder) {
    tree.innerHTML = "<div class='hint'>Isi path folder lalu tekan Buka.</div>";
    return;
  }
  try {
    const entries = await invoke("list_dir", { path: currentFolder });
    dirCache.set(currentFolder, entries);
    for (const e of entries) tree.appendChild(treeNode(e));
  } catch (err) {
    tree.innerHTML = `<div class='hint'>${escapeHtml(String(err))}</div>`;
  }
}

function markTreeDirty(path, dirty) {
  document.querySelectorAll(`.trow[data-path="${CSS.escape(path)}"]`)
    .forEach((r) => r.classList.toggle("dirty", dirty));
}

async function openFolder(path) {
  path = path.trim();
  if (!path) return;
  currentFolder = path;
  fileCache = null;
  localStorage.setItem("liteedit.folder", path);
  $("folder-input").value = path;
  await renderTree();
  refreshBranch();
}

// operasi file dari context menu / palette
async function newFileHere(base) {
  if (!base) { alert("Buka folder dulu."); return; }
  const name = prompt("Nama file:");
  if (!name) return;
  const p = joinPath(base, name);
  try {
    await invoke("create_file", { path: p });
    dirCache.clear(); fileCache = null;
    await renderTree();
    openFile(p);
  } catch (err) { alert("Gagal: " + err); }
}
async function newFolderHere(base) {
  if (!base) { alert("Buka folder dulu."); return; }
  const name = prompt("Nama folder:");
  if (!name) return;
  try {
    await invoke("create_dir", { path: joinPath(base, name) });
    dirCache.clear(); fileCache = null;
    await renderTree();
  } catch (err) { alert("Gagal: " + err); }
}
async function renameEntry(e) {
  const nn = prompt("Nama baru:", shortName(e.path));
  if (!nn || nn === shortName(e.path)) return;
  const parent = e.path.slice(0, e.path.length - shortName(e.path).length);
  const to = parent + nn;
  try {
    await invoke("rename_path", { from: e.path, to });
    const t = tabs.find((t) => t.path === e.path);
    if (t) { t.path = to; renderTabs(); }
    dirCache.clear(); fileCache = null;
    await renderTree();
  } catch (err) { alert("Gagal: " + err); }
}
async function deleteEntry(e) {
  if (!confirm(`Hapus ${e.name}?`)) return;
  try {
    await invoke("delete_path", { path: e.path });
    const i = tabs.findIndex((t) => t.path === e.path);
    if (i >= 0) closeTab(i, true);
    dirCache.clear(); fileCache = null;
    await renderTree();
  } catch (err) { alert("Gagal: " + err); }
}

// ---------------- menu konteks ----------------
function showCtxMenu(x, y, items) {
  const m = $("ctxmenu");
  m.innerHTML = "";
  for (const it of items) {
    if (it.sep) { const s = document.createElement("div"); s.className = "ctxsep"; m.appendChild(s); continue; }
    const d = document.createElement("div");
    d.className = "ctxitem" + (it.danger ? " danger" : "");
    d.textContent = it.label;
    d.onclick = () => { hideCtxMenu(); it.run(); };
    m.appendChild(d);
  }
  m.classList.remove("hidden");
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - 200) + "px";
  m.style.top = Math.min(y, innerHeight - r.height - 10) + "px";
}
function hideCtxMenu() { $("ctxmenu").classList.add("hidden"); }

function ctxForEntry(ev, e) {
  const parent = e.is_dir ? e.path : e.path.slice(0, e.path.length - shortName(e.path).length);
  const items = e.is_dir ? [
    { label: "File Baru", run: () => newFileHere(e.path) },
    { label: "Folder Baru", run: () => newFolderHere(e.path) },
    { sep: true },
    { label: "Rename", run: () => renameEntry(e) },
    { label: "Hapus", danger: true, run: () => deleteEntry(e) },
  ] : [
    { label: "Buka", run: () => openFile(e.path) },
    { sep: true },
    { label: "Rename", run: () => renameEntry(e) },
    { label: "Hapus", danger: true, run: () => deleteEntry(e) },
  ];
  if (!e.is_dir) items.unshift({ label: "File Baru di folder ini", run: () => newFileHere(parent) });
  showCtxMenu(ev.clientX, ev.clientY, items);
}

// ---------------- tab + editor ----------------
function editorExtensions(tab) {
  return [
    keymap.of([
      { key: "Ctrl-s", mac: "Cmd-s", run: () => { saveFile(tab); return true; } },
      ...searchKeymap, // Ctrl+F di dalam editor
    ]),
    basicSetup,
    tokyoNight(),
    langFor(tab.path),
    autocompletion(),
    highlightActiveLine(),
    bracketMatching(),
    highlightSelectionMatches(),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !tab.dirty) {
        tab.dirty = true; renderTabs(); markTreeDirty(tab.path, true);
      }
      if (u.selectionSet || u.docChanged) updateCursorStatus();
    }),
  ];
}

function hideEmptyHint() {
  const h = $("editor-empty");
  if (h) h.style.display = "none";
}

async function openFile(path, line) {
  const existing = tabs.findIndex((t) => t.path === path);
  if (existing >= 0) { activateTab(existing); if (line) gotoLine(tabs[existing], line); return; }
  let content;
  try { content = await invoke("read_file", { path }); }
  catch (err) { alert("Gagal buka file: " + err); return; }
  hideEmptyHint();
  const tab = { path, dirty: false, view: null };
  const state = EditorState.create({ doc: content, extensions: editorExtensions(tab) });
  tab.view = new EditorView({ state, parent: $("editor") });
  tabs.push(tab);
  activateTab(tabs.length - 1);
  if (line) gotoLine(tab, line);
}

function gotoLine(tab, line) {
  const v = tab.view;
  const n = Math.max(1, Math.min(line, v.state.doc.lines));
  const pos = v.state.doc.line(n).from;
  v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  v.focus();
}

function activateTab(i) {
  activeTab = i;
  tabs.forEach((t, j) => { t.view.dom.style.display = j === i ? "block" : "none"; });
  if (tabs[i]) tabs[i].view.focus();
  renderTabs(); renderBreadcrumbs(); updateCursorStatus(); updateLangStatus();
}

function renderTabs() {
  const bar = $("tabs");
  bar.innerHTML = "";
  tabs.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (i === activeTab ? " active" : "") + (t.dirty ? " dirty" : "");
    const dot = document.createElement("span");
    dot.innerHTML = FILE_SVG(langColor(t.path));
    dot.style.display = "flex";
    const label = document.createElement("span");
    label.className = "tname";
    label.textContent = shortName(t.path);
    label.onclick = () => activateTab(i);
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "×";
    x.onclick = (ev) => { ev.stopPropagation(); closeTab(i); };
    el.append(dot, label, x);
    el.ondblclick = () => openFile(t.path);
    bar.appendChild(el);
  });
}

async function saveFile(tab) {
  try {
    await invoke("write_file", { path: tab.path, content: tab.view.state.doc.toString() });
    tab.dirty = false;
    renderTabs(); markTreeDirty(tab.path, false);
  } catch (err) { alert("Gagal simpan: " + err); }
}

function closeTab(i, force) {
  const t = tabs[i];
  if (t.dirty && !force && !confirm(`Tutup ${shortName(t.path)} tanpa menyimpan?`)) return;
  t.view.destroy();
  tabs.splice(i, 1);
  if (tabs.length === 0) {
    activeTab = -1; renderTabs(); renderBreadcrumbs(); updateCursorStatus(); updateLangStatus();
    return;
  }
  activateTab(Math.min(i, tabs.length - 1));
}

function renderBreadcrumbs() {
  const t = tabs[activeTab];
  const bc = $("breadcrumbs");
  if (!t) { bc.innerHTML = ""; return; }
  let rel = t.path;
  if (currentFolder && t.path.startsWith(currentFolder)) {
    rel = t.path.slice(currentFolder.length).replace(/^[/\\]/, "");
  }
  bc.innerHTML = rel.split(/[/\\]/).map((p) => `<span>${escapeHtml(p)}</span>`)
    .join("<span class='sep'>›</span>");
}

// ---------------- status bar ----------------
function updateCursorStatus() {
  const t = tabs[activeTab];
  if (!t) { $("status-pos").textContent = "Ln 1, Col 1"; return; }
  const pos = t.view.state.selection.main.head;
  const line = t.view.state.doc.lineAt(pos);
  $("status-pos").textContent = `Ln ${line.number}, Col ${pos - line.from + 1}`;
}
function updateLangStatus() {
  const t = tabs[activeTab];
  $("status-lang").textContent = t ? langLabel(t.path) : "Plain Text";
}
async function refreshBranch() {
  const el = $("status-branch");
  if (!currentFolder) { el.textContent = "⎇ -"; return; }
  try {
    const b = await invoke("git_branch", { repo: currentFolder });
    el.textContent = "⎇ " + (b || "(detached)");
  } catch { el.textContent = "⎇ -"; }
}

// ---------------- terminal (multi, pty asli) ----------------
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function ensureTermTabs() {
  let c = document.querySelector(".term-tabs");
  if (!c) {
    c = document.createElement("span");
    c.className = "term-tabs";
    $("panel-header").prepend(c);
  }
  return c;
}

function activateTerm(t) {
  terms.forEach((x) => {
    const on = x === t;
    x.pane.classList.toggle("active", on);
    x.tabEl.classList.toggle("active", on);
  });
  requestAnimationFrame(() => t.fit.fit());
}

async function newTerminal() {
  termSeq++;
  const container = ensureTermTabs();
  const tabEl = document.createElement("button");
  tabEl.className = "term-tab";
  tabEl.textContent = "Terminal " + termSeq;
  container.appendChild(tabEl);
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);
  const term = new Terminal({
    cursorBlink: true, fontSize: 13,
    theme: {
      background: "#101014", foreground: "#c0caf5", cursor: "#c0caf5",
      selectionBackground: "rgba(122,162,247,.3)",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  const t = { id: null, term, fit, pane, tabEl };
  terms.push(t);
  tabEl.onclick = () => activateTerm(t);
  let cwd = currentFolder;
  if (!cwd) { try { cwd = await invoke("get_cwd"); } catch { cwd = ""; } }
  try {
    t.id = await invoke("pty_spawn", { cols: term.cols, rows: term.rows, cwd });
  } catch (err) {
    term.writeln("Gagal membuka terminal: " + err);
    return;
  }
  term.onData((d) => invoke("pty_write", { id: t.id, data: d }));
  activateTerm(t);
  fit.fit();
  $("panel").classList.remove("collapsed");
}

function togglePanel() {
  const p = $("panel");
  p.classList.toggle("collapsed");
  if (!p.classList.contains("collapsed")) {
    const t = terms.find((x) => x.pane.classList.contains("active"));
    if (t) requestAnimationFrame(() => t.fit.fit());
  }
}
function toggleSidebar() { $("sidebar").classList.toggle("hidden-bar"); }

// ---------------- git view ----------------
async function refreshGit() {
  const box = $("git-status");
  if (!currentFolder) { box.innerHTML = "<div class='hint'>Buka folder dulu.</div>"; return; }
  try {
    const files = await invoke("git_status", { repo: currentFolder });
    box.innerHTML = files.length ? "" : "<div class='hint'>Bersih — tidak ada perubahan.</div>";
    for (const f of files) {
      const d = document.createElement("div");
      d.className = "gfile";
      const st = f.status || "?";
      d.innerHTML = `<span class="badge ${escapeHtml(st[0])}">${escapeHtml(st)}</span><span></span>`;
      d.lastChild.textContent = f.path;
      d.title = f.path;
      box.appendChild(d);
    }
  } catch (err) {
    box.innerHTML = `<div class='hint'>${escapeHtml(String(err))}</div>`;
  }
}

// ---------------- global search ----------------
let searchTimer = null;
async function runSearch(q) {
  const box = $("search-results");
  if (!q.trim()) { box.innerHTML = ""; return; }
  if (!currentFolder) { box.innerHTML = "<div class='hint'>Buka folder dulu.</div>"; return; }
  box.innerHTML = "<div class='hint'>Mencari…</div>";
  try {
    const hits = await invoke("search_text", { path: currentFolder, query: q });
    if (!hits.length) { box.innerHTML = "<div class='hint'>Tidak ketemu.</div>"; return; }
    box.innerHTML = "";
    let lastFile = null;
    for (const h of hits) {
      if (h.path !== lastFile) {
        lastFile = h.path;
        const d = document.createElement("div");
        d.className = "sfile"; d.textContent = h.path;
        box.appendChild(d);
      }
      const r = document.createElement("div");
      r.className = "shit";
      const ln = document.createElement("span"); ln.className = "ln"; ln.textContent = h.line;
      const pv = document.createElement("span"); pv.className = "pv"; pv.textContent = h.preview;
      r.append(ln, pv);
      r.onclick = () => openFile(joinPath(currentFolder, h.path), h.line);
      box.appendChild(r);
    }
  } catch (err) {
    box.innerHTML = `<div class='hint'>${escapeHtml(String(err))}</div>`;
  }
}

// ---------------- command palette & quick open ----------------
const COMMANDS = [
  { label: "Buka File Cepat…", hint: "Ctrl+P", run: () => openPalette("files") },
  { label: "File: Baru", run: () => newFileHere(currentFolder) },
  { label: "Folder: Baru", run: () => newFolderHere(currentFolder) },
  { label: "Explorer: Refresh", run: () => renderTree() },
  { label: "View: Toggle Sidebar", hint: "Ctrl+B", run: () => toggleSidebar() },
  { label: "View: Toggle Terminal", hint: "Ctrl+J", run: () => togglePanel() },
  { label: "Terminal: Baru", run: () => newTerminal() },
  { label: "Cari di File…", hint: "Ctrl+Shift+F", run: () => switchView("search") },
  { label: "Git: Refresh Status", run: () => { switchView("git"); refreshGit(); } },
  { label: "Git: Commit…", run: () => { switchView("git"); $("git-msg").focus(); } },
];
let paletteMode = "commands", paletteItems = [], paletteSel = 0;

function openPalette(mode) {
  paletteMode = mode;
  $("palette").classList.remove("hidden");
  const input = $("palette-input");
  input.value = "";
  input.placeholder = mode === "files" ? "Ketik nama file…" : "Ketik perintah…";
  input.focus();
  filterPalette("");
}
function closePalette() { $("palette").classList.add("hidden"); }

function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  let qi = 0, score = 0, last = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) { score += (last === i - 1 ? 3 : 1) - i * 0.01; last = i; qi++; }
  }
  return qi === q.length ? score : -1;
}

async function filterPalette(q) {
  if (paletteMode === "commands") {
    paletteItems = COMMANDS
      .map((c) => ({ ...c, kind: "perintah", score: q ? fuzzy(q, c.label) : 0 }))
      .filter((c) => c.score >= 0)
      .sort((a, b) => b.score - a.score);
  } else {
    if (!fileCache && currentFolder) {
      fileCache = await invoke("walk_files", { path: currentFolder }).catch(() => []);
    }
    paletteItems = (fileCache || [])
      .map((f) => ({ label: shortName(f), detail: f, kind: "file", score: q ? fuzzy(q, f) : 0,
        run: () => openFile(joinPath(currentFolder, f)) }))
      .filter((c) => c.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
  }
  paletteSel = 0;
  renderPaletteItems();
}

function renderPaletteItems() {
  const list = $("palette-list");
  list.innerHTML = "";
  paletteItems.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "pitem" + (i === paletteSel ? " selected" : "");
    const k = document.createElement("span"); k.className = "kind"; k.textContent = it.kind;
    const l = document.createElement("span"); l.className = "label"; l.textContent = it.label;
    d.append(k, l);
    if (it.detail) { const dt = document.createElement("span"); dt.className = "detail"; dt.textContent = it.detail; d.appendChild(dt); }
    if (it.hint) { const h = document.createElement("span"); h.className = "detail"; h.textContent = it.hint; d.appendChild(h); }
    d.onclick = () => { closePalette(); it.run(); };
    d.onmousemove = () => { if (paletteSel !== i) { paletteSel = i; renderPaletteItems(); } };
    list.appendChild(d);
  });
  const sel = list.children[paletteSel];
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

// ---------------- view switching ----------------
function switchView(name) {
  document.querySelectorAll("#activitybar button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  ["explorer", "search", "git"].forEach((v) =>
    $("view-" + v).classList.toggle("hidden", v !== name));
  if (name === "git") refreshGit();
  if (name === "search") setTimeout(() => $("search-input").focus(), 30);
}

// ---------------- wiring ----------------
function wire() {
  document.querySelectorAll("#activitybar button").forEach((b) =>
    b.onclick = () => switchView(b.dataset.view));
  $("open-folder").onclick = () => openFolder($("folder-input").value);
  $("folder-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") openFolder(e.target.value);
  });
  $("btn-new-file").onclick = () => newFileHere(currentFolder);
  $("btn-new-folder").onclick = () => newFolderHere(currentFolder);
  $("btn-refresh-tree").onclick = () => renderTree();
  $("btn-new-term").onclick = () => newTerminal();
  $("btn-hide-panel").onclick = () => togglePanel();
  $("git-refresh").onclick = refreshGit;
  $("git-commit").onclick = async () => {
    const msg = $("git-msg").value.trim();
    if (!msg) { alert("Isi pesan commit dulu."); return; }
    try {
      $("git-out").textContent = await invoke("git_commit", { repo: currentFolder, message: msg });
      $("git-msg").value = "";
      refreshGit(); refreshBranch();
    } catch (err) { $("git-out").textContent = "Gagal: " + err; }
  };
  $("search-input").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 350);
  });

  // palette
  const pinput = $("palette-input");
  pinput.addEventListener("input", () => filterPalette(pinput.value.trim()));
  pinput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1); renderPaletteItems(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPaletteItems(); }
    else if (e.key === "Enter") { const it = paletteItems[paletteSel]; if (it) { closePalette(); it.run(); } }
    else if (e.key === "Escape") closePalette();
  });
  $("palette").addEventListener("click", (e) => { if (e.target.id === "palette") closePalette(); });

  document.addEventListener("click", (e) => {
    if (!$("ctxmenu").classList.contains("hidden") && !e.target.closest("#ctxmenu")) hideCtxMenu();
  });
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest("#tree")) return; // ditangani per-baris
    if (e.target.closest("#ctxmenu")) return;
  });
  $("tree").addEventListener("contextmenu", (e) => {
    if (e.target.closest(".trow")) return;
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
      { label: "File Baru", run: () => newFileHere(currentFolder) },
      { label: "Folder Baru", run: () => newFolderHere(currentFolder) },
      { sep: true },
      { label: "Refresh", run: () => renderTree() },
    ]);
  });

  // shortcut global
  window.addEventListener("keydown", (e) => {
    const inPalette = !$("palette").classList.contains("hidden");
    if (e.key === "Escape" && inPalette) { closePalette(); return; }
    if (!e.ctrlKey && !e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === "p" && e.shiftKey) { e.preventDefault(); inPalette ? closePalette() : openPalette("commands"); }
    else if (k === "p") { e.preventDefault(); inPalette ? closePalette() : openPalette("files"); }
    else if (k === "f" && e.shiftKey) { e.preventDefault(); switchView("search"); }
    else if (k === "b") { e.preventDefault(); toggleSidebar(); }
    else if (k === "j") { e.preventDefault(); togglePanel(); }
  });
  window.addEventListener("resize", () =>
    terms.forEach((t) => { try { t.fit.fit(); } catch { /* abaikan */ } }));
}

// ---------------- boot ----------------
(async function boot() {
  try {
    await invoke("get_cwd"); // tes jembatan IPC Tauri
  } catch {
    tauriMissing();
    return;
  }
  wire();
  $("folder-input").value = currentFolder;
  if (currentFolder) {
    try { await invoke("list_dir", { path: currentFolder }); }
    catch { currentFolder = ""; }
  }
  if (!currentFolder) {
    currentFolder = await invoke("get_cwd");
    $("folder-input").value = currentFolder;
  }
  await listen("pty-data", (e) => {
    const t = terms.find((x) => x.id === e.payload.id);
    if (t) t.term.write(base64ToBytes(e.payload.data));
  });
  await renderTree();
  refreshBranch();
  await newTerminal();
})();
