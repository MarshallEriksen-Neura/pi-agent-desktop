/**
 * Tiny pub/sub bridging agent output to the terminal drawer.
 * Keeps a small backlog so lines written before the terminal mounts replay.
 * When the real pi backend lands, its PTY/exec stream writes here too.
 */
type Listener = (data: string) => void;

const listeners = new Set<Listener>();
const backlog: string[] = [];
const BACKLOG_MAX = 200;

export const termBus = {
  write(data: string) {
    backlog.push(data);
    if (backlog.length > BACKLOG_MAX) backlog.shift();
    listeners.forEach((l) => l(data));
  },
  writeln(data = "") {
    this.write(data + "\r\n");
  },
  /**
   * Drop the backlog, then write `data`.
   *
   * Used by `clear`: replaying erased scrollback into a terminal that mounts
   * later would undo the clear, since a late subscriber is handed the whole
   * backlog. The escape sequence goes out after the drop so the live terminal
   * still erases what it has already painted.
   */
  reset(data = "") {
    backlog.length = 0;
    if (data) this.write(data);
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    // replay history for late mounts
    backlog.forEach((d) => l(d));
    return () => {
      listeners.delete(l);
    };
  },
};

/* ANSI helpers tuned to the iOS palette set in the xterm theme */
export const ansi = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
