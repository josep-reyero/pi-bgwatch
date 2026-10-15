# pi-bgwatch

Background processes that **wake the agent** — the equivalent of Claude Code's
`Monitor` tool for [pi](https://pi.dev).

Start a long-running command (a PR watcher, a test loop, `tail -f`), end your
turn, and pi wakes the agent with the new output as it arrives. No polling, no
sleep loops.

```
pi install npm:pi-bgwatch
# or, straight from GitHub
pi install git:github.com/josep-reyero/pi-bgwatch
```

## Tools

| Tool | What it does |
|---|---|
| `bgwatch` | Run `command` in the background. New output lines are batched (`debounce_ms`, default 3000) and injected into the session as a message that triggers a turn. `pattern` (regex) selects which lines wake the agent; every line still goes to the log. The process exit always wakes the agent. |
| `bgwatch_stop` | Stop a watch by id (SIGTERM, SIGKILL after 2 s). |
| `bgwatch_list` | List this session's watches, their state and logs. |

Each watch keeps `command`, `pid`, `output.log` and (when done) `exitcode`
under `$TMPDIR/pi-bgwatch/<pi pid>/<id>/`, so several pi sessions on one host
never share a directory.

## Example

```
bgwatch command="python3 pr_watch.py --repo org/repo --pr 185 --interval 60"
        title="PR 185" pattern="^(CHECKS|REVIEW|THREAD|HEAD|LABEL|DONE)"
```

The agent ends its turn. A few minutes later:

```
bgwatch w1 (PR 185) output:
CHECKS head=530fc4c ok=11 failing=0 pending=0
REVIEW copilot COMMENTED 0 findings
LABEL + needs-human
Log: /tmp/pi-bgwatch/48213/w1/output.log
```

…and the agent acts on it.

## Why not `pi-monitor`?

`pi-monitor` shows output in a floating window and wakes the agent only when
the process **exits**; a watcher that runs for hours never wakes anyone. It
also numbers its sessions `mon-1`, `mon-2`… in a shared `/tmp/pi-monitor`, so
two pi sessions on one machine overwrite each other's logs. `pi-bgwatch` wakes
on output, filters and batches it, and isolates sessions by pid.

## Design notes

- Messages are sent with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`:
  if the agent is mid-turn the wake queues behind it instead of interrupting.
- At most 200 lines per wake; the rest is counted and pointed at the log.
- Children are killed on `session_shutdown`.
- Works in interactive, RPC and print modes: nothing here needs a terminal UI.

## License

MIT
