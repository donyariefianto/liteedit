// SPDX-License-Identifier: MIT
// LiteEdit — frontend ala VS Code (Dark/Light Modern).
// Editor: CodeMirror 6 · Terminal: xterm.js · Backend: Rust (Tauri invoke).

import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, highlightActiveLine } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { autocompletion } from "@codemirror/autocomplete";
import { bracketMatching, indentUnit } from "@codemirror/language";
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

// ---------------- state ----------------
const $ = (id) => document.getElementById(id);
const shortName = (p) => (p || "").split(/[\\/]/).pop() || p;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const joinPath = (base, rel) => {
  const sep = (base || "").includes("\\") ? "\\" : "/";
  return (base || "").replace(/[/\\]$/, "") + sep + String(rel).split("/").join(sep);
};

let currentFolder = localStorage.getItem("liteedit.folder") || "";
let recentFolders = [];
try { recentFolders = JSON.parse(localStorage.getItem("liteedit.recent") || "[]"); } catch { recentFolders = []; }
let recentFiles = [];
try { recentFiles = JSON.parse(localStorage.getItem("liteedit.recentFiles") || "[]"); } catch { recentFiles = []; }
let settings = { theme: "dark-modern", fontSize: 14, tabSize: 2, wordWrap: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem("liteedit.settings") || "{}")); } catch { /* abaikan */ }

const tabs = []; // { path, view, dirty, preview, untitled, langOverride }
let activeTab = -1;
let untitledSeq = 0;
const terms = []; // { id, term, fit, pane, tabEl, group, cols, rows }
let termSeq = 0;
const expanded = new Set();
const dirCache = new Map();
let fileCache = null;
const gitMap = new Map(); // abs path -> status letter
let panelView = "terminal";
let searchOpts = { case: false, word: false, regex: false };
let problems = []; // { file, line, col, sev, msg }
let chordK = false; // Ctrl+K chord
let menuOpen = null;

function saveSettings() { localStorage.setItem("liteedit.settings", JSON.stringify(settings)); }
function saveRecent() {
  localStorage.setItem("liteedit.recent", JSON.stringify(recentFolders.slice(0, 10)));
  localStorage.setItem("liteedit.recentFiles", JSON.stringify(recentFiles.slice(0, 20)));
}
function pushRecentFolder(f) {
  if (!f) return;
  recentFolders = [f, ...recentFolders.filter((x) => x !== f)].slice(0, 10);
  localStorage.setItem("liteedit.folder", f); saveRecent(); renderWelcomeRecent();
}
function pushRecentFile(f) {
  if (!f || f.startsWith("Untitled")) return;
  recentFiles = [f, ...recentFiles.filter((x) => x !== f)].slice(0, 20);
  saveRecent();
}

// ---------------- notifications & output ----------------
function notify(msg, type = "info", timeout = 4200) {
  const box = $("notifications");
  const d = document.createElement("div");
  d.className = "notif" + (type === "error" ? " error" : type === "warn" ? " warn" : type === "ok" ? " ok" : "");
  const m = document.createElement("div");
  m.className = "msg"; m.textContent = msg;
  const x = document.createElement("button");
  x.textContent = "✕"; x.onclick = () => d.remove();
  d.append(m, x); box.appendChild(d);
  log("LiteEdit", `[${type}] ${msg}`);
  setTimeout(() => { d.style.opacity = "0"; d.style.transition = "opacity .3s"; setTimeout(() => d.remove(), 320); }, timeout);
}
function log(channel, text) {
  const el = $("output-log");
  if (!el) return;
  const t = new Date().toLocaleTimeString();
  el.textContent += `[${t}] [${channel}] ${text}\n`;
  el.scrollTop = el.scrollHeight;
}

// ---------------- modal ----------------
function showModal(html) {
  $("modal").innerHTML = html;
  $("modal-overlay").classList.remove("hidden");
}
function closeModal() { $("modal-overlay").classList.add("hidden"); $("modal").innerHTML = ""; }
function confirmDialog(title, message, okLabel = "Delete") {
  return new Promise((resolve) => {
    showModal(`<div class="modal-head">${escapeHtml(title)}</div>
      <div class="modal-body"><div>${escapeHtml(message)}</div></div>
      <div class="modal-foot"><button class="btn-secondary" id="m-cancel">Cancel</button>
      <button class="btn-primary" id="m-ok">${escapeHtml(okLabel)}</button></div>`);
    $("m-cancel").onclick = () => { closeModal(); resolve(false); };
    $("m-ok").onclick = () => { closeModal(); resolve(true); };
  });
}
function promptPathDialog(title, label, initial = "") {
  return new Promise((resolve) => {
    showModal(`<div class="modal-head">${escapeHtml(title)}</div>
      <div class="modal-body"><label class="dim">${escapeHtml(label)}</label>
      <input id="m-path" value="${escapeHtml(initial)}" spellcheck="false" /></div>
      <div class="modal-foot"><button class="btn-secondary" id="m-cancel">Cancel</button>
      <button class="btn-primary" id="m-ok">Save</button></div>`);
    const inp = $("m-path"); inp.focus(); inp.select();
    const done = (v) => { closeModal(); resolve(v); };
    $("m-cancel").onclick = () => done(null);
    $("m-ok").onclick = () => done(inp.value.trim() || null);
    inp.onkeydown = (e) => { if (e.key === "Enter") done(inp.value.trim() || null); if (e.key === "Escape") done(null); };
  });
}

// ---------------- bahasa & ikon file (gaya VS Code/Seti) ----------------
const LANGS = {
  js: ["JavaScript", "#e5c07b"], mjs: ["JavaScript", "#e5c07b"], cjs: ["JavaScript", "#e5c07b"],
  ts: ["TypeScript", "#4daafc"], tsx: ["TypeScript React", "#4daafc"], jsx: ["JavaScript React", "#e5c07b"],
  py: ["Python", "#4ec9b0"], rs: ["Rust", "#ce9178"], go: ["Go", "#4ec9b0"],
  html: ["HTML", "#ce9178"], htm: ["HTML", "#ce9178"], css: ["CSS", "#4daafc"], scss: ["SCSS", "#c586c0"],
  json: ["JSON", "#e5c07b"], md: ["Markdown", "#4daafc"], markdown: ["Markdown", "#4daafc"],
  toml: ["TOML", "#ce9178"], yaml: ["YAML", "#c586c0"], yml: ["YAML", "#c586c0"],
  sh: ["Shell", "#89d185"], ps1: ["PowerShell", "#4daafc"], sql: ["SQL", "#ce9178"],
  java: ["Java", "#ce9178"], c: ["C", "#4daafc"], h: ["C++", "#c586c0"], cpp: ["C++", "#c586c0"],
  txt: ["Plain Text", "#9d9d9d"],
};
function langFor(path, override) {
  const ext = (override || path.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "js": case "mjs": case "cjs": case "jsx": return javascript({ jsx: true });
    case "ts": case "tsx": return javascript({ typescript: true, jsx: ext === "tsx" });
    case "py": return python();
    case "html": case "htm": return html();
    case "css": case "scss": return css();
    case "json": return json();
    case "md": case "markdown": return markdown();
    case "rs": return rust();
    default: return [];
  }
}
const langLabel = (p, ov) => {
  const ext = (ov || p.split(".").pop() || "").toLowerCase();
  return (LANGS[ext] || ["Plain Text"])[0];
};
const langColor = (p) => (LANGS[(p.split(".").pop() || "").toLowerCase()] || [null, "#9d9d9d"])[1];

const FILE_SVG = (color) =>
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.7"><path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6"/></svg>`;
const FOLDER_SVG = (open) =>
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="${open ? "#e5c07b" : "none"}" stroke="#e5c07b" stroke-width="1.7"><path d="M3 5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

// ---------------- editor compartments (settings live) ----------------
const fontComp = new Compartment();
const tabComp = new Compartment();
const wrapComp = new Compartment();
const themeComp = new Compartment();
function editorThemeExt() {
  if (settings.theme === "light-modern") return []; // CodeMirror default terang
  if (settings.theme === "tokyo") return tokyoNight();
  return tokyoNight(); // dark-modern: pakai Tokyo Night yg serasi
}
function editorExtensions(tab) {
  return [
    keymap.of([
      { key: "Ctrl-s", mac: "Cmd-s", run: () => { saveFile(tab); return true; } },
      ...searchKeymap,
    ]),
    basicSetup,
    fontComp.of(EditorView.theme({ "&": { fontSize: settings.fontSize + "px" } })),
    tabComp.of([EditorState.tabSize.of(settings.tabSize), indentUnit.of(" ".repeat(settings.tabSize))]),
    wrapComp.of(settings.wordWrap ? EditorView.lineWrapping : []),
    themeComp.of(editorThemeExt()),
    langFor(tab.path, tab.langOverride),
    autocompletion(),
    highlightActiveLine(),
    bracketMatching(),
    highlightSelectionMatches(),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !tab.dirty) { tab.dirty = true; if (tab.preview) tab.preview = false; renderTabs(); renderOpenEditors(); markTreeDirty(tab.path, true); }
      if (u.selectionSet || u.docChanged) { updateCursorStatus(); scheduleProblems(); }
    }),
  ];
}
function applySettingsToEditors() {
  for (const t of tabs) {
    t.view.dispatch({ effects: [
      fontComp.reconfigure(EditorView.theme({ "&": { fontSize: settings.fontSize + "px" } })),
      tabComp.reconfigure([EditorState.tabSize.of(settings.tabSize), indentUnit.of(" ".repeat(settings.tabSize))]),
      wrapComp.reconfigure(settings.wordWrap ? EditorView.lineWrapping : []),
      themeComp.reconfigure(editorThemeExt()),
    ]});
  }
}

// ---------------- explorer ----------------
function gitLetter(absPath) {
  if (gitMap.has(absPath)) return gitMap.get(absPath);
  if (!currentFolder) return "";
  const rel = absPath.startsWith(currentFolder)
    ? absPath.slice(currentFolder.length).replace(/^[/\\]/, "").split("\\").join("/")
    : null;
  if (rel && gitMap.has(rel)) return gitMap.get(rel);
  return "";
}
function treeNode(e, depth = 0) {
  const wrap = document.createElement("div");
  wrap.className = "tnode";
  const row = document.createElement("div");
  row.className = "trow";
  row.dataset.path = e.path;
  row.title = e.path;
  row.style.paddingLeft = (4 + depth * 10) + "px";
  row.draggable = false;
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = e.is_dir ? (expanded.has(e.path) ? "▾" : "▸") : "";
  const icon = document.createElement("span");
  icon.className = "ficon";
  icon.innerHTML = e.is_dir ? FOLDER_SVG(expanded.has(e.path)) : FILE_SVG(langColor(e.name));
  const nm = document.createElement("span");
  nm.className = "fname";
  nm.textContent = e.name;
  row.append(caret, icon, nm);
  const g = gitLetter(e.path);
  if (g && !e.is_dir) {
    const s = document.createElement("span");
    s.className = "git-m " + g[0];
    s.textContent = g[0] === "?" ? "U" : g[0];
    row.appendChild(s);
  }
  const t = tabs.find((x) => x.path === e.path);
  if (t) {
    row.classList.toggle("selected", tabs[activeTab] === t);
    if (t.dirty) { const d = document.createElement("span"); d.className = "git-m M"; d.textContent = "●"; d.style.fontSize = "9px"; row.appendChild(d); }
  }
  const kids = document.createElement("div");
  kids.className = "tchildren";
  kids.style.display = "none";
  if (!e.is_dir) {
    row.onclick = () => openFile(e.path, null, false);
    row.ondblclick = () => pinPreview(e.path);
  } else {
    row.onclick = () => toggleNode(e, row, kids, caret, depth);
  }
  row.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); ctxForEntry(ev, e); };
  wrap.append(row, kids);
  if (e.is_dir && expanded.has(e.path)) toggleNode(e, row, kids, caret, depth, true);
  return wrap;
}
async function toggleNode(e, row, kids, caret, depth = 0, forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : kids.style.display === "none";
  if (open) {
    let entries = dirCache.get(e.path);
    if (!entries) {
      try { entries = await invoke("list_dir", { path: e.path }); }
      catch (err) { notify("Gagal buka folder: " + err, "error"); return; }
      dirCache.set(e.path, entries);
    }
    kids.innerHTML = "";
    for (const c of entries) kids.appendChild(treeNode(c, depth + 1));
    kids.style.display = "block";
    if (caret) caret.textContent = "▾";
    const ic = row.querySelector(".ficon");
    if (ic) ic.innerHTML = FOLDER_SVG(true);
    expanded.add(e.path);
  } else {
    kids.style.display = "none";
    if (caret) caret.textContent = "▸";
    const ic = row.querySelector(".ficon");
    if (ic) ic.innerHTML = FOLDER_SVG(false);
    expanded.delete(e.path);
  }
}
async function renderTree() {
  const tree = $("tree");
  tree.innerHTML = "";
  dirCache.clear();
  const hasFolder = !!currentFolder;
  $("welcome-explorer").style.display = hasFolder ? "none" : "flex";
  $("explorer-folder-name").textContent = hasFolder ? shortName(currentFolder).toUpperCase() : "NO FOLDER OPENED";
  if (!hasFolder) return;
  try {
    const entries = await invoke("list_dir", { path: currentFolder });
    dirCache.set(currentFolder, entries);
    for (const e of entries) tree.appendChild(treeNode(e));
  } catch (err) {
    tree.innerHTML = `<div class='hint'>${escapeHtml(String(err))}</div>`;
  }
}
function markTreeDirty(path, dirty) {
  document.querySelectorAll(".trow").forEach((r) => {
    if (r.dataset.path === path) {
      let dot = r.querySelector(".git-m.M");
      if (dirty && !dot && !gitLetter(path)) {
        dot = document.createElement("span");
        dot.className = "git-m M"; dot.textContent = "●"; dot.style.fontSize = "9px";
        r.appendChild(dot);
      } else if (!dirty && dot && !gitLetter(path)) dot.remove();
    }
  });
}
function refreshTreeSelection() {
  document.querySelectorAll(".trow").forEach((r) =>
    r.classList.toggle("selected", !!tabs[activeTab] && r.dataset.path === tabs[activeTab].path));
}
async function openFolder(path, add = false) {
  path = (path || "").trim();
  if (!path) return;
  try { await invoke("list_dir", { path }); }
  catch (err) { notify("Folder tidak valid: " + err, "error"); return; }
  currentFolder = path;
  fileCache = null;
  if (!add) { /* VS Code menutup editor saat ganti folder — LiteEdit mempertahankan tab */ }
  pushRecentFolder(path);
  localStorage.setItem("liteedit.folder", path);
  $("folder-input").value = path;
  gitMap.clear();
  await renderTree();
  await refreshGit();
  await refreshBranch();
  log("LiteEdit", "Folder opened: " + path);
}

// inline input ala VS Code (bukan prompt)
function inlineTreeInput(parentRow, initial, isDir, base) {
  document.querySelectorAll(".trow.inline-edit").forEach((x) => x.remove());
  const row = document.createElement("div");
  row.className = "trow inline-edit";
  const inp = document.createElement("input");
  inp.value = initial || "";
  inp.placeholder = isDir ? "New folder name…" : "New file name…";
  inp.spellcheck = false;
  row.appendChild(inp);
  if (parentRow && parentRow.nextSibling) parentRow.parentNode.insertBefore(row, parentRow.nextSibling);
  else if (parentRow) parentRow.parentNode.appendChild(row);
  else $("tree").prepend(row);
  inp.focus(); inp.select();
  const commit = async () => {
    const v = inp.value.trim();
    row.remove();
    if (!v) return;
    const p = joinPath(base, v);
    try {
      if (isDir) await invoke("create_dir", { path: p });
      else { await invoke("create_file", { path: p }); }
      dirCache.clear(); fileCache = null;
      await renderTree();
      if (!isDir) openFile(p);
      log("LiteEdit", (isDir ? "Folder created: " : "File created: ") + p);
    } catch (err) { notify("Gagal: " + err, "error"); }
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") row.remove();
    e.stopPropagation();
  });
  inp.addEventListener("blur", () => setTimeout(() => { if (document.body.contains(row)) row.remove(); }, 150));
}
function newFileHere(base) {
  if (!base) { notify("Buka folder dulu (File → Open Folder).", "warn"); return; }
  inlineTreeInput(null, "", false, base);
}
function newFolderHere(base) {
  if (!base) { notify("Buka folder dulu.", "warn"); return; }
  inlineTreeInput(null, "", true, base);
}
function inlineRename(row, e) {
  const old = document.querySelectorAll(".trow.inline-edit");
  old.forEach((x) => x.remove());
  const edit = document.createElement("div");
  edit.className = "trow inline-edit";
  const inp = document.createElement("input");
  inp.value = shortName(e.path); inp.spellcheck = false;
  edit.appendChild(inp);
  row.parentNode.insertBefore(edit, row.nextSibling);
  row.style.display = "none";
  inp.focus(); inp.select();
  const done = async (ok) => {
    row.style.display = "";
    edit.remove();
    if (!ok) return;
    const nn = inp.value.trim();
    if (!nn || nn === shortName(e.path)) return;
    const parent = e.path.slice(0, e.path.length - shortName(e.path).length);
    const to = parent + nn;
    try {
      await invoke("rename_path", { from: e.path, to });
      const t = tabs.find((x) => x.path === e.path);
      if (t) { t.path = to; renderTabs(); renderOpenEditors(); renderBreadcrumbs(); updateLangStatus(); }
      dirCache.clear(); fileCache = null;
      await renderTree(); refreshTreeSelection();
      log("LiteEdit", `Renamed: ${e.path} → ${to}`);
    } catch (err) { notify("Gagal rename: " + err, "error"); }
  };
  inp.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") done(true);
    else if (ev.key === "Escape") done(false);
    ev.stopPropagation();
  });
  inp.addEventListener("blur", () => setTimeout(() => done(true), 200));
}
async function deleteEntry(e) {
  const ok = await confirmDialog("Delete", `Are you sure you want to delete '${e.name}'?`, "Delete");
  if (!ok) return;
  try {
    await invoke("delete_path", { path: e.path });
    const i = tabs.findIndex((t) => t.path === e.path);
    if (i >= 0) closeTab(i, true);
    dirCache.clear(); fileCache = null;
    await renderTree(); refreshGit();
    notify(`Deleted ${e.name}`, "ok", 2500);
  } catch (err) { notify("Gagal hapus: " + err, "error"); }
}

// ---------------- context menu ----------------
function showCtxMenu(x, y, items) {
  const m = $("ctxmenu");
  m.innerHTML = "";
  for (const it of items) {
    if (it.sep) { const s = document.createElement("div"); s.className = "ctxsep"; m.appendChild(s); continue; }
    const d = document.createElement("div");
    d.className = "ctxitem" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "");
    const lb = document.createElement("span"); lb.textContent = it.label;
    d.appendChild(lb);
    if (it.shortcut) { const k = document.createElement("span"); k.className = "shortcut"; k.textContent = it.shortcut; d.appendChild(k); }
    if (!it.disabled) d.onclick = () => { hideCtxMenu(); it.run && it.run(); };
    m.appendChild(d);
  }
  m.classList.remove("hidden");
  m.style.visibility = "hidden"; m.style.left = "0px"; m.style.top = "0px";
  requestAnimationFrame(() => {
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
    m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
    m.style.visibility = "";
  });
}
function hideCtxMenu() { $("ctxmenu").classList.add("hidden"); }
function ctxForEntry(ev, e) {
  const parent = e.is_dir ? e.path : e.path.slice(0, e.path.length - shortName(e.path).length).replace(/[/\\]$/, "");
  const row = ev.target.closest(".trow");
  const items = e.is_dir ? [
    { label: "New File…", run: () => inlineTreeInput(row, "", false, e.path) },
    { label: "New Folder…", run: () => inlineTreeInput(row, "", true, e.path) },
    { sep: true },
    { label: "Open Folder Here", run: () => openFolder(e.path) },
    { sep: true },
    { label: "Rename", run: () => inlineRename(row, e) },
    { label: "Delete", danger: true, run: () => deleteEntry(e) },
    { sep: true },
    { label: "Copy Path", run: () => navigator.clipboard?.writeText(e.path).then(() => notify("Path copied", "ok", 2000)) },
    { label: "Reveal in Explorer", run: () => { expanded.add(parent); renderTree(); } },
  ] : [
    { label: "Open", run: () => openFile(e.path) },
    { label: "Open to the Side", disabled: true },
    { sep: true },
    { label: "Rename", run: () => inlineRename(row, e) },
    { label: "Delete", danger: true, run: () => deleteEntry(e) },
    { sep: true },
    { label: "Copy Path", run: () => navigator.clipboard?.writeText(e.path).then(() => notify("Path copied", "ok", 2000)) },
    { label: "Copy Relative Path", run: () => {
      let rel = e.path;
      if (currentFolder && e.path.startsWith(currentFolder)) rel = e.path.slice(currentFolder.length).replace(/^[/\\]/, "");
      navigator.clipboard?.writeText(rel).then(() => notify("Relative path copied", "ok", 2000));
    } },
  ];
  showCtxMenu(ev.clientX, ev.clientY, items);
}
function ctxForTab(ev, idx) {
  const t = tabs[idx];
  const items = [
    { label: "Close", shortcut: "Ctrl+W", run: () => closeTab(idx) },
    { label: "Close Others", run: () => closeOthers(idx) },
    { label: "Close to the Right", run: () => closeToRight(idx) },
    { label: "Close All", run: () => closeAllTabs() },
    { sep: true },
    { label: "Copy Path", run: () => navigator.clipboard?.writeText(t.path) },
    { label: "Reveal in Explorer", run: () => { switchView("explorer"); refreshTreeSelection(); } },
    { sep: true },
    { label: "Keep Open (pin preview)", run: () => { t.preview = false; renderTabs(); renderOpenEditors(); } },
  ];
  showCtxMenu(ev.clientX, ev.clientY, items);
}

// ---------------- tab + editor ----------------
function hideEmptyHint() { const h = $("editor-empty"); if (h) h.style.display = "none"; }
function updateWelcome() {
  $("welcome").classList.toggle("hidden", tabs.length > 0);
  $("command-center-label").textContent = tabs[activeTab] ? shortName(tabs[activeTab].path) + (currentFolder ? " — " + shortName(currentFolder) : "") : "LiteEdit";
  document.title = tabs[activeTab] ? `${shortName(tabs[activeTab].path)} — LiteEdit` : "LiteEdit";
}
async function openFile(path, line, preview = false) {
  const existing = tabs.findIndex((t) => t.path === path);
  if (existing >= 0) {
    activateTab(existing);
    if (line) gotoLine(tabs[existing], line);
    if (!preview) { tabs[existing].preview = false; renderTabs(); renderOpenEditors(); }
    return;
  }
  let content;
  try { content = await invoke("read_file", { path }); }
  catch (err) { notify("Gagal buka file: " + err, "error"); return; }
  // preview tab: ganti preview yg ada
  if (preview) {
    const pi = tabs.findIndex((t) => t.preview);
    if (pi >= 0) closeTab(pi, true);
  }
  hideEmptyHint();
  const tab = { path, dirty: false, view: null, preview, untitled: false, langOverride: null };
  const state = EditorState.create({ doc: content, extensions: editorExtensions(tab) });
  tab.view = new EditorView({ state, parent: $("editor") });
  tab.view.dom.addEventListener("contextmenu", (e) => ctxForEditor(e, tab));
  tabs.push(tab);
  activateTab(tabs.length - 1);
  pushRecentFile(path);
  if (line) gotoLine(tab, line);
  scheduleProblems();
}
function newUntitled() {
  untitledSeq++;
  hideEmptyHint();
  const path = `Untitled-${untitledSeq}`;
  const tab = { path, dirty: false, view: null, preview: false, untitled: true, langOverride: "txt" };
  const state = EditorState.create({ doc: "", extensions: editorExtensions(tab) });
  tab.view = new EditorView({ state, parent: $("editor") });
  tab.view.dom.addEventListener("contextmenu", (e) => ctxForEditor(e, tab));
  tabs.push(tab);
  activateTab(tabs.length - 1);
}
function pinPreview(path) {
  const t = tabs.find((x) => x.path === path);
  if (t) { t.preview = false; renderTabs(); renderOpenEditors(); }
}
function gotoLine(tab, line) {
  const v = tab.view;
  const n = Math.max(1, Math.min(line, v.state.doc.lines));
  const pos = v.state.doc.line(n).from;
  v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  v.focus();
}
function gotoLineCol(tab, line, col) {
  const v = tab.view;
  const n = Math.max(1, Math.min(line, v.state.doc.lines));
  const ln = v.state.doc.line(n);
  const pos = Math.min(ln.from + Math.max(0, col - 1), ln.to);
  v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  v.focus();
}
function activateTab(i) {
  activeTab = i;
  tabs.forEach((t, j) => { t.view.dom.style.display = j === i ? "block" : "none"; });
  if (tabs[i]) { try { tabs[i].view.requestMeasure(); } catch { /* abaikan */ } tabs[i].view.focus(); }
  renderTabs(); renderBreadcrumbs(); renderOpenEditors(); updateCursorStatus(); updateLangStatus(); updateWelcome(); refreshTreeSelection(); renderOutline();
}
function renderTabs() {
  const bar = $("tabs");
  bar.innerHTML = "";
  tabs.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (i === activeTab ? " active" : "") + (t.dirty ? " dirty" : "") + (t.preview ? " preview" : "");
    el.draggable = true;
    el.title = t.path;
    el.setAttribute("role", "tab");
    const dot = document.createElement("span");
    dot.innerHTML = FILE_SVG(langColor(t.untitled ? "x.txt" : t.path));
    dot.style.display = "flex";
    const label = document.createElement("span");
    label.className = "tname";
    label.textContent = shortName(t.path);
    const tail = document.createElement("span");
    if (t.dirty) { tail.className = "dot"; tail.textContent = "●"; tail.title = "Unsaved changes"; }
    else { tail.className = "x"; tail.textContent = "×"; tail.title = "Close (Ctrl+W)"; tail.onclick = (ev) => { ev.stopPropagation(); closeTab(i); }; }
    el.append(dot, label, tail);
    el.onclick = () => activateTab(i);
    el.onauxclick = (ev) => { if (ev.button === 1) { ev.preventDefault(); closeTab(i); } };
    el.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); ctxForTab(ev, i); };
    el.ondragstart = (ev) => { ev.dataTransfer.setData("text/tab-idx", String(i)); el.classList.add("dragging"); };
    el.ondragend = () => el.classList.remove("dragging");
    el.ondragover = (ev) => ev.preventDefault();
    el.ondrop = (ev) => {
      ev.preventDefault();
      const from = Number(ev.dataTransfer.getData("text/tab-idx"));
      if (Number.isNaN(from) || from === i) return;
      const [mv] = tabs.splice(from, 1);
      tabs.splice(i, 0, mv);
      activeTab = tabs.indexOf(mv);
      renderTabs(); renderOpenEditors();
    };
    bar.appendChild(el);
  });
  updateWelcome();
}
async function saveFile(tab, saveAs = false) {
  if (tab.untitled || saveAs) {
    const guess = tab.untitled ? (currentFolder ? joinPath(currentFolder, shortName(tab.path) + ".txt") : tab.path) : tab.path;
    const p = await promptPathDialog("Save As", "Full path:", tab.untitled ? guess : tab.path);
    if (!p) return;
    try {
      await invoke("create_file", { path: p });
      await invoke("write_file", { path: p, content: withEol(tab.view.state.doc.toString()) });
      tab.path = p; tab.untitled = false; tab.dirty = false;
      renderTabs(); renderOpenEditors(); renderBreadcrumbs(); markTreeDirty(p, false);
      dirCache.clear(); fileCache = null; renderTree();
      notify("Saved " + shortName(p), "ok", 2500);
    } catch (err) { notify("Gagal simpan: " + err, "error"); }
    return;
  }
  try {
    await invoke("write_file", { path: tab.path, content: withEol(tab.view.state.doc.toString()) });
    tab.dirty = false; tab.preview = false;
    renderTabs(); renderOpenEditors(); markTreeDirty(tab.path, false);
    scheduleProblems();
  } catch (err) { notify("Gagal simpan: " + err, "error"); }
}
async function saveAll() { for (const t of tabs) if (t.dirty) await saveFile(t); }
function closeTab(i, force) {
  const t = tabs[i];
  if (!t) return;
  if (t.dirty && !force) {
    showModal(`<div class="modal-head">Do you want to save the changes?</div>
      <div class="modal-body"><div>Your changes will be lost if you don't save them: <b>${escapeHtml(shortName(t.path))}</b></div></div>
      <div class="modal-foot"><button class="btn-secondary" id="m-nosave">Don't Save</button>
      <button class="btn-secondary" id="m-cancel">Cancel</button>
      <button class="btn-primary" id="m-save">Save</button></div>`);
    $("m-nosave").onclick = () => { closeModal(); closeTab(i, true); };
    $("m-cancel").onclick = () => closeModal();
    $("m-save").onclick = async () => { closeModal(); await saveFile(t); closeTab(tabs.indexOf(t), true); };
    return;
  }
  t.view.destroy();
  tabs.splice(i, 1);
  if (tabs.length === 0) {
    activeTab = -1; renderTabs(); renderBreadcrumbs(); renderOpenEditors(); updateCursorStatus(); updateLangStatus(); updateWelcome(); renderOutline();
    return;
  }
  activateTab(Math.min(i, tabs.length - 1));
}
function closeOthers(idx) {
  const keep = tabs[idx];
  [...tabs.keys()].reverse().forEach((i) => { if (tabs[i] !== keep) { if (!tabs[i].dirty) { tabs[i].view.destroy(); tabs.splice(i, 1); } } });
  activeTab = tabs.indexOf(keep); activateTab(activeTab);
}
function closeToRight(idx) {
  for (let i = tabs.length - 1; i > idx; i--) if (!tabs[i].dirty) { tabs[i].view.destroy(); tabs.splice(i, 1); }
  renderTabs(); renderOpenEditors();
}
function closeAllTabs() {
  if (tabs.some((t) => t.dirty)) { notify("Ada tab belum disimpan — simpan dulu (Ctrl+S).", "warn"); return; }
  [...tabs].forEach((t) => t.view.destroy());
  tabs.length = 0; activeTab = -1;
  renderTabs(); renderBreadcrumbs(); renderOpenEditors(); updateCursorStatus(); updateLangStatus(); updateWelcome(); renderOutline();
}
function renderBreadcrumbs() {
  const t = tabs[activeTab];
  const bc = $("breadcrumbs");
  if (!t) { bc.innerHTML = ""; return; }
  let rel = t.path;
  if (currentFolder && t.path.startsWith(currentFolder)) rel = t.path.slice(currentFolder.length).replace(/^[/\\]/, "");
  const parts = rel.split(/[/\\]/);
  bc.innerHTML = "";
  parts.forEach((p, i) => {
    const b = document.createElement("button");
    b.className = "crumb";
    b.innerHTML = `${i === parts.length - 1 ? FILE_SVG(langColor(t.path)) : ""}<span>${escapeHtml(p)}</span>${i < parts.length - 1 ? "<span class='sep'>›</span>" : ""}`;
    b.title = t.path;
    if (i < parts.length - 1) b.onclick = () => switchView("explorer");
    bc.appendChild(b);
  });
}
function renderOpenEditors() {
  const box = $("open-editors");
  box.innerHTML = "";
  $("open-editors-count").textContent = tabs.length ? String(tabs.length) : "";
  if (!tabs.length) { box.innerHTML = "<div class='hint' style='padding:4px 20px'>No open editors.</div>"; return; }
  tabs.forEach((t, i) => {
    const d = document.createElement("div");
    d.className = "oeditor" + (i === activeTab ? " active" : "") + (t.dirty ? " dirty" : "") + (t.preview ? " preview" : "");
    d.title = t.path;
    const ic = document.createElement("span"); ic.innerHTML = FILE_SVG(langColor(t.untitled ? "x.txt" : t.path)); ic.style.display = "flex";
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = shortName(t.path);
    const x = document.createElement("span"); x.className = "x"; x.textContent = "×";
    x.onclick = (e) => { e.stopPropagation(); closeTab(i); };
    d.append(ic, nm, x);
    d.onclick = () => activateTab(i);
    d.oncontextmenu = (e) => { e.preventDefault(); ctxForTab(e, i); };
    box.appendChild(d);
  });
}
function renderOutline() {
  const box = $("outline-body");
  const t = tabs[activeTab];
  if (!t) { box.innerHTML = "<div class='hint'>No symbols found in the active editor.</div>"; return; }
  const text = t.view.state.doc.toString().split("\n");
  const syms = [];
  const ext = (t.langOverride || t.path.split(".").pop() || "").toLowerCase();
  const push = (line, kind, name) => syms.push({ line: line + 1, kind, name });
  text.forEach((ln, i) => {
    let m;
    if (["js", "ts", "tsx", "jsx", "mjs"].includes(ext)) {
      if ((m = ln.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/))) push(i, "fn", m[1]);
      else if ((m = ln.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/))) push(i, "cl", m[1]);
      else if ((m = ln.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/))) push(i, "fn", m[1]);
      else if ((m = ln.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/))) push(i, "var", m[1]);
    } else if (ext === "py") {
      if ((m = ln.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/))) push(i, "fn", m[1]);
      else if ((m = ln.match(/^\s*class\s+([A-Za-z_]\w*)/))) push(i, "cl", m[1]);
    } else if (ext === "rs") {
      if ((m = ln.match(/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/))) push(i, "fn", m[1]);
      else if ((m = ln.match(/^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/))) push(i, "cl", m[1]);
    } else {
      if ((m = ln.match(/^(#{1,3})\s+(.+)/))) push(i, "cl", m[2].slice(0, 40));
    }
  });
  if (!syms.length) { box.innerHTML = "<div class='hint'>No symbols found in the active editor.</div>"; return; }
  box.innerHTML = "";
  const icons = { fn: ["ƒ", "kind-fn"], cl: ["C", "kind-cl"], var: ["v", "kind-var"] };
  for (const s of syms.slice(0, 200)) {
    const d = document.createElement("div");
    d.className = "osym";
    const k = document.createElement("span"); k.className = "kind " + icons[s.kind][1]; k.textContent = icons[s.kind][0];
    const n = document.createElement("span"); n.textContent = `${s.name}  :${s.line}`;
    d.append(k, n);
    d.onclick = () => gotoLine(t, s.line);
    box.appendChild(d);
  }
}
function ctxForEditor(ev, tab) {
  ev.preventDefault(); ev.stopPropagation();
  const sel = tab.view.state.selection.main;
  const hasSel = !sel.empty;
  showCtxMenu(ev.clientX, ev.clientY, [
    { label: "Cut", shortcut: "Ctrl+X", disabled: !hasSel, run: () => {
      const txt = tab.view.state.sliceDoc(sel.from, sel.to);
      navigator.clipboard?.writeText(txt);
      tab.view.dispatch({ changes: { from: sel.from, to: sel.to } });
    } },
    { label: "Copy", shortcut: "Ctrl+C", disabled: !hasSel, run: () => navigator.clipboard?.writeText(tab.view.state.sliceDoc(sel.from, sel.to)) },
    { label: "Paste", shortcut: "Ctrl+V", run: async () => {
      try { const txt = await navigator.clipboard?.readText(); if (txt) tab.view.dispatch({ changes: { from: sel.from, to: sel.to, insert: txt } }); }
      catch { notify("Clipboard tidak bisa diakses.", "warn"); }
    } },
    { sep: true },
    { label: "Go to Line…", shortcut: "Ctrl+G", run: () => openPalette(":") },
    { label: "Go to Symbol…", shortcut: "Ctrl+Shift+O", run: () => openPalette("@") },
    { sep: true },
    { label: "Command Palette…", shortcut: "F1", run: () => openPalette(">") },
  ]);
}

// ---------------- status bar ----------------
function withEol(s) {
  const eol = localStorage.getItem("liteedit.eol") || "LF";
  return eol === "CRLF" ? s.replace(/\r?\n/g, "\r\n") : s.replace(/\r\n/g, "\n");
}
function updateCursorStatus() {
  const t = tabs[activeTab];
  if (!t) { $("status-pos").textContent = "Ln 1, Col 1"; return; }
  const pos = t.view.state.selection.main.head;
  const line = t.view.state.doc.lineAt(pos);
  $("status-pos").textContent = `Ln ${line.number}, Col ${pos - line.from + 1}`;
}
function updateLangStatus() {
  const t = tabs[activeTab];
  $("status-lang").textContent = t ? langLabel(t.path, t.langOverride) : "Plain Text";
  $("status-indent").textContent = (localStorage.getItem("liteedit.indentType") || "Spaces") + ": " + settings.tabSize;
  $("status-eol").textContent = localStorage.getItem("liteedit.eol") || "LF";
}
async function refreshBranch() {
  const el = $("status-branch");
  if (!currentFolder) { el.textContent = "⎇ -"; $("git-branch-label").textContent = ""; return; }
  try {
    const b = await invoke("git_branch", { repo: currentFolder });
    el.textContent = "⎇ " + (b || "(detached)");
    $("git-branch-label").textContent = b ? `on ${b}` : "";
  } catch { el.textContent = "⎇ -"; $("git-branch-label").textContent = "not a git repo"; }
}
function updateProblemsStatus() {
  const e = problems.filter((p) => p.sev === "error").length;
  const w = problems.filter((p) => p.sev === "warn").length;
  $("status-errors").textContent = `ⓧ ${e} ⚠ ${w}`;
  const c = $("problems-count");
  c.textContent = String(problems.length);
  c.classList.toggle("hidden", !problems.length);
  renderProblems();
}

// ---------------- problems (diagnostik ringan ala VS Code) ----------------
let probTimer = null;
function scheduleProblems() {
  clearTimeout(probTimer);
  probTimer = setTimeout(computeProblems, 400);
}
function computeProblems() {
  problems = [];
  for (const t of tabs) {
    if (t.untitled) continue;
    const lines = t.view.state.doc.toString().split("\n");
    lines.forEach((ln, i) => {
      const m = ln.match(/TODO|FIXME|XXX|HACK|BUG/);
      if (m) problems.push({ file: t.path, line: i + 1, col: ln.indexOf(m[0]) + 1, sev: "warn", msg: m[0] + ": " + ln.trim().slice(0, 80) });
      if (ln.length > 240) problems.push({ file: t.path, line: i + 1, col: 241, sev: "info", msg: "Line too long (" + ln.length + " chars)" });
      if (ln.trimEnd() !== ln && ln.trim() !== "") problems.push({ file: t.path, line: i + 1, col: ln.trimEnd().length + 1, sev: "info", msg: "Trailing whitespace" });
    });
  }
  updateProblemsStatus();
}
function renderProblems() {
  const box = $("problems-list");
  if (!box) return;
  box.innerHTML = "";
  if (!problems.length) { box.innerHTML = "<div class='hint'>No problems have been detected in the workspace.</div>"; return; }
  let last = null;
  const sorted = [...problems].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const p of sorted) {
    if (p.file !== last) {
      last = p.file;
      const h = document.createElement("div");
      h.className = "prob-file";
      h.textContent = shortName(p.file) + " — " + p.file;
      h.title = p.file;
      h.onclick = () => openFile(p.file, 1);
      box.appendChild(h);
    }
    const d = document.createElement("div");
    d.className = "prob-item";
    const sev = p.sev === "error" ? "ⓧ" : p.sev === "warn" ? "⚠" : "ⓘ";
    d.innerHTML = `<span class="sev-${p.sev === "error" ? "err" : p.sev === "warn" ? "warn" : "info"}">${sev}</span>
      <span>${escapeHtml(p.msg)}</span>
      <span class="dim" style="margin-left:auto">[Ln ${p.line}, Col ${p.col}]</span>`;
    d.onclick = async () => { await openFile(p.file); const t = tabs.find((x) => x.path === p.file); if (t) gotoLineCol(t, p.line, p.col); };
    box.appendChild(d);
  }
}

// ---------------- terminal (multi PTY, aksi ala VS Code) ----------------
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
// Grup split ala VS Code: terminal hasil "Split" tampil berdampingan (flex row)
// dengan grup aktif; terminal baru biasa menempati grup sendiri (ganti tab).
let termGroupSeq = 0;
const IS_WINDOWS = /win/i.test(navigator.userAgent || navigator.platform || "");
const TERM_FONT = "'Cascadia Code', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace";
function activeTermObj() {
  return terms.find((x) => x.tabEl.classList.contains("active")) || terms[terms.length - 1] || null;
}
// samakan viewport xterm dgn PTY backend — wajib tiap selesai fit,
// di semua OS, kalau tidak teks wrap/garble (backend spawn dgn ukuran lama)
async function syncTermSize(t) {
  if (!t || !t.pane.classList.contains("active")) return;
  try { t.fit.fit(); } catch { return; }
  const cols = t.term.cols || 0, rows = t.term.rows || 0;
  if (!t.id || cols <= 0 || rows <= 0) return;
  if (cols === t.cols && rows === t.rows) return;
  t.cols = cols; t.rows = rows;
  try { await invoke("pty_resize", { id: t.id, cols, rows }); } catch { /* abaikan */ }
}
function activateTerm(t) {
  if (!t) return;
  const visible = terms.filter((x) => x.group === t.group);
  terms.forEach((x) => {
    x.pane.classList.toggle("active", x.group === t.group);
    x.tabEl.classList.toggle("active", x === t);
  });
  // garis pemisah antar pane yg berdampingan
  visible.forEach((x, i) => { x.pane.style.borderLeft = i ? "1px solid var(--border-strong)" : ""; });
  requestAnimationFrame(() => { visible.forEach((x) => syncTermSize(x)); });
}
async function newTerminal(opts = {}) {
  const cur = activeTermObj();
  termSeq++;
  const container = $("term-tabs");
  const tabEl = document.createElement("button");
  tabEl.className = "term-tab";
  tabEl.innerHTML = `<span>Terminal ${termSeq}</span>`;
  const x = document.createElement("span");
  x.className = "x"; x.textContent = "×"; x.title = "Kill terminal";
  x.onclick = (e) => { e.stopPropagation(); killTerminal(terms.find((v) => v.tabEl === tabEl)); };
  tabEl.appendChild(x);
  container.appendChild(tabEl);
  const pane = document.createElement("div");
  pane.className = "term-pane";
  $("terminals").appendChild(pane);
  const t = { id: null, term: null, fit: null, pane, tabEl, group: 0, cols: 0, rows: 0 };
  terms.push(t);
  if (opts.split && cur) t.group = cur.group; // split: berdampingan dgn yg aktif
  else t.group = ++termGroupSeq;               // baru: grup sendiri (ganti tab)
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, fontFamily: TERM_FONT,
    theme: settings.theme === "light-modern"
      ? { background: "#ffffff", foreground: "#1f1f1f", cursor: "#005fb8", selectionBackground: "rgba(0,95,184,.25)" }
      : { background: "#1f1f1f", foreground: "#cccccc", cursor: "#cccccc", selectionBackground: "rgba(0,120,212,.35)",
          black: "#121212", red: "#f14c4c", green: "#89d185", yellow: "#e5c07b", blue: "#4daafc", magenta: "#c586c0", cyan: "#4ec9b0", white: "#cccccc" },
  });
  const fit = new FitAddon();
  t.term = term; t.fit = fit;
  term.loadAddon(fit);
  tabEl.onclick = () => activateTerm(t);
  pane.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
      { label: "Copy selection", run: () => { const s = term.getSelection(); if (s) navigator.clipboard?.writeText(s); } },
      { label: "Paste", run: async () => { try { const v = await navigator.clipboard?.readText(); if (v && t.id) invoke("pty_write", { id: t.id, data: v }); } catch { /* abaikan */ } } },
      { sep: true },
      { label: "Clear", run: () => term.clear() },
      { label: "Kill Terminal", danger: true, run: () => killTerminal(t) },
    ]);
  });
  // panel HARUS tampil dulu: open()+fit() di elemen hidden mengukur 0
  switchPanel("terminal");
  $("panel").classList.remove("collapsed");
  term.open(pane);
  activateTerm(t);
  // ukur ukuran asli SESUDAH tampil, spawn PTY langsung dgn ukuran itu
  let cols = 80, rows = 24;
  try { fit.fit(); cols = term.cols || 80; rows = term.rows || 24; } catch { /* abaikan */ }
  let cwd = currentFolder;
  if (!cwd) { try { cwd = await invoke("get_cwd"); } catch { cwd = ""; } }
  try {
    t.id = await invoke("pty_spawn", { cols, rows, cwd });
    t.cols = cols; t.rows = rows;
    log("Terminal", `shell started (Terminal ${termSeq}) ${cols}x${rows} cwd=${cwd}`);
  } catch (err) {
    term.writeln("Gagal membuka terminal: " + err);
    return;
  }
  term.onData((d) => { if (t.id) invoke("pty_write", { id: t.id, data: d }); });
  setTimeout(() => syncTermSize(t), 80); // jaga-jaga font/layout telat
}
async function killTerminal(t) {
  if (!t) t = terms.find((x) => x.pane.classList.contains("active"));
  if (!t) return;
  try { if (t.id) await invoke("pty_kill", { id: t.id }); } catch { /* abaikan */ }
  t.tabEl.remove(); t.pane.remove();
  terms.splice(terms.indexOf(t), 1);
  log("Terminal", "shell killed");
  if (terms.length) activateTerm(terms[terms.length - 1]);
}
function togglePanel() {
  $("panel").classList.toggle("collapsed");
  if (!$("panel").classList.contains("collapsed")) {
    const t = activeTermObj();
    if (t) setTimeout(() => { terms.filter((x) => x.group === t.group).forEach((x) => syncTermSize(x)); }, 50);
  }
}
function toggleSidebar() {
  const s = $("sidebar");
  s.style.display = s.style.display === "none" ? "" : "none";
  $("sidebar-resize").style.display = s.style.display === "none" ? "none" : "";
}

// ---------------- git view (Changes + badge ala VS Code) ----------------
async function refreshGit() {
  const box = $("git-status");
  if (!currentFolder) { box.innerHTML = "<div class='hint'>Open a folder to use source control.</div>"; $("git-badge").classList.add("hidden"); gitMap.clear(); return; }
  try {
    const files = await invoke("git_status", { repo: currentFolder });
    gitMap.clear();
    for (const f of files) {
      gitMap.set(f.path, f.status || "?");
      gitMap.set(joinPath(currentFolder, f.path), f.status || "?");
    }
    const badge = $("git-badge");
    badge.textContent = String(files.length);
    badge.classList.toggle("hidden", !files.length);
    box.innerHTML = "";
    if (!files.length) { box.innerHTML = "<div class='hint'>No changes detected. Working tree clean.</div>"; }
    else {
      const h = document.createElement("div");
      h.className = "git-group";
      h.innerHTML = `<span>CHANGES</span><span class="cnt">${files.length}</span>`;
      box.appendChild(h);
    }
    for (const f of files) {
      const st = (f.status || "?")[0] === "?" ? "?" : (f.status || "?");
      const d = document.createElement("div");
      d.className = "gfile";
      d.title = joinPath(currentFolder, f.path);
      const b = document.createElement("span");
      b.className = "badge " + (st[0] === "?" ? "?" : st[0]);
      b.textContent = st[0] === "?" ? "U" : st;
      const p = document.createElement("span");
      p.className = "path"; p.textContent = f.path;
      const acts = document.createElement("span");
      acts.className = "acts";
      const open = document.createElement("button"); open.textContent = "○"; open.title = "Open File";
      open.onclick = (e) => { e.stopPropagation(); openFile(joinPath(currentFolder, f.path)); };
      const cp = document.createElement("button"); cp.textContent = "⧉"; cp.title = "Copy Path";
      cp.onclick = (e) => { e.stopPropagation(); navigator.clipboard?.writeText(joinPath(currentFolder, f.path)); };
      acts.append(open, cp);
      d.append(b, p, acts);
      d.onclick = () => openFile(joinPath(currentFolder, f.path));
      box.appendChild(d);
    }
    log("Git", `status: ${files.length} changed file(s)`);
    if (dirCache.has(currentFolder)) { renderTree(); refreshTreeSelection(); }
  } catch (err) {
    box.innerHTML = `<div class='hint'>${escapeHtml(String(err))}</div>`;
    $("git-badge").classList.add("hidden");
  }
}

// ---------------- global search (filter ala VS Code) ----------------
let searchTimer = null;
function globToReg(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + esc + "$", "i");
}
function matchGlobs(rel, globs) {
  if (!globs.length) return false;
  return globs.some((g) => {
    g = g.trim();
    if (!g) return false;
    if (!g.includes("*") && !g.includes("?")) return rel.toLowerCase().includes(g.toLowerCase());
    return globToReg(g).test(rel) || globToReg("**/" + g).test(rel);
  });
}
async function runSearch() {
  const q = $("search-input").value;
  const box = $("search-results");
  const cnt = $("search-count");
  if (!q) { box.innerHTML = ""; cnt.textContent = ""; return; }
  if (!currentFolder) { box.innerHTML = "<div class='hint'>Open a folder first.</div>"; return; }
  box.innerHTML = "<div class='hint'>Searching…</div>";
  const repl = $("replace-input").value;
  void repl;
  try {
    if (!fileCache) fileCache = await invoke("walk_files", { path: currentFolder }).catch(() => []);
    const inc = $("search-include").value.split(",").map((s) => s.trim()).filter(Boolean);
    const exc = $("search-exclude").value.split(",").map((s) => s.trim()).filter(Boolean);
    let re = null;
    if (searchOpts.regex) {
      try { re = new RegExp(q, searchOpts.case ? "g" : "gi"); }
      catch (err) { box.innerHTML = `<div class='hint'>Invalid regex: ${escapeHtml(String(err))}</div>`; return; }
    }
    const testLine = (line) => {
      if (searchOpts.regex) {
        re.lastIndex = 0;
        const m = re.exec(line);
        if (!m) return null;
        return { idx: m.index, len: m[0].length };
      }
      const hay = searchOpts.case ? line : line.toLowerCase();
      const nd = searchOpts.case ? q : q.toLowerCase();
      const idx = hay.indexOf(nd);
      if (idx < 0) return null;
      if (searchOpts.word) {
        const isW = (c) => /[A-Za-z0-9_]/.test(c || "");
        if (isW(line[idx - 1]) || isW(line[idx + nd.length])) {
          // cari kemunculan berikutnya yg word-boundary
          let from = idx + 1;
          while (true) {
            const j = hay.indexOf(nd, from);
            if (j < 0) return null;
            if (!isW(line[j - 1]) && !isW(line[j + nd.length])) return { idx: j, len: nd.length };
            from = j + 1;
          }
        }
      }
      return { idx, len: nd.length };
    };
    const files = (fileCache || []).filter((rel) => {
      if (inc.length && !matchGlobs(rel, inc)) return false;
      if (matchGlobs(rel, exc)) return false;
      return true;
    }).slice(0, 1200);
    const hits = [];
    const batch = 12;
    for (let i = 0; i < files.length && hits.length < 500; i += batch) {
      const chunk = files.slice(i, i + batch);
      const contents = await Promise.all(chunk.map(async (rel) => {
        try {
          // skip file besar / biner berdasar ekstensi umum
          if (/\.(png|jpe?g|gif|ico|pdf|zip|exe|dll|so|bin|dat|mp4|mp3)$/i.test(rel)) return null;
          const c = await invoke("read_file", { path: joinPath(currentFolder, rel) });
          if (c.length > 512 * 1024) return null;
          return c;
        } catch { return null; }
      }));
      contents.forEach((c, k) => {
        if (c == null || hits.length >= 500) return;
        c.split("\n").forEach((ln, li) => {
          if (hits.length >= 500) return;
          const m = testLine(ln);
          if (m) hits.push({ path: files[i + k], line: li + 1, preview: ln.trim().slice(0, 160), idx: Math.max(0, m.idx - 20), len: m.len });
        });
      });
    }
    if (!hits.length) { box.innerHTML = "<div class='hint'>No results found.</div>"; cnt.textContent = "No results"; return; }
    cnt.textContent = `${hits.length} result(s)`;
    box.innerHTML = "";
    let lastFile = null;
    let group = null;
    for (const h of hits) {
      if (h.path !== lastFile) {
        lastFile = h.path;
        const n = hits.filter((x) => x.path === h.path).length;
        group = document.createElement("div");
        const hd = document.createElement("div");
        hd.className = "sfile-header";
        hd.innerHTML = `<span class="twisty">▾</span><span>${escapeHtml(h.path)}</span><span class="cnt">${n}</span>`;
        const items = document.createElement("div");
        hd.onclick = () => {
          const hid = items.style.display === "none";
          items.style.display = hid ? "" : "none";
          hd.querySelector(".twisty").textContent = hid ? "▾" : "▸";
        };
        group.append(hd, items);
        box.appendChild(group);
        group = items;
      }
      const r = document.createElement("div");
      r.className = "shit";
      const ln = document.createElement("span"); ln.className = "ln"; ln.textContent = h.line;
      const pv = document.createElement("span"); pv.className = "pv";
      const raw = h.preview;
      const relIdx = raw.toLowerCase().indexOf(q.toLowerCase());
      if (!searchOpts.regex && relIdx >= 0) {
        pv.innerHTML = `${escapeHtml(raw.slice(0, relIdx))}<mark>${escapeHtml(raw.slice(relIdx, relIdx + q.length))}</mark>${escapeHtml(raw.slice(relIdx + q.length))}`;
      } else pv.textContent = raw;
      r.append(ln, pv);
      r.title = h.path + ":" + h.line;
      r.onclick = () => openFile(joinPath(currentFolder, h.path), h.line, false);
      group.appendChild(r);
    }
  } catch (err) {
    box.innerHTML = `<div class='hint'>${escapeHtml(String(err))}</div>`;
  }
}
async function replaceAll() {
  const q = $("search-input").value;
  const rep = $("replace-input").value;
  if (!q) { notify("Isi kolom Search dulu.", "warn"); return; }
  if (!currentFolder) return;
  const rows = document.querySelectorAll("#search-results .shit");
  if (!rows.length) { notify("Tidak ada hasil untuk di-replace.", "warn"); return; }
  const byFile = new Map();
  rows.forEach((r) => {
    const t = r.title; // path:line
    const i = t.lastIndexOf(":");
    byFile.set(t.slice(0, i), (byFile.get(t.slice(0, i)) || 0) + 1);
  });
  let done = 0;
  for (const [rel] of byFile) {
    try {
      const abs = joinPath(currentFolder, rel);
      let c = await invoke("read_file", { path: abs });
      if (searchOpts.regex) {
        const re = new RegExp(q, searchOpts.case ? "g" : "gi");
        c = c.replace(re, rep);
      } else if (searchOpts.case) c = c.split(q).join(rep);
      else c = c.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), rep);
      await invoke("write_file", { path: abs, content: c });
      done++;
      const t = tabs.find((x) => x.path === abs);
      if (t) { // refresh tab yg terbuka
        const cur = t.view.state.selection.main.head;
        t.view.dispatch({ changes: { from: 0, to: t.view.state.doc.length, insert: c } });
        try { t.view.dispatch({ selection: { anchor: Math.min(cur, c.length) } }); } catch { /* abaikan */ }
      }
    } catch (err) { notify("Replace gagal di " + rel + ": " + err, "error"); }
  }
  notify(`Replaced in ${done} file(s).`, "ok");
  runSearch();
}

// ---------------- command palette & quick open (prefix ala VS Code) ----------------
let paletteItems = [], paletteSel = 0, paletteMode = ">";
function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  let qi = 0, score = 0, last = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) { score += (last === i - 1 ? 3 : 1) - i * 0.01; last = i; qi++; }
  }
  return qi === q.length ? score : -1;
}
function hiLabel(label, q) {
  if (!q) return escapeHtml(label);
  const i = label.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) {
    // fuzzy highlight per karakter
    let out = "", qi = 0;
    const ql = q.toLowerCase();
    for (const ch of label) {
      if (qi < ql.length && ch.toLowerCase() === ql[qi]) { out += `<mark>${escapeHtml(ch)}</mark>`; qi++; }
      else out += escapeHtml(ch);
    }
    return out;
  }
  return escapeHtml(label.slice(0, i)) + "<mark>" + escapeHtml(label.slice(i, i + q.length)) + "</mark>" + escapeHtml(label.slice(i + q.length));
}
const COMMANDS = [
  { label: "File: New Untitled File", hint: "Ctrl+N", run: () => newUntitled() },
  { label: "File: Open Folder…", hint: "Ctrl+O", run: () => { $("folder-input").focus(); $("folder-input").select(); switchView("explorer"); } },
  { label: "File: Save", hint: "Ctrl+S", run: () => { if (tabs[activeTab]) saveFile(tabs[activeTab]); } },
  { label: "File: Save As…", run: () => { if (tabs[activeTab]) saveFile(tabs[activeTab], true); } },
  { label: "File: Save All", run: () => saveAll() },
  { label: "File: Close Editor", hint: "Ctrl+W", run: () => { if (activeTab >= 0) closeTab(activeTab); } },
  { label: "File: Close All Editors", run: () => closeAllTabs() },
  { label: "View: Toggle Primary Side Bar", hint: "Ctrl+B", run: () => toggleSidebar() },
  { label: "View: Toggle Panel", hint: "Ctrl+J", run: () => togglePanel() },
  { label: "View: Maximize Panel", run: () => $("panel").classList.toggle("maximized") },
  { label: "View: Explorer", hint: "Ctrl+Shift+E", run: () => switchView("explorer") },
  { label: "View: Search", hint: "Ctrl+Shift+F", run: () => switchView("search") },
  { label: "View: Source Control", hint: "Ctrl+Shift+G", run: () => switchView("git") },
  { label: "View: Run and Debug", hint: "Ctrl+Shift+D", run: () => switchView("run") },
  { label: "View: Extensions", hint: "Ctrl+Shift+X", run: () => switchView("extensions") },
  { label: "View: Show Problems", run: () => switchPanel("problems") },
  { label: "View: Show Output", run: () => switchPanel("output") },
  { label: "View: Show Terminal", run: () => switchPanel("terminal") },
  { label: "Go to File…", hint: "Ctrl+P", run: () => openPalette("") },
  { label: "Go to Line…", hint: "Ctrl+G", run: () => openPalette(":") },
  { label: "Go to Symbol…", hint: "Ctrl+Shift+O", run: () => openPalette("@") },
  { label: "Terminal: Create New Terminal", hint: "Ctrl+Shift+`", run: () => newTerminal() },
  { label: "Terminal: Kill Active Terminal", run: () => killTerminal() },
  { label: "Git: Refresh Status", run: () => { switchView("git"); refreshGit(); } },
  { label: "Git: Commit…", run: () => { switchView("git"); $("git-msg").focus(); } },
  { label: "Explorer: Refresh", run: () => renderTree() },
  { label: "Explorer: Collapse Folders", run: () => { expanded.clear(); renderTree(); } },
  { label: "Explorer: New File…", run: () => newFileHere(currentFolder) },
  { label: "Explorer: New Folder…", run: () => newFolderHere(currentFolder) },
  { label: "Run: Run Active File in Terminal", run: () => runActiveFile() },
  { label: "Run: Start Debugging", run: () => runActiveFile(true) },
  { label: "Preferences: Open Settings", hint: "Ctrl+,", run: () => openSettings() },
  { label: "Preferences: Color Theme", hint: "Ctrl+K T", run: () => openThemes() },
  { label: "Preferences: Keyboard Shortcuts", hint: "Ctrl+K S", run: () => openShortcuts() },
  { label: "Preferences: Toggle Word Wrap", run: () => { settings.wordWrap = !settings.wordWrap; saveSettings(); applySettingsToEditors(); notify("Word wrap " + (settings.wordWrap ? "on" : "off"), "ok", 2000); } },
  { label: "View: Zoom In (editor font)", hint: "Ctrl+=", run: () => { settings.fontSize = Math.min(28, settings.fontSize + 1); saveSettings(); applySettingsToEditors(); } },
  { label: "View: Zoom Out (editor font)", hint: "Ctrl+-", run: () => { settings.fontSize = Math.max(9, settings.fontSize - 1); saveSettings(); applySettingsToEditors(); } },
  { label: "Help: About LiteEdit", run: () => openAbout() },
];
function openPalette(initial = ">") {
  $("palette").classList.remove("hidden");
  $("palette-overlay").classList.remove("hidden");
  const input = $("palette-input");
  input.value = initial;
  input.focus(); input.select();
  filterPalette(input.value);
}
function closePalette() { $("palette").classList.add("hidden"); $("palette-overlay").classList.add("hidden"); }
async function filterPalette(raw) {
  const first = raw[0];
  let mode = ">", q = raw;
  if (first === ">" || first === "@" || first === ":" || first === "#" || first === "?") { mode = first; q = raw.slice(1).trim(); }
  else if (raw === "") { mode = ""; q = ""; }
  else { mode = ""; q = raw.trim(); }
  paletteMode = mode;
  $("palette-prefix").textContent = mode === "" ? "○" : mode;
  $("palette-input").placeholder =
    mode === ">" ? "Type a command…" : mode === "@" ? "Go to symbol…" :
    mode === ":" ? "Go to line (e.g. 42 or 42:5)…" : mode === "#" ? "Recent…" :
    mode === "?" ? "Available prefixes: › @ : #" : "Type file name…";
  if (mode === ">") {
    paletteItems = COMMANDS
      .map((c) => ({ ...c, kind: "cmd", score: q ? fuzzy(q, c.label) : 0 }))
      .filter((c) => c.score >= 0).sort((a, b) => b.score - a.score).slice(0, 60);
  } else if (mode === "@") {
    const t = tabs[activeTab];
    const syms = [];
    if (t) {
      t.view.state.doc.toString().split("\n").forEach((ln, i) => {
        const m = ln.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|fn|struct)\s+([A-Za-z_]\w*)|^\s*(?:const|let|var)\s+([A-Za-z_]\w*)/);
        const name = m && (m[1] || m[2]);
        if (name) syms.push({ label: `${name}  :${i + 1}`, kind: "sym", score: q ? fuzzy(q, name) : 0, run: () => gotoLine(t, i + 1) });
      });
    }
    paletteItems = syms.filter((c) => c.score >= 0).slice(0, 60);
  } else if (mode === ":") {
    paletteItems = [{
      label: `Go to line ${q || "…"}`, kind: "line", score: 0,
      run: () => {
        const t = tabs[activeTab]; if (!t) return;
        const [l, c] = q.split(":").map(Number);
        if (l) gotoLineCol(t, l, c || 1);
      },
    }];
  } else if (mode === "#") {
    const all = [...recentFiles.map((f) => ({ f, k: "recent" })), ...recentFolders.map((f) => ({ f, k: "folder" }))];
    paletteItems = all
      .map((x) => ({ label: shortName(x.f), detail: x.f, kind: x.k, score: q ? fuzzy(q, x.f) : 0,
        run: () => { if (x.k === "folder") openFolder(x.f); else openFile(x.f); } }))
      .filter((c) => c.score >= 0).slice(0, 30);
  } else if (mode === "?") {
    paletteItems = [
      { label: "›  Show all commands", kind: "help", score: 0, run: () => openPalette(">") },
      { label: "○  Go to file (default)", kind: "help", score: 0, run: () => openPalette("") },
      { label: "@  Go to symbol in active file", kind: "help", score: 0, run: () => openPalette("@") },
      { label: ":  Go to line", kind: "help", score: 0, run: () => openPalette(":") },
      { label: "#  Recent files & folders", kind: "help", score: 0, run: () => openPalette("#") },
    ];
  } else {
    if (!fileCache && currentFolder) fileCache = await invoke("walk_files", { path: currentFolder }).catch(() => []);
    paletteItems = (fileCache || [])
      .map((f) => ({ label: shortName(f), detail: f, kind: "file", icon: FILE_SVG(langColor(f)), score: q ? fuzzy(q, f) : 0,
        run: () => openFile(joinPath(currentFolder, f)) }))
      .filter((c) => c.score >= 0).sort((a, b) => b.score - a.score).slice(0, 60);
  }
  paletteSel = 0;
  renderPaletteItems(q);
}
function renderPaletteItems(q = "") {
  const list = $("palette-list");
  list.innerHTML = "";
  if (!paletteItems.length) { list.innerHTML = "<div class='hint'>No matching results.</div>"; return; }
  paletteItems.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "pitem" + (i === paletteSel ? " selected" : "");
    if (it.icon) { const k = document.createElement("span"); k.className = "ficon"; k.innerHTML = it.icon; d.appendChild(k); }
    else { const k = document.createElement("span"); k.className = "kind"; k.textContent = it.kind; d.appendChild(k); }
    const l = document.createElement("span"); l.className = "label"; l.innerHTML = hiLabel(it.label, paletteMode === ":" ? "" : q);
    d.appendChild(l);
    if (it.detail) { const dt = document.createElement("span"); dt.className = "detail"; dt.textContent = it.detail; d.appendChild(dt); }
    if (it.hint) { const h = document.createElement("span"); h.className = "detail"; h.textContent = it.hint; d.appendChild(h); }
    d.onclick = () => { closePalette(); it.run(); };
    d.onmousemove = () => { if (paletteSel !== i) { paletteSel = i; renderPaletteItems(q); } };
    list.appendChild(d);
  });
  const sel = list.children[paletteSel];
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

// ---------------- view & panel switching ----------------
function switchView(name) {
  document.querySelectorAll("#activitybar [data-view]").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  ["explorer", "search", "git", "run", "extensions"].forEach((v) =>
    $("view-" + v).classList.toggle("hidden", v !== name));
  if (name === "git") refreshGit();
  if (name === "search") setTimeout(() => $("search-input").focus(), 30);
  // kalau sidebar disembunyikan, tampilkan lagi
  if ($("sidebar").style.display === "none") toggleSidebar();
}
function switchPanel(name) {
  panelView = name;
  document.querySelectorAll(".ptab").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
  $("panel-problems").classList.toggle("hidden", name !== "problems");
  $("panel-output").classList.toggle("hidden", name !== "output");
  $("panel-debug").classList.toggle("hidden", name !== "debug");
  $("terminals").style.display = name === "terminal" ? "" : "none";
  $("panel").classList.remove("collapsed");
  if (name === "terminal") {
    const t = activeTermObj();
    if (t) setTimeout(() => { terms.filter((x) => x.group === t.group).forEach((x) => syncTermSize(x)); }, 50);
  }
}

// ---------------- run active file ----------------
async function runActiveFile(debug = false) {
  const t = tabs[activeTab];
  if (!t || t.untitled) { notify("Buka & simpan file dulu untuk di-run.", "warn"); return; }
  if (t.dirty) await saveFile(t);
  const ext = t.path.split(".").pop().toLowerCase();
  let cmd;
  if (ext === "py") cmd = `${IS_WINDOWS ? "python" : "python3"} "${t.path}"`;
  else if (["js", "mjs", "cjs"].includes(ext)) cmd = `node "${t.path}"`;
  else if (ext === "ts") cmd = `npx ts-node "${t.path}"`;
  else if (ext === "rs") cmd = `cargo run`;
  else if (ext === "go") cmd = `go run "${t.path}"`;
  else if (ext === "html") { notify("File HTML: buka manual di browser.", "warn"); return; }
  else cmd = `"${t.path}"`;
  if (!terms.length) await newTerminal();
  const term = terms.find((x) => x.pane.classList.contains("active")) || terms[terms.length - 1];
  switchPanel("terminal");
  $("panel").classList.remove("collapsed");
  activateTerm(term);
  if (term.id) {
    await invoke("pty_write", { id: term.id, data: cmd + "\r" });
    log("Terminal", (debug ? "[debug] " : "[run] ") + cmd);
  }
}

// ---------------- menus (File/Edit/…/Help ala VS Code) ----------------
const MENUS = {
  file: [
    { label: "New Untitled File", shortcut: "Ctrl+N", run: () => newUntitled() },
    { label: "New File in Folder…", run: () => newFileHere(currentFolder) },
    { label: "New Folder…", run: () => newFolderHere(currentFolder) },
    { sep: true },
    { label: "Open Folder…", shortcut: "Ctrl+O", run: () => { switchView("explorer"); $("folder-input").focus(); $("folder-input").select(); } },
    { label: "Open Recent…", run: () => openPalette("#") },
    { sep: true },
    { label: "Save", shortcut: "Ctrl+S", run: () => tabs[activeTab] && saveFile(tabs[activeTab]) },
    { label: "Save As…", run: () => tabs[activeTab] && saveFile(tabs[activeTab], true) },
    { label: "Save All", run: () => saveAll() },
    { sep: true },
    { label: "Close Editor", shortcut: "Ctrl+W", run: () => activeTab >= 0 && closeTab(activeTab) },
    { label: "Close Folder", run: () => { currentFolder = ""; localStorage.removeItem("liteedit.folder"); $("folder-input").value = ""; fileCache = null; renderTree(); refreshBranch(); } },
  ],
  edit: [
    { label: "Undo", shortcut: "Ctrl+Z", run: () => document.execCommand("undo") },
    { label: "Redo", shortcut: "Ctrl+Y", run: () => document.execCommand("redo") },
    { sep: true },
    { label: "Cut", shortcut: "Ctrl+X", run: () => document.execCommand("cut") },
    { label: "Copy", shortcut: "Ctrl+C", run: () => document.execCommand("copy") },
    { label: "Paste", shortcut: "Ctrl+V", run: () => document.execCommand("paste") },
    { sep: true },
    { label: "Find in File", shortcut: "Ctrl+F", run: () => tabs[activeTab]?.view.focus() },
    { label: "Find in Files", shortcut: "Ctrl+Shift+F", run: () => switchView("search") },
    { label: "Replace in Files", run: () => { switchView("search"); $("replace-row").classList.remove("hidden"); } },
  ],
  selection: [
    { label: "Select All", shortcut: "Ctrl+A", run: () => { const t = tabs[activeTab]; if (t) t.view.dispatch({ selection: { anchor: 0, head: t.view.state.doc.length } }); } },
    { label: "Expand Selection", shortcut: "Shift+Alt+→", run: () => notify("Expand selection belum didukung.", "warn") },
    { label: "Go to Line…", shortcut: "Ctrl+G", run: () => openPalette(":") },
  ],
  view: [
    { label: "Command Palette…", shortcut: "F1", run: () => openPalette(">") },
    { label: "Open View: Explorer", shortcut: "Ctrl+Shift+E", run: () => switchView("explorer") },
    { label: "Open View: Search", shortcut: "Ctrl+Shift+F", run: () => switchView("search") },
    { label: "Open View: Source Control", shortcut: "Ctrl+Shift+G", run: () => switchView("git") },
    { sep: true },
    { label: "Toggle Primary Side Bar", shortcut: "Ctrl+B", run: () => toggleSidebar() },
    { label: "Toggle Panel", shortcut: "Ctrl+J", run: () => togglePanel() },
    { label: "Maximize Panel", run: () => $("panel").classList.toggle("maximized") },
    { sep: true },
    { label: "Color Theme…", shortcut: "Ctrl+K T", run: () => openThemes() },
    { label: "Zoom In", shortcut: "Ctrl+=", run: () => { settings.fontSize++; saveSettings(); applySettingsToEditors(); } },
    { label: "Zoom Out", shortcut: "Ctrl+-", run: () => { settings.fontSize--; saveSettings(); applySettingsToEditors(); } },
  ],
  go: [
    { label: "Go to File…", shortcut: "Ctrl+P", run: () => openPalette("") },
    { label: "Go to Symbol…", shortcut: "Ctrl+Shift+O", run: () => openPalette("@") },
    { label: "Go to Line…", shortcut: "Ctrl+G", run: () => openPalette(":") },
    { sep: true },
    { label: "Back to Explorer", run: () => switchView("explorer") },
  ],
  run: [
    { label: "Run Active File", run: () => runActiveFile() },
    { label: "Start Debugging", run: () => runActiveFile(true) },
  ],
  terminal: [
    { label: "New Terminal", shortcut: "Ctrl+Shift+`", run: () => newTerminal() },
    { label: "Split Terminal (Side by Side)", run: () => newTerminal({ split: true }) },
    { label: "Kill Active Terminal", run: () => killTerminal() },
  ],
  help: [
    { label: "Keyboard Shortcuts", run: () => openShortcuts() },
    { label: "Color Themes", run: () => openThemes() },
    { sep: true },
    { label: "About LiteEdit", run: () => openAbout() },
  ],
};
function toggleMenu(name, anchor) {
  const dd = $("menudropdown");
  if (menuOpen === name) { dd.classList.add("hidden"); menuOpen = null; return; }
  menuOpen = name;
  document.querySelectorAll(".menu-top").forEach((b) => b.classList.toggle("open", b.dataset.menu === name));
  dd.innerHTML = "";
  for (const it of MENUS[name] || []) {
    if (it.sep) { const s = document.createElement("div"); s.className = "menu-sep"; dd.appendChild(s); continue; }
    const d = document.createElement("div");
    d.className = "menu-item";
    const lb = document.createElement("span"); lb.textContent = it.label;
    d.appendChild(lb);
    if (it.shortcut) { const k = document.createElement("span"); k.className = "shortcut"; k.textContent = it.shortcut; d.appendChild(k); }
    d.onclick = () => { dd.classList.add("hidden"); menuOpen = null; document.querySelectorAll(".menu-top").forEach((b) => b.classList.remove("open")); it.run(); };
    dd.appendChild(d);
  }
  const r = anchor.getBoundingClientRect();
  dd.style.left = r.left + "px";
  dd.style.top = (r.bottom + 4) + "px";
  dd.classList.remove("hidden");
}
function closeMenu() { $("menudropdown").classList.add("hidden"); menuOpen = null; document.querySelectorAll(".menu-top").forEach((b) => b.classList.remove("open")); }

// ---------------- settings / themes / shortcuts / about ----------------
function openSettings() {
  showModal(`<div class="modal-head">Settings</div>
    <div class="modal-body">
      <div class="set-row"><label>Color theme</label><select id="s-theme">
        <option value="dark-modern">Dark Modern</option>
        <option value="light-modern">Light Modern</option>
        <option value="tokyo">Tokyo Night</option>
      </select></div>
      <div class="set-row"><label>Editor font size</label><input type="number" id="s-font" min="9" max="28" value="${settings.fontSize}" /></div>
      <div class="set-row"><label>Tab size</label><select id="s-tab">
        <option>2</option><option>4</option><option>8</option>
      </select></div>
      <div class="set-row"><label>Word wrap</label><input type="checkbox" id="s-wrap" ${settings.wordWrap ? "checked" : ""} /></div>
      <div class="set-row"><label>Line ending for new saves</label><select id="s-eol"><option>LF</option><option>CRLF</option></select></div>
    </div>
    <div class="modal-foot"><button class="btn-secondary" id="m-cancel">Close</button><button class="btn-primary" id="m-ok">Save</button></div>`);
  $("s-theme").value = settings.theme;
  $("s-tab").value = String(settings.tabSize);
  $("s-eol").value = localStorage.getItem("liteedit.eol") || "LF";
  $("m-cancel").onclick = closeModal;
  $("m-ok").onclick = () => {
    settings.theme = $("s-theme").value;
    settings.fontSize = Math.max(9, Math.min(28, Number($("s-font").value) || 14));
    settings.tabSize = Number($("s-tab").value) || 2;
    settings.wordWrap = $("s-wrap").checked;
    localStorage.setItem("liteedit.eol", $("s-eol").value);
    saveSettings(); applyTheme(); applySettingsToEditors(); updateLangStatus(); closeModal();
    notify("Settings saved", "ok", 2000);
  };
}
function openThemes() {
  const themes = [
    { id: "dark-modern", name: "Dark Modern", bg: "#1f1f1f", fg: "#cccccc" },
    { id: "light-modern", name: "Light Modern", bg: "#ffffff", fg: "#1f1f1f" },
    { id: "tokyo", name: "Tokyo Night", bg: "#1a1b26", fg: "#7aa2f7" },
  ];
  showModal(`<div class="modal-head">Color Theme</div><div class="modal-body" id="theme-list"></div>
    <div class="modal-foot"><button class="btn-secondary" id="m-cancel">Close</button></div>`);
  const box = $("theme-list");
  for (const th of themes) {
    const d = document.createElement("div");
    d.className = "theme-item" + (settings.theme === th.id ? " sel" : "");
    d.innerHTML = `<span class="theme-swatch" style="background:${th.bg};border-top:4px solid ${th.fg}"></span><span>${th.name}</span>`;
    d.onclick = () => { settings.theme = th.id; saveSettings(); applyTheme(); applySettingsToEditors(); closeModal(); notify("Theme: " + th.name, "ok", 2000); };
    box.appendChild(d);
  }
  $("m-cancel").onclick = closeModal;
}
function openShortcuts() {
  const rows = [
    ["Ctrl+P", "Quick Open (go to file)"], ["Ctrl+Shift+P / F1", "Command palette"],
    ["Ctrl+N", "New untitled file"], ["Ctrl+O", "Focus open-folder box"], ["Ctrl+S", "Save"], ["Ctrl+W", "Close editor"],
    ["Ctrl+B", "Toggle sidebar"], ["Ctrl+J", "Toggle panel"], ["Ctrl+`", "New terminal"], ["Ctrl+Shift+`", "New terminal"],
    ["Ctrl+Shift+E/F/G/D/X", "Explorer / Search / Git / Run / Extensions"],
    ["Ctrl+G", "Go to line"], ["Ctrl+Shift+O", "Go to symbol"], ["Ctrl+K T", "Color theme"], ["Ctrl+K S", "Shortcuts"], ["Ctrl+,", "Settings"],
    ["Ctrl+= / Ctrl+-", "Editor zoom"], ["Ctrl+F", "Find in file (editor)"],
  ];
  showModal(`<div class="modal-head">Keyboard Shortcuts</div>
    <div class="modal-body"><table class="kbd-table">${rows.map((r) => `<tr><td><kbd>${r[0]}</kbd></td><td>${r[1]}</td></tr>`).join("")}</table></div>
    <div class="modal-foot"><button class="btn-secondary" id="m-cancel">Close</button></div>`);
  $("m-cancel").onclick = closeModal;
}
function openAbout() {
  showModal(`<div class="modal-head">About LiteEdit</div>
    <div class="modal-body"><div><b>LiteEdit</b> v0.2 — lightweight VS Code alternative (Tauri + Rust + CodeMirror).</div>
    <div class="dim">Idle target &lt; 150 MB · WebView2 · PTY asli · Git via CLI.</div></div>
    <div class="modal-foot"><button class="btn-primary" id="m-cancel">OK</button></div>`);
  $("m-cancel").onclick = closeModal;
}
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
}
function renderWelcomeRecent() {
  const box = $("welcome-recent");
  if (!box) return;
  box.innerHTML = "";
  if (!recentFolders.length && !recentFiles.length) { box.innerHTML = "<span class='dim'>No recent folders</span>"; return; }
  for (const f of recentFolders.slice(0, 5)) {
    const b = document.createElement("button");
    b.className = "linklike"; b.textContent = f; b.title = f;
    b.onclick = () => openFolder(f);
    box.appendChild(b);
  }
}

// ---------------- extensions view (bawaan, ala marketplace) ----------------
const EXTS = [
  { id: "js", name: "JavaScript & TypeScript", ds: "Syntax, snippets & IntelliSense (basic)", meta: "Built-in", c: "#e5c07b" },
  { id: "py", name: "Python", ds: "Syntax highlighting for .py files", meta: "Built-in", c: "#4ec9b0" },
  { id: "rs", name: "Rust", ds: "Syntax highlighting for .rs files", meta: "Built-in", c: "#ce9178" },
  { id: "html", name: "HTML + CSS", ds: "Emmet-less editing for the web", meta: "Built-in", c: "#ce9178" },
  { id: "md", name: "Markdown", ds: "Preview-less lightweight editing", meta: "Built-in", c: "#4daafc" },
  { id: "git", name: "Git", ds: "Status, commit & branch from the side bar", meta: "Built-in", c: "#f14c4c" },
  { id: "term", name: "Integrated Terminal", ds: "Real PTY — cmd.exe / $SHELL", meta: "Built-in", c: "#868686" },
];
function renderExts(filter = "") {
  const box = $("ext-list");
  box.innerHTML = "";
  for (const e of EXTS.filter((x) => !filter || (x.name + x.ds).toLowerCase().includes(filter.toLowerCase()))) {
    const d = document.createElement("div");
    d.className = "ext-item";
    d.innerHTML = `<div class="ext-icon" style="background:${e.c}22;color:${e.c}">${escapeHtml(e.name[0])}</div>
      <div><div class="nm">${escapeHtml(e.name)}</div><div class="ds">${escapeHtml(e.ds)}</div><div class="mt">${escapeHtml(e.meta)}</div></div>`;
    d.onclick = () => notify(e.name + " is built-in and always enabled.", "ok", 2500);
    box.appendChild(d);
  }
}

// ---------------- wiring ----------------
function wire() {
  applyTheme();
  // menubar
  document.querySelectorAll(".menu-top").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); toggleMenu(b.dataset.menu, b); };
    b.onmouseenter = () => { if (menuOpen && menuOpen !== b.dataset.menu) toggleMenu(b.dataset.menu, b); };
  });
  document.addEventListener("click", (e) => {
    if (menuOpen && !e.target.closest("#menudropdown") && !e.target.closest(".menu-top")) closeMenu();
  });
  $("command-center").onclick = () => openPalette("");
  $("layout-sidebar").onclick = () => toggleSidebar();
  $("layout-panel").onclick = () => togglePanel();
  $("layout-maximize").onclick = () => { $("panel").classList.remove("collapsed"); $("panel").classList.toggle("maximized"); };
  $("titlebar-settings").onclick = () => openSettings();

  // activity bar
  document.querySelectorAll("#activitybar [data-view]").forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
  $("act-accounts").onclick = () => notify("Accounts are not configured in LiteEdit.", "warn");
  $("act-manage").onclick = (e) => {
    showCtxMenu(e.clientX - 200, e.clientY - 140, [
      { label: "Settings", shortcut: "Ctrl+,", run: () => openSettings() },
      { label: "Color Theme", shortcut: "Ctrl+K T", run: () => openThemes() },
      { label: "Keyboard Shortcuts", shortcut: "Ctrl+K S", run: () => openShortcuts() },
      { sep: true },
      { label: "About LiteEdit", run: () => openAbout() },
    ]);
  };

  // explorer
  $("open-folder").onclick = () => openFolder($("folder-input").value);
  $("folder-input").addEventListener("keydown", (e) => { if (e.key === "Enter") openFolder(e.target.value); });
  $("welcome-open-folder").onclick = () => { $("folder-input").focus(); };
  $("welcome-open-recent").onclick = () => openPalette("#");
  $("welcome-add-folder").onclick = () => notify("Multi-root workspace belum didukung — folder diganti.", "warn");
  $("btn-new-file").onclick = () => newFileHere(currentFolder);
  $("btn-new-folder").onclick = () => newFolderHere(currentFolder);
  $("btn-refresh-tree").onclick = () => renderTree();
  $("btn-collapse-all").onclick = () => { expanded.clear(); renderTree(); };
  document.querySelectorAll(".section-header").forEach((h) => {
    h.onclick = (e) => {
      if (e.target.closest("button")) return;
      const body = h.nextElementSibling;
      const tw = h.querySelector(".twisty");
      const collapsed = h.classList.toggle("collapsed");
      if (body) body.classList.toggle("hidden", collapsed);
      if (tw) tw.textContent = collapsed ? "▸" : "▾";
    };
  });
  $("tree").addEventListener("contextmenu", (e) => {
    if (e.target.closest(".trow")) return;
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
      { label: "New File…", run: () => newFileHere(currentFolder) },
      { label: "New Folder…", run: () => newFolderHere(currentFolder) },
      { sep: true },
      { label: "Refresh", run: () => renderTree() },
      { label: "Collapse All", run: () => { expanded.clear(); renderTree(); } },
    ]);
  });

  // search
  $("search-input").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 350); });
  $("search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
  $("search-toggle-replace").onclick = () => $("replace-row").classList.toggle("hidden");
  $("replace-one").onclick = () => replaceAll();
  $("replace-all").onclick = () => replaceAll();
  const tog = (id, key) => $(id).onclick = () => { searchOpts[key] = !searchOpts[key]; $(id).classList.toggle("on", searchOpts[key]); runSearch(); };
  tog("search-case", "case"); tog("search-word", "word"); tog("search-regex", "regex");
  $("search-include").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 500); });
  $("search-exclude").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 500); });
  $("search-refresh").onclick = () => runSearch();
  $("search-clear").onclick = () => { $("search-input").value = ""; $("replace-input").value = ""; $("search-results").innerHTML = ""; $("search-count").textContent = ""; };
  $("search-collapse").onclick = () => document.querySelectorAll("#search-results > div > div:last-child").forEach((x) => (x.style.display = "none"));

  // git
  $("git-refresh").onclick = refreshGit;
  $("git-msg").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("git-commit").click();
  });
  $("git-commit").onclick = async () => {
    const msg = $("git-msg").value.trim();
    if (!msg) { notify("Isi pesan commit dulu.", "warn"); return; }
    if (!currentFolder) { notify("Buka folder dulu.", "warn"); return; }
    try {
      const out = await invoke("git_commit", { repo: currentFolder, message: msg });
      $("git-out").textContent = out;
      log("Git", "commit: " + msg);
      $("git-msg").value = "";
      refreshGit(); refreshBranch();
      notify("Committed.", "ok", 2500);
    } catch (err) { $("git-out").textContent = "Gagal: " + err; notify("Commit gagal: " + err, "error"); }
  };

  // run & extensions
  $("btn-run-file").onclick = () => runActiveFile();
  $("btn-debug-file").onclick = () => runActiveFile(true);
  $("ext-search").addEventListener("input", (e) => renderExts(e.target.value));
  renderExts();

  // welcome
  document.querySelectorAll("#welcome [data-cmd]").forEach((b) => {
    b.onclick = () => {
      const c = b.dataset.cmd;
      if (c === "new-file") newUntitled();
      else if (c === "open-folder") { switchView("explorer"); $("folder-input").focus(); }
      else if (c === "open-recent") openPalette("#");
      else if (c === "new-term") newTerminal();
      else if (c === "palette") openPalette(">");
      else if (c === "shortcuts") openShortcuts();
      else if (c === "themes") openThemes();
      else if (c === "about") openAbout();
    };
  });
  renderWelcomeRecent();

  // editor actions
  $("ed-split").onclick = () => notify("Split editor belum didukung di v0.2.", "warn");
  $("ed-more").onclick = (e) => {
    const t = tabs[activeTab];
    showCtxMenu(e.clientX - 180, e.clientY + 10, [
      { label: "Save", shortcut: "Ctrl+S", run: () => t && saveFile(t) },
      { label: "Save As…", run: () => t && saveFile(t, true) },
      { sep: true },
      { label: "Copy Path", run: () => t && navigator.clipboard?.writeText(t.path) },
      { label: "Reveal in Explorer", run: () => switchView("explorer") },
      { sep: true },
      { label: "Change Language Mode…", run: () => changeLanguage() },
    ]);
  };

  // panel
  document.querySelectorAll(".ptab").forEach((b) => (b.onclick = () => switchPanel(b.dataset.panel)));
  $("btn-new-term").onclick = () => newTerminal();
  $("btn-split-term").onclick = () => newTerminal({ split: true });
  $("btn-kill-term").onclick = () => killTerminal();
  $("btn-max-panel").onclick = () => $("panel").classList.toggle("maximized");
  $("btn-hide-panel").onclick = () => togglePanel();
  $("output-clear").onclick = () => ($("output-log").textContent = "");

  // status bar
  $("status-branch").onclick = () => switchView("git");
  $("status-sync").onclick = () => notify("Sync/publish belum didukung — pakai terminal git.", "warn");
  $("status-errors").onclick = () => switchPanel("problems");
  $("status-pos").onclick = () => openPalette(":");
  $("status-indent").onclick = (e) => {
    showCtxMenu(e.clientX - 120, innerHeight - 160, [2, 4, 8].map((n) => ({
      label: `Spaces: ${n}${settings.tabSize === n ? " ✓" : ""}`, run: () => { settings.tabSize = n; saveSettings(); applySettingsToEditors(); updateLangStatus(); },
    })));
  };
  $("status-encoding").onclick = () => notify("Encoding: UTF-8 (satu-satunya yg didukung).", "ok", 2500);
  $("status-eol").onclick = () => {
    const cur = localStorage.getItem("liteedit.eol") || "LF";
    localStorage.setItem("liteedit.eol", cur === "LF" ? "CRLF" : "LF");
    updateLangStatus();
  };
  $("status-lang").onclick = () => changeLanguage();
  $("status-bell").onclick = () => notify("No new notifications.", "ok", 2000);

  // palette
  const pinput = $("palette-input");
  pinput.addEventListener("input", () => filterPalette(pinput.value));
  pinput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1); renderPaletteItems(pinput.value.slice(1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPaletteItems(pinput.value.slice(1)); }
    else if (e.key === "Enter") { const it = paletteItems[paletteSel]; if (it) { closePalette(); it.run(); } }
    else if (e.key === "Escape") closePalette();
  });
  $("palette-overlay").onclick = () => closePalette();
  $("modal-overlay").addEventListener("click", (e) => { if (e.target.id === "modal-overlay") closeModal(); });

  document.addEventListener("click", (e) => {
    if (!$("ctxmenu").classList.contains("hidden") && !e.target.closest("#ctxmenu")) hideCtxMenu();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { hideCtxMenu(); closeMenu(); } });

  // resize sidebar & panel (drag ala VS Code)
  const sbResize = $("sidebar-resize"), pResize = $("panel-resize");
  sbResize.onmousedown = (e) => {
    e.preventDefault();
    const move = (ev) => { $("sidebar").style.width = Math.max(170, Math.min(550, ev.clientX - 48)) + "px"; };
    const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
    addEventListener("mousemove", move); addEventListener("mouseup", up);
  };
  pResize.onmousedown = (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = $("panel").offsetHeight;
    const visTerms = () => { const a = activeTermObj(); return a ? terms.filter((x) => x.group === a.group) : []; };
    const move = (ev) => {
      $("panel").classList.remove("collapsed");
      $("panel").style.height = Math.max(32, Math.min(innerHeight * 0.8, startH + (startY - ev.clientY))) + "px";
      visTerms().forEach((t) => { try { t.fit.fit(); } catch { /* abaikan */ } });
    };
    const up = () => { visTerms().forEach((t) => syncTermSize(t)); removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
    addEventListener("mousemove", move); addEventListener("mouseup", up);
  };

  // shortcut global
  window.addEventListener("keydown", (e) => {
    const inPalette = !$("palette").classList.contains("hidden");
    const inModal = !$("modal-overlay").classList.contains("hidden");
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "");
    if (e.key === "Escape") {
      if (inPalette) { closePalette(); return; }
      if (inModal) { closeModal(); return; }
    }
    // chord Ctrl+K ...
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { chordK = true; e.preventDefault(); setTimeout(() => (chordK = false), 1200); return; }
    if (chordK) {
      chordK = false;
      if (e.key.toLowerCase() === "t") { e.preventDefault(); openThemes(); return; }
      if (e.key.toLowerCase() === "s") { e.preventDefault(); openShortcuts(); return; }
    }
    if (!e.ctrlKey && !e.metaKey) {
      if (e.key === "F1" && !inPalette) { e.preventDefault(); openPalette(">"); }
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "p" && e.shiftKey) { e.preventDefault(); inPalette ? closePalette() : openPalette(">"); }
    else if (k === "p") { e.preventDefault(); inPalette ? closePalette() : openPalette(""); }
    else if (k === "f" && e.shiftKey) { e.preventDefault(); switchView("search"); }
    else if (k === "e" && e.shiftKey) { e.preventDefault(); switchView("explorer"); }
    else if (k === "g" && e.shiftKey) { e.preventDefault(); switchView("git"); }
    else if (k === "d" && e.shiftKey) { e.preventDefault(); switchView("run"); }
    else if (k === "x" && e.shiftKey) { e.preventDefault(); switchView("extensions"); }
    else if (k === "o" && e.shiftKey) { e.preventDefault(); openPalette("@"); }
    else if (k === "b" && !e.shiftKey) { if (!typing || document.activeElement === document.body) { e.preventDefault(); toggleSidebar(); } else if (document.activeElement !== $("search-input") && !document.activeElement?.closest?.(".cm-content")) { e.preventDefault(); toggleSidebar(); } }
    else if (k === "j" && !e.shiftKey) { e.preventDefault(); togglePanel(); }
    else if (k === "`" && !e.shiftKey) { e.preventDefault(); newTerminal(); }
    else if (k === "`" && e.shiftKey) { e.preventDefault(); newTerminal(); }
    else if (k === "n" && !e.shiftKey) { e.preventDefault(); newUntitled(); }
    else if (k === "o" && !e.shiftKey) { e.preventDefault(); switchView("explorer"); $("folder-input").focus(); $("folder-input").select(); }
    else if (k === "w" && !e.shiftKey) { if (activeTab >= 0 && !typing) { e.preventDefault(); closeTab(activeTab); } else if (activeTab >= 0 && document.activeElement?.closest?.(".cm-content")) { e.preventDefault(); closeTab(activeTab); } }
    else if (k === "s" && !e.shiftKey && !typing) { e.preventDefault(); tabs[activeTab] && saveFile(tabs[activeTab]); }
    else if (k === "g" && !e.shiftKey && !typing) { e.preventDefault(); openPalette(":"); }
    else if (k === "," && !e.shiftKey) { e.preventDefault(); openSettings(); }
    else if ((k === "=" || k === "+") && !e.shiftKey) { e.preventDefault(); settings.fontSize = Math.min(28, settings.fontSize + 1); saveSettings(); applySettingsToEditors(); }
    else if (k === "-" && !e.shiftKey) { e.preventDefault(); settings.fontSize = Math.max(9, settings.fontSize - 1); saveSettings(); applySettingsToEditors(); }
  });
  window.addEventListener("resize", () => { const a = activeTermObj(); if (a) terms.filter((x) => x.group === a.group).forEach((x) => syncTermSize(x)); });
}
function changeLanguage() {
  const t = tabs[activeTab];
  if (!t) return;
  const ids = ["txt", "js", "ts", "py", "rs", "html", "css", "json", "md"];
  showModal(`<div class="modal-head">Select Language Mode</div><div class="modal-body" id="lang-list"></div>
    <div class="modal-foot"><button class="btn-secondary" id="m-cancel">Close</button></div>`);
  const box = $("lang-list");
  for (const id of ids) {
    const d = document.createElement("div");
    d.className = "theme-item" + ((t.langOverride || t.path.split(".").pop()) === id ? " sel" : "");
    d.textContent = langLabel("x." + id, id);
    d.onclick = () => {
      t.langOverride = id;
      // rebuild view dgn bahasa baru
      const content = t.view.state.doc.toString();
      t.view.destroy();
      t.view = new EditorView({ state: EditorState.create({ doc: content, extensions: editorExtensions(t) }), parent: $("editor") });
      t.view.dom.style.display = "block";
      t.view.dom.addEventListener("contextmenu", (e) => ctxForEditor(e, t));
      tabs.forEach((x, j) => { if (x !== t) x.view.dom.style.display = j === activeTab ? "block" : "none"; });
      updateLangStatus(); renderTabs(); closeModal();
    };
    box.appendChild(d);
  }
  $("m-cancel").onclick = closeModal;
}

// ---------------- boot ----------------
(async function boot() {
  try {
    await invoke("get_cwd");
  } catch {
    document.body.innerHTML =
      "<p style='padding:2rem;font-family:sans-serif'>LiteEdit harus dijalankan lewat aplikasi Tauri, bukan browser biasa.</p>";
    return;
  }
  wire();
  updateLangStatus();
  $("folder-input").value = currentFolder;
  if (currentFolder) {
    try { await invoke("list_dir", { path: currentFolder }); }
    catch { currentFolder = ""; }
  }
  if (!currentFolder) {
    try { currentFolder = await invoke("get_cwd"); } catch { currentFolder = ""; }
    if (currentFolder) $("folder-input").value = currentFolder;
  }
  // event output PTY — kalau listen gagal (mis. izin core:event), terminal
  // akan blank total; gagalkan dgn pesan LOUD, jangan abort boot diam-diam
  try {
    await listen("pty-data", (e) => {
      if (!window.__ptyFirst) { window.__ptyFirst = true; log("Terminal", "pty-data mengalir (event OK)"); }
      const t = terms.find((x) => x.id === e.payload.id);
      if (t) t.term.write(base64ToBytes(e.payload.data));
    });
  } catch (err) {
    notify("Terminal tidak bisa menerima output (event diblokir): " + err, "error", 9000);
    log("LiteEdit", "listen pty-data GAGAL: " + err);
  }
  log("LiteEdit", "boot ok — theme=" + settings.theme);
  await renderTree();
  refreshTreeSelection();
  refreshBranch();
  refreshGit();
  updateWelcome();
  renderOpenEditors();
  updateProblemsStatus();
  // jaga ukuran semua terminal yg tampil saat panel/window di-resize (semua OS)
  let termResizeT = 0;
  new ResizeObserver(() => {
    clearTimeout(termResizeT);
    termResizeT = setTimeout(() => {
      if ($("panel").classList.contains("collapsed") || panelView !== "terminal") return;
      const t = activeTermObj();
      if (t) terms.filter((x) => x.group === t.group).forEach((x) => syncTermSize(x));
    }, 120);
  }).observe($("terminals"));
  await newTerminal();
})();
