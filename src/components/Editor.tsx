"use client";

import { useEffect, useRef } from "react";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  keymap,
  Decoration,
  type DecorationSet,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  LanguageDescription,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
} from "@codemirror/search";
import { useI18n } from "@/lib/i18n";
import { useUI } from "@/lib/store";
import { WORKSPACE_FILES, DEMO_EDIT } from "@/lib/files";
import { useWorkspace } from "@/lib/workspace";
import { editorBus } from "@/lib/editor-bus";
import { piTheme, piHighlight } from "@/lib/editor-theme";
import { termBus, ansi } from "@/lib/terminal-bus";

/* ── streaming-diff line decoration ── */
const markStreamLine = StateEffect.define<number>({
  map: (pos, mapping) => mapping.mapPos(pos),
});
/** swap all stream marks to the fading class (background → transparent) */
const fadeStreamMarks = StateEffect.define<null>();
const clearStreamMarks = StateEffect.define<null>();

const streamField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(markStreamLine)) {
        const line = tr.state.doc.lineAt(e.value);
        marks = marks.update({
          filter: (from) => tr.state.doc.lineAt(from).number !== line.number,
          add: [
            Decoration.line({ class: "pi-stream-add" }).range(line.from),
          ],
        });
      }
      if (e.is(fadeStreamMarks)) {
        const fading: { from: number }[] = [];
        marks.between(0, tr.state.doc.length, (from) => {
          fading.push({ from });
        });
        marks = Decoration.set(
          fading.map(({ from }) =>
            Decoration.line({ class: "pi-stream-fade" }).range(from)
          )
        );
      }
      if (e.is(clearStreamMarks)) marks = Decoration.none;
    }
    return marks;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** per-view slot for the lazily-loaded language support of the active file */
const langCompartment = new Compartment();

/* CodeMirror's search panel localizes through its own phrase system —
   keys are CM's built-in English strings, so they can't route through t(). */
const SEARCH_PHRASES_ZH: Record<string, string> = {
  "Find": "查找",
  "Replace": "替换",
  "next": "下一个",
  "previous": "上一个",
  "all": "全部",
  "match case": "区分大小写",
  "by word": "全字匹配",
  "regexp": "正则",
  "replace": "替换",
  "replace all": "全部替换",
  "close": "关闭",
  "Go to line": "跳转到行",
  "go": "跳转",
  "current match": "当前匹配",
  "replaced $ matches": "已替换 $ 处匹配",
  "replaced match on line $": "已替换第 $ 行的匹配",
  "on line": "所在行",
};

/**
 * Resolve `file`'s language from the official registry and slot it into the
 * compartment. Parsers are code-split — only the matched one is fetched.
 * `isCurrent` guards against a slow load landing after the user switched files.
 */
async function loadLanguageFor(
  view: EditorView,
  file: string,
  isCurrent: () => boolean
) {
  const desc = LanguageDescription.matchFilename(languages, file);
  if (!desc) return;
  const support = await desc.load();
  if (isCurrent()) {
    view.dispatch({ effects: langCompartment.reconfigure(support) });
  }
}

function extensionsFor(file: string) {
  const base = [
    lineNumbers(),
    foldGutter(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      {
        key: "Mod-s",
        run: (v) => {
          void useWorkspace.getState().saveFile(file, v.state.doc.toString());
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    piTheme,
    piHighlight,
    streamField,
    langCompartment.of([]),
  ];
  if (useI18n.getState().locale === "zh") {
    base.push(EditorState.phrases.of(SEARCH_PHRASES_ZH));
  }
  return base;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** CodeMirror 6 surface — the base-layer canvas of the app. */
export function Editor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fileRef = useRef<string>(useUI.getState().activeFile);
  const cancelRef = useRef(false);

  const activeFile = useUI((s) => s.activeFile);
  const demoTick = useUI((s) => s.demoTick);
  /* re-render when the active file's doc first loads from disk */
  const activeDoc = useWorkspace((s) => s.docs[activeFile]);

  const docFor = (file: string) =>
    useWorkspace.getState().docs[file] ?? WORKSPACE_FILES[file] ?? "";

  /* mount once */
  useEffect(() => {
    const file = fileRef.current;
    const view = new EditorView({
      state: EditorState.create({
        doc: docFor(file),
        extensions: extensionsFor(file),
      }),
      parent: hostRef.current!,
    });
    viewRef.current = view;
    void loadLanguageFor(view, file, () => fileRef.current === file);

    /* real agent edits — highlight the changed lines of the active file */
    const timers: number[] = [];
    const unsub = editorBus.subscribe(({ path, lines }) => {
      const v = viewRef.current;
      if (!v || path !== fileRef.current || lines.length === 0) return;
      const doc = v.state.doc;
      const effects = lines
        .filter((n) => n >= 1 && n <= doc.lines)
        .map((n) => markStreamLine.of(doc.line(n).from));
      if (effects.length === 0) return;
      const first = Math.min(...lines.filter((n) => n >= 1 && n <= doc.lines));
      v.dispatch({
        effects: [
          ...effects,
          EditorView.scrollIntoView(doc.line(first).from, { y: "center" }),
        ],
      });
      // same breathe → fade → clear rhythm as the demo
      timers.forEach((t) => clearTimeout(t));
      timers.length = 0;
      timers.push(
        window.setTimeout(
          () => viewRef.current?.dispatch({ effects: fadeStreamMarks.of(null) }),
          1600
        ),
        window.setTimeout(
          () => viewRef.current?.dispatch({ effects: clearStreamMarks.of(null) }),
          2250
        )
      );
    });

    return () => {
      cancelRef.current = true;
      unsub();
      timers.forEach((t) => clearTimeout(t));
      // switching to a non-text file unmounts the editor — keep unsaved edits
      const cur = fileRef.current;
      if (useWorkspace.getState().docs[cur] !== undefined) {
        useWorkspace.getState().updateDoc(cur, view.state.doc.toString());
      }
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* swap document when the active file (or its freshly-loaded content) changes */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const fileChanged = fileRef.current !== activeFile;
    if (fileChanged) {
      // keep unsaved edits of the previous file in memory
      useWorkspace
        .getState()
        .updateDoc(fileRef.current, view.state.doc.toString());
      fileRef.current = activeFile;
    } else if (view.state.doc.toString() === (activeDoc ?? "")) {
      return; // same file, content already in sync
    } else if (activeDoc === undefined) {
      return; // content not loaded yet — keep whatever is shown
    }
    view.setState(
      EditorState.create({
        doc: docFor(activeFile),
        extensions: extensionsFor(activeFile),
      })
    );
    void loadLanguageFor(view, activeFile, () => fileRef.current === activeFile);
  }, [activeFile, activeDoc]);

  /* agent streaming-edit demo: read → reason → edit → review → test */
  useEffect(() => {
    if (demoTick === 0) return;
    const { finishDemo, requestReview, setTerminalOpen } = useUI.getState();
    cancelRef.current = false;

    (async () => {
      const view = viewRef.current;
      if (!view) return;

      // 1. read
      await sleep(700);
      if (cancelRef.current) return;

      // 2. reason
      await sleep(1000);
      if (cancelRef.current) return;

      // 3. edit — stream the replacement in, character by character
      const doc = view.state.doc.toString();
      const idx = doc.indexOf(DEMO_EDIT.find);
      let edited = false;
      if (idx >= 0) {
        // wipe the old line
        view.dispatch({
          changes: { from: idx, to: idx + DEMO_EDIT.find.length, insert: "" },
        });
        // type the new one
        let pos = idx;
        for (const ch of DEMO_EDIT.replace) {
          if (cancelRef.current) return;
          view.dispatch({
            changes: { from: pos, insert: ch },
            effects: markStreamLine.of(pos),
            scrollIntoView: true,
          });
          pos += ch.length;
          await sleep(14 + Math.random() * 22);
        }
        edited = true;
      }
      await sleep(300);
      if (cancelRef.current) return;

      // 3.5 review — spring up the sheet, await the user's verdict
      let accepted = true;
      if (edited) {
        accepted = await requestReview({
          file: DEMO_EDIT.file,
          oldLine: DEMO_EDIT.find,
          newLine: DEMO_EDIT.replace,
        });
        if (cancelRef.current) return;
      }

      if (!accepted) {
        // revert: swap the new line back to the old one
        const cur = viewRef.current;
        if (cur) {
          const d = cur.state.doc.toString();
          const at = d.indexOf(DEMO_EDIT.replace);
          if (at >= 0) {
            cur.dispatch({
              changes: {
                from: at,
                to: at + DEMO_EDIT.replace.length,
                insert: DEMO_EDIT.find,
              },
              effects: clearStreamMarks.of(null),
            });
          }
        }
        termBus.writeln(
          ansi.red("✕ edit rejected") + ansi.dim(" — change reverted")
        );
        finishDemo();
        return;
      }

      // 4. test — slide the terminal up and stream mock output
      setTerminalOpen(true);
      await sleep(500);
      termBus.writeln(ansi.dim("$ ") + ansi.bold("pnpm test"));
      await sleep(600);
      if (cancelRef.current) return;
      termBus.writeln(
        " " + ansi.green("✓") + " agent.spec.ts " + ansi.dim("(3 tests) 241ms")
      );
      await sleep(300);
      termBus.writeln(
        " " +
          ansi.green("✓") +
          " context.spec.ts " +
          ansi.dim("(5 tests) 189ms")
      );
      await sleep(350);
      if (cancelRef.current) return;
      termBus.writeln();
      termBus.writeln(
        " " + ansi.bold("Tests") + "  " + ansi.green("8 passed") + " (8)"
      );

      // let the highlight breathe, then fade it out softly before clearing
      await sleep(1600);
      viewRef.current?.dispatch({ effects: fadeStreamMarks.of(null) });
      await sleep(650); // matches the 0.6s background-color transition
      viewRef.current?.dispatch({ effects: clearStreamMarks.of(null) });
      finishDemo();
    })();
  }, [demoTick]);

  return (
    <div
      ref={hostRef}
      style={{ height: "100%", width: "100%", overflow: "hidden" }}
    />
  );
}
