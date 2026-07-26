"use client";

import { useEffect, useRef } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  keymap,
  Decoration,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
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

function extensionsFor(file: string) {
  const base = [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    drawSelection(),
    history(),
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
    ]),
    piTheme,
    piHighlight,
    streamField,
  ];
  if (file.endsWith(".ts") || file.endsWith(".tsx")) {
    base.push(javascript({ typescript: true, jsx: file.endsWith(".tsx") }));
  } else if (file.endsWith(".js") || file.endsWith(".jsx") || file.endsWith(".mjs")) {
    base.push(javascript({ jsx: file.endsWith(".jsx") }));
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
  }, [activeFile, activeDoc]);

  /* agent streaming-edit demo: read → reason → edit → review → test */
  useEffect(() => {
    if (demoTick === 0) return;
    const { setTaskStatus, finishDemo, requestReview, setTerminalOpen } =
      useUI.getState();
    cancelRef.current = false;

    (async () => {
      const view = viewRef.current;
      if (!view) return;

      // 1. read
      setTaskStatus("read", "running");
      await sleep(700);
      if (cancelRef.current) return;
      setTaskStatus("read", "done");

      // 2. reason
      setTaskStatus("reason", "running");
      await sleep(1000);
      if (cancelRef.current) return;
      setTaskStatus("reason", "done");

      // 3. edit — stream the replacement in, character by character
      setTaskStatus("edit", "running");
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
      setTaskStatus("edit", "done");

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
      setTaskStatus("test", "running");
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
      setTaskStatus("test", "done");

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
