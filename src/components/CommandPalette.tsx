"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteContent,
  AutocompleteList,
  AutocompleteItem,
  AutocompleteEmpty,
} from "@appica/ui-react/autocomplete";
import {
  ArrowLeft,
  Sparkles,
  Focus,
  MessagesSquare,
  Moon,
  SquareTerminal,
  SquarePen,
  Gem,
  RefreshCw,
  Languages,
  Folder,
  FolderOpen,
  Command as CommandIcon,
  Command,
} from "lucide-react";
import { useUI } from "@/lib/store";
import { usePi } from "@/lib/pi/store";
import { useChat } from "@/lib/pi/chat";
import { useSessions } from "@/lib/pi/sessions";
import { useWorkspace } from "@/lib/workspace";
import { useI18n, useT } from "@/lib/i18n";
import { Kbd } from "./primitives";

interface Command {
  id: string;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * ⌘K command palette — Appica Autocomplete inside our glass overlay.
 * Filtering + keyboard navigation come from Base UI; the sheet look,
 * spring entrance and glass material stay ours.
 */
export function CommandPalette() {
  const { commandPaletteOpen, setCommandPalette } = useUI();

  return (
    <AnimatePresence>
      {commandPaletteOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={() => setCommandPalette(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            paddingTop: "18vh",
            background: "rgba(0,0,0,0.28)",
            backdropFilter: "blur(4px)",
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="material-thin"
            style={{
              width: 560,
              maxWidth: "90vw",
              borderRadius: "var(--radius-lg)",
              border: "1px solid var(--separator)",
              boxShadow: "var(--shadow-lg)",
              overflow: "hidden",
            }}
          >
            <PaletteBody />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PaletteBody() {
  const { setCommandPalette, toggleZen, toggleWork, toggleTheme, toggleTerminal } = useUI();
  const cycleModel = usePi((s) => s.cycleModel);
  const piCommands = usePi((s) => s.commands);
  const refresh = usePi((s) => s.refresh);
  const toggleLocale = useI18n((s) => s.toggleLocale);
  const wsMock = useWorkspace((s) => s.mock);
  const wsRoot = useWorkspace((s) => s.root);
  const recents = useWorkspace((s) => s.recents);
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");

  const openAsk = () => {
    setQuestion("");
    setAsking(true);
  };

  const closeAsk = () => {
    setQuestion("");
    setAsking(false);
  };

  const sendQuestion = () => {
    const text = question.trim();
    if (!text) return;
    setQuestion("");
    setCommandPalette(false);
    void useChat.getState().send(text);
  };

  const commands = useMemo<Command[]>(() => {
    const close = () => setCommandPalette(false);
    const base: Command[] = [
      {
        id: "ask",
        icon: <Sparkles size={15} />,
        label: t("palette.ask"),
        hint: "agent",
        run: openAsk,
      },
      {
        id: "new-session",
        icon: <SquarePen size={15} />,
        label: t("palette.newSession"),
        hint: "chat",
        run: () => {
          close();
          useSessions.getState().newSession();
        },
      },
      {
        id: "zen",
        icon: <Focus size={15} />,
        label: t("palette.zen"),
        hint: "⌘.",
        run: () => {
          close();
          toggleZen();
        },
      },
      {
        id: "work",
        icon: <MessagesSquare size={15} />,
        label: t("palette.work"),
        hint: "⌘/",
        run: () => {
          close();
          toggleWork();
        },
      },
      {
        id: "theme",
        icon: <Moon size={15} />,
        label: t("palette.theme"),
        run: () => {
          close();
          toggleTheme();
        },
      },
      {
        id: "terminal",
        icon: <SquareTerminal size={15} />,
        label: t("palette.terminal"),
        hint: "⌘J",
        run: () => {
          close();
          toggleTerminal();
        },
      },
      {
        id: "model",
        icon: <Gem size={15} />,
        label: t("palette.cycleModel"),
        run: () => {
          close();
          cycleModel();
        },
      },
      {
        id: "language",
        icon: <Languages size={15} />,
        label: t("palette.language"),
        run: () => {
          close();
          toggleLocale();
        },
      },
      {
        id: "reindex",
        icon: <RefreshCw size={15} />,
        label: t("palette.refresh"),
        hint: "rpc",
        run: () => {
          close();
          refresh();
        },
      },
    ];
    // project selection — folder picker + recent projects (Tauri only)
    const fromProjects: Command[] = wsMock
      ? []
      : [
          {
            id: "project-open",
            icon: <FolderOpen size={15} />,
            label: t("project.open"),
            run: () => {
              close();
              void useWorkspace.getState().pickProject();
            },
          },
          ...recents
            .filter((r) => r.path !== wsRoot)
            .map((r) => ({
              id: `project-${r.path}`,
              icon: <Folder size={15} />,
              label: r.name,
              hint: r.path,
              run: () => {
                close();
                void useWorkspace.getState().openProject(r.path);
              },
            })),
        ];
    // pi slash-commands (built-ins + extensions) surface here too
    const fromPi: Command[] = piCommands.map((c) => ({
      id: `pi-${c.name}`,
      icon: <CommandIcon size={15} />,
      label: `/${c.name}`,
      hint: c.source?.replace("extension:", "") ?? "pi",
      run: () => {
        setCommandPalette(false);
        useChat.getState().send(`/${c.name}`);
      },
    }));
    return [...base, ...fromProjects, ...fromPi];
  }, [setCommandPalette, toggleZen, toggleWork, toggleTheme, toggleTerminal, cycleModel, refresh, piCommands, toggleLocale, wsMock, wsRoot, recents, t]);

  if (asking) {
    return (
      <div style={{ padding: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px 10px" }}>
          <button
            type="button"
            onClick={closeAsk}
            aria-label={t("palette.askBack")}
            title={t("palette.askBack")}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              border: "none",
              borderRadius: 8,
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            <ArrowLeft size={16} />
          </button>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            {t("palette.askTitle")}
          </span>
        </div>
        <textarea
          autoFocus
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeAsk();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendQuestion();
            }
          }}
          placeholder={t("palette.askPlaceholder")}
          rows={4}
          style={{
            display: "block",
            width: "100%",
            minHeight: 112,
            resize: "vertical",
            padding: "12px 14px",
            border: "1px solid var(--separator)",
            borderRadius: 10,
            outline: "none",
            background: "var(--bg-sunken)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-ui)",
            fontSize: 14,
            lineHeight: 1.5,
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 4px 2px" }}>
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{t("palette.askHint")}</span>
          <button
            type="button"
            onClick={sendQuestion}
            disabled={!question.trim()}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "7px 14px",
              background: question.trim() ? "var(--accent)" : "var(--separator)",
              color: "#FFFFFF",
              cursor: question.trim() ? "pointer" : "not-allowed",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {t("palette.askSend")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <Autocomplete
      items={commands}
      itemToStringValue={(c: unknown) => (c as Command).label}
      open
      onValueChange={(value: unknown) => {
        const cmd = commands.find((c) => c.label === value || c === value);
        cmd?.run();
      }}
    >
      <AutocompleteInput
        autoFocus
        placeholder={t("palette.placeholder")}
        className="border-0 bg-transparent shadow-none focus-visible:ring-0"
        style={{
          width: "100%",
          padding: "18px 20px",
          fontSize: 16,
          color: "var(--text-primary)",
          fontFamily: "var(--font-ui)",
          borderBottom: "1px solid var(--separator)",
          borderRadius: 0,
          height: "auto",
          background: "transparent",
        }}
      />
      {/* inline (non-floating) list — the palette itself is the popup */}
      <AutocompleteList
        style={{
          maxHeight: 320,
          overflowY: "auto",
          padding: 8,
        }}
      >
        {(c: Command) => (
          <AutocompleteItem
            key={c.id}
            value={c.label}
            className="pi-row"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "11px 14px",
              borderRadius: 10,
              cursor: "pointer",
              fontSize: 14,
              color: "var(--text-primary)",
            }}
          >
            <span
              style={{
                color: "var(--accent)",
                width: 18,
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              {c.icon}
            </span>
            <span style={{ flex: 1 }}>{c.label}</span>
            {c.hint && (
              <Kbd style={{ background: "transparent", border: "none" }}>
                {c.hint.startsWith("⌘") ? (
                  <>
                    <Command size={11} />
                    {c.hint.slice(1)}
                  </>
                ) : (
                  c.hint
                )}
              </Kbd>
            )}
          </AutocompleteItem>
        )}
      </AutocompleteList>
      <AutocompleteEmpty
        style={{
          padding: "18px 20px",
          fontSize: 13,
          color: "var(--text-tertiary)",
        }}
      >
        {t("palette.empty")}
      </AutocompleteEmpty>
    </Autocomplete>
  );
}
