/**
 * pi-bgwatch: background processes that wake the agent.
 *
 * `bgwatch` runs a command in the background and, like Claude Code's Monitor
 * tool, injects its output into the session as it arrives, triggering a turn
 * so the agent can act on it. Lines are batched (debounced) so one burst of
 * output is one wake, an optional regex selects which lines wake the agent,
 * and the exit of the process always wakes it.
 *
 * Everything is kept per pi process under $TMPDIR/pi-bgwatch/<pid>/<id>/ so
 * several pi sessions on one host never share a directory.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const ROOT = join(tmpdir(), "pi-bgwatch", String(process.pid));
const MAX_LINES_PER_WAKE = 200;

interface Watch {
  id: string;
  title: string;
  command: string;
  dir: string;
  logFile: string;
  child: ChildProcess;
  log: WriteStream;
  pattern?: RegExp;
  debounceMs: number;
  pending: string[];
  dropped: number;
  timer?: NodeJS.Timeout;
  lines: number;
  done: boolean;
  exitCode?: number | null;
  startedAt: number;
}

export default function (pi: ExtensionAPI) {
  const watches = new Map<string, Watch>();
  let counter = 0;

  const wake = (w: Watch, kind: "output" | "exit") => {
    if (w.timer) {
      clearTimeout(w.timer);
      w.timer = undefined;
    }
    const lines = w.pending;
    const dropped = w.dropped;
    w.pending = [];
    w.dropped = 0;
    if (kind === "output" && lines.length === 0) return;

    let content = `bgwatch ${w.id} (${w.title})`;
    if (kind === "exit") {
      const status = w.child.killed ? "stopped" : w.exitCode === 0 ? "exited 0" : `exited ${w.exitCode ?? "?"}`;
      content += ` ${status}.`;
    } else {
      content += ` output:`;
    }
    if (lines.length > 0) {
      content += `\n${lines.join("\n")}`;
      if (dropped > 0) content += `\n... ${dropped} more line(s) in ${w.logFile}`;
    }
    content += `\nLog: ${w.logFile}`;

    pi.sendMessage(
      {
        customType: "bgwatch",
        content,
        display: true,
        details: { id: w.id, title: w.title, command: w.command, kind, exitCode: w.exitCode, logFile: w.logFile, lines },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const schedule = (w: Watch) => {
    if (w.timer) return;
    w.timer = setTimeout(() => wake(w, "output"), w.debounceMs);
  };

  const onLine = (w: Watch, line: string, stderr: boolean) => {
    w.lines++;
    w.log.write((stderr ? "[stderr] " : "") + line + "\n");
    if (w.pattern && !w.pattern.test(line)) return;
    if (w.pending.length >= MAX_LINES_PER_WAKE) {
      w.dropped++;
    } else {
      w.pending.push(line);
    }
    schedule(w);
  };

  const feed = (w: Watch, stream: NodeJS.ReadableStream, stderr: boolean) => {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const parts = buf.split("\n");
      buf = parts.pop()!;
      for (const line of parts) onLine(w, line.replace(/\r$/, ""), stderr);
    });
    stream.on("end", () => {
      if (buf) onLine(w, buf, stderr);
    });
  };

  const stop = (w: Watch) => {
    if (w.done) return;
    try {
      w.child.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      if (!w.done) {
        try {
          w.child.kill("SIGKILL");
        } catch {}
      }
    }, 2000).unref();
  };

  pi.registerTool({
    name: "bgwatch",
    label: "Background watch",
    description:
      "Run a command in the background and be woken by its output. Each batch of new " +
      "output lines (debounced, default 3s) is injected into the session and triggers a " +
      "turn, so you can react to a long-running watcher, a test run or a log tail without " +
      "polling. Use `pattern` (a regex) so only matching lines wake you; every line is " +
      "still written to the log. The process exit always wakes you. Files per watch under " +
      "$TMPDIR/pi-bgwatch/<pi pid>/<id>/: command, pid, output.log, exitcode (when done). " +
      "Stop one with bgwatch_stop; list them with bgwatch_list. Never busy-wait on a " +
      "watch: start it, finish your turn, and act when it wakes you.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to run, e.g. 'python3 watch.py --interval 60' or 'tail -f app.log'" }),
      title: Type.Optional(Type.String({ description: "Short name shown in every wake (defaults to the command)" })),
      pattern: Type.Optional(Type.String({ description: "Regex; only lines matching it wake you (all lines still go to the log)" })),
      debounce_ms: Type.Optional(Type.Number({ description: "Batch window in milliseconds before a wake (default 3000, 0 = per line)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the session cwd)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = `w${++counter}`;
      const dir = join(ROOT, id);
      mkdirSync(dir, { recursive: true });
      const logFile = join(dir, "output.log");
      let pattern: RegExp | undefined;
      if (params.pattern) {
        try {
          pattern = new RegExp(params.pattern);
        } catch (e) {
          return { content: [{ type: "text", text: `Invalid pattern: ${(e as Error).message}` }], isError: true } as any;
        }
      }
      writeFileSync(join(dir, "command"), params.command + "\n");
      const child = spawn("bash", ["-lc", params.command], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: params.cwd ?? ctx.cwd,
        env: process.env,
        detached: false,
      });
      writeFileSync(join(dir, "pid"), String(child.pid ?? "") + "\n");

      const w: Watch = {
        id,
        title: params.title ?? params.command,
        command: params.command,
        dir,
        logFile,
        child,
        log: createWriteStream(logFile, { flags: "w" }),
        pattern,
        debounceMs: params.debounce_ms ?? 3000,
        pending: [],
        dropped: 0,
        lines: 0,
        done: false,
        startedAt: Date.now(),
      };
      watches.set(id, w);
      feed(w, child.stdout!, false);
      feed(w, child.stderr!, true);
      child.on("error", (err) => onLine(w, `[bgwatch] spawn error: ${err.message}`, true));
      child.on("close", (code) => {
        w.done = true;
        w.exitCode = code;
        w.log.end();
        writeFileSync(join(dir, "exitcode"), String(code ?? 1) + "\n");
        wake(w, "exit");
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Started bgwatch ${id}: ${w.title}\n` +
              `pid ${child.pid}, log ${logFile}` +
              (pattern ? `\nwaking on lines matching /${params.pattern}/` : "") +
              `\nYou will be woken when output arrives (batched ${w.debounceMs}ms) and when it exits. End your turn now.`,
          },
        ],
        details: { id, pid: child.pid, logFile, dir },
      } as any;
    },
  });

  pi.registerTool({
    name: "bgwatch_stop",
    label: "Stop background watch",
    description: "Stop a background watch started with bgwatch (SIGTERM, then SIGKILL after 2s). Its exit wakes you once more.",
    parameters: Type.Object({ id: Type.String({ description: "The watch id, e.g. w1" }) }),
    async execute(_toolCallId, params) {
      const w = watches.get(params.id);
      if (!w) return { content: [{ type: "text", text: `No such watch: ${params.id}` }], isError: true } as any;
      if (w.done) return { content: [{ type: "text", text: `${params.id} already exited (${w.exitCode}).` }] } as any;
      stop(w);
      return { content: [{ type: "text", text: `Stopping ${params.id} (pid ${w.child.pid}).` }] } as any;
    },
  });

  pi.registerTool({
    name: "bgwatch_list",
    label: "List background watches",
    description: "List the background watches of this session with their state, line counts and log files.",
    parameters: Type.Object({}),
    async execute() {
      if (watches.size === 0) return { content: [{ type: "text", text: "No background watches." }] } as any;
      const rows = [...watches.values()].map((w) => {
        const state = w.done ? (w.child.killed ? "stopped" : `exit ${w.exitCode}`) : "running";
        const age = Math.round((Date.now() - w.startedAt) / 1000);
        return `${w.id}  ${state.padEnd(8)}  ${age}s  ${w.lines} lines  ${w.title}\n      log: ${w.logFile}`;
      });
      return { content: [{ type: "text", text: rows.join("\n") }] } as any;
    },
  });

  pi.on("session_shutdown", async () => {
    for (const w of watches.values()) {
      if (!w.done) {
        try {
          w.child.kill("SIGKILL");
        } catch {}
      }
      if (w.timer) clearTimeout(w.timer);
    }
    watches.clear();
  });
}
