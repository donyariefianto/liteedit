// SPDX-License-Identifier: MIT
// Tema editor LiteEdit — "Tokyo Night": kontras lembut, nyaman di mata.
// Dipakai sebagai pengganti oneDark bawaan CodeMirror.
import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/highlight";
import { syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const bg = "#1a1b26";
const bgGutter = "#1a1b26";
const fg = "#c0caf5";
const fgDim = "#a9b1d6";
const muted = "#565f89";
const accent = "#7aa2f7";
const selection = "rgba(122, 162, 247, 0.28)";
const activeLine = "rgba(41, 46, 66, 0.55)";
const cursor = "#c0caf5";

export const tokyoTheme = EditorView.theme(
  {
    "&": { backgroundColor: bg, color: fg, fontSize: "14px" },
    ".cm-content": { caretColor: cursor, fontFamily: "'JetBrains Mono', Consolas, monospace" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: cursor, borderLeftWidth: "2px" },
    ".cm-selectionBackground, ::selection": { backgroundColor: selection },
    ".cm-activeLine": { backgroundColor: activeLine },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: fg },
    ".cm-gutters": {
      backgroundColor: bgGutter,
      color: muted,
      border: "none",
      paddingRight: "8px",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
    // bracket yang cocok: garis bawah halus, bukan blok menyilaukan
    ".cm-matchingBracket": {
      backgroundColor: "rgba(122, 162, 247, 0.18)",
      outline: "1px solid rgba(122, 162, 247, 0.5)",
      borderRadius: "3px",
    },
    ".cm-nonmatchingBracket": {
      backgroundColor: "rgba(247, 118, 142, 0.18)",
      outline: "1px solid rgba(247, 118, 142, 0.5)",
      borderRadius: "3px",
    },
    // panel search CodeMirror
    ".cm-search": { backgroundColor: "#16161e", color: fg, border: "1px solid #292e42" },
    ".cm-search input": { backgroundColor: "#1f2335", color: fg, border: "1px solid #292e42" },
    ".cm-search button": { color: fgDim },
  },
  { dark: true }
);

export const tokyoHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#bb9af7" },
  { tag: [tags.controlKeyword, tags.moduleKeyword], color: "#bb9af7", fontStyle: "italic" },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: "#c0caf5" },
  { tag: [tags.variableName, tags.labelName], color: "#c0caf5" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#7aa2f7" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#7dcfff" },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape], color: "#89ddff" },
  { tag: [tags.tagName], color: "#f7768e" },
  { tag: [tags.attributeName], color: "#e0af68" },
  { tag: [tags.regexp, tags.string, tags.special(tags.string)], color: "#9ece6a" },
  { tag: [tags.number, tags.bool, tags.null], color: "#ff9e64" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "#565f89", fontStyle: "italic" },
  { tag: tags.quote, color: "#9ece6a" },
  { tag: [tags.meta, tags.documentMeta], color: "#737aa2" },
  { tag: tags.link, color: "#7aa2f7", textDecoration: "underline" },
  { tag: tags.heading, color: "#7aa2f7", fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic", color: "#bb9af7" },
  { tag: tags.strong, fontWeight: "bold", color: "#bb9af7" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.atom, tags.special(tags.variableName)], color: "#e0af68" },
  { tag: tags.invalid, color: "#f7768e", textDecoration: "underline wavy #f7768e" },
  { tag: tags.punctuation, color: "#89ddff" },
]);

export function tokyoNight() {
  return [tokyoTheme, syntaxHighlighting(tokyoHighlight)];
}
