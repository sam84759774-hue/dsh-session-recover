# dsh-session-recover

Recover broken sessions in **DeepSeek Harness (DSH)**. Zero dependencies, one file, CLI name `dsh-recover`.

It reads your real `$DSH_HOME`, checks it against DSH's own on-disk layout and identity rules, names the exact file that breaks startup, and prints the action to take.

## What it catches

**1. Flat session files in a project directory — breaks the whole app**

DSH only accepts `<sessions>/<project>/<session-id>/session.vN.jsonl.zstd`. A single flat `*.jsonl` (a decoded export, a manual backup) makes `dsh-session-persistence-jsonl` throw:

```
session artifact "...\\wechat-xxx.decoded.jsonl" uses the unsupported flat-file layout
```

The `workspace` plugin then fails to activate and `workspaceRegistry` stays pending, so the UI only shows:

```
workspace/create: active Service "workspaceController" is unavailable
```

**2. Sessions that exist on disk but belong to no workspace**

`sessionIds` in `workspace.json` is the authoritative sidebar list. Once a file goes missing, the next write prunes the id; putting the file back does not restore it. `--fix-orphans` re-attaches such sessions to the workspace whose `path` equals the session header's `cwd` (the same check `attachSession` performs), after backing up `workspace.json`.

**3. Multi-frame zstd logs mistaken for corrupt files**

DSH appends one zstd frame per event. A single-frame decompressor returns only the first line (usually the session header), which looks like a truncated file. The tool splits frames, decompresses each, validates every record and checks that `seq` increases.

**4. Known root causes in crash logs**

Scans `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log` (or the platform equivalent) for flat-file layout, wildcard binds, services left pending, compression mismatches and torn records.

## Usage

```bash
npx dsh-session-recover              # diagnose
npx dsh-session-recover --json       # machine-readable
npx dsh-session-recover --fix        # move flat artifacts to <DSH_HOME>/dsh-recover-quarantine/
npx dsh-session-recover --fix-orphans  # re-attach orphans (quit DSH first)
npx dsh-session-recover --home "D:\dsh-test"
```

Exit codes: `0` clean (warnings allowed), `1` errors, `2` cannot diagnose.

## What it does not do

- It never rewrites session content; it only reads the logs.
- It never guesses which workspace a session belongs to — only exact `cwd` ↔ `path` matches, and skipped sessions are reported with a reason.
- It never deletes anything: `--fix` moves files into a timestamped quarantine.
- It does not repair corrupt frames; it tells you which frame is broken.

MIT.
