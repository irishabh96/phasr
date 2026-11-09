import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

export function languageFor(path: string): { label: string; ext: Extension | null } {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return { label: "TypeScript", ext: javascript({ typescript: true, jsx: ext === "tsx" }) };
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return { label: "JavaScript", ext: javascript({ jsx: ext === "jsx" }) };
    case "json":
      return { label: "JSON", ext: json() };
    case "css":
      return { label: "CSS", ext: css() };
    case "html":
      return { label: "HTML", ext: html() };
    case "md":
    case "mdx":
      return { label: "Markdown", ext: markdown() };
    case "rs":
      return { label: "Rust", ext: rust() };
    case "py":
      return { label: "Python", ext: python() };
    default:
      return { label: "Plain text", ext: null };
  }
}

/** Syntax colours from the theme's ANSI palette, so light/dark both read. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "var(--ansi-magenta)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--ansi-green)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--ansi-yellow)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--ansi-blue)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--ansi-cyan)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--color-text-muted)", fontStyle: "italic" },
  { tag: [t.propertyName, t.attributeName], color: "var(--color-text-secondary)" },
  { tag: [t.heading], color: "var(--color-text-primary)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--color-accent-text)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--color-danger)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12.5px",
    backgroundColor: "var(--color-bg-base)",
    color: "var(--color-text-primary)",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--color-accent-500)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent-500)", borderLeftWidth: "2px" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "var(--color-bg-base)",
    color: "var(--color-text-faint)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--color-bg-elevated) 60%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-text-secondary)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--ansi-selection)",
  },
  ".cm-matchingBracket": { outline: "1px solid var(--color-border-strong)", backgroundColor: "transparent" },
  ".cm-searchMatch": { backgroundColor: "var(--color-warning-tint)" },
  ".cm-panels": { backgroundColor: "var(--color-bg-sidebar)", color: "var(--color-text-primary)" },
});

/**
 * CodeMirror 6 for the Files tab (A-Editor). Uncontrolled after mount: the
 * document starts as `value` (the stored buffer, so a remount restores
 * unsaved edits). A new `docKey` (path + reload revision) replaces the
 * document with `value`; anything else is the user's edit buffer.
 * Lazy-loaded so the editor ships only when the Files tab opens.
 */
export default function CodeEditor({
  docKey,
  value,
  path,
  readOnly = false,
  onChange,
  onSave,
  onCursor,
}: {
  docKey: string;
  value: string;
  path: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onCursor?: (pos: { line: number; col: number }) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const cb = useRef({ onChange, onSave, onCursor });
  cb.current = { onChange, onSave, onCursor };

  useEffect(() => {
    if (!host.current) return;
    const lang = languageFor(path).ext;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(highlight),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          langCompartment.current.of(lang ?? []),
          readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              cb.current.onCursor?.({ line: line.number, col: head - line.from + 1 });
            }
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The view is created once; docKey/readOnly/path changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new document (a reload after an agent edit, or "Reload theirs"). When
  // it is exactly what's in the editor already, leave the document alone so
  // cursor and undo history survive.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (v.state.doc.toString() === value) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: value },
      effects: langCompartment.current.reconfigure(languageFor(path).ext ?? []),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
