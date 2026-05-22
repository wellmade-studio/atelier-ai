---
name: wire-project
description: Wire a project (single repo or monorepo) for the full Wellmade workflow — runs configure-project on each service, drops the AGENTS.md template, installs the lint-on-edit hook. Use when the user asks to "wire up wellmade", "set up the whole project", "make this monorepo wellmade-ready", or has just cloned a project and wants the toolchain applied across all services at once.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# wire-project

Top-level "make this project Wellmade-ready" skill. Calls
[`configure-project`](../configure-project) per service, drops the
AGENTS.md template, installs the lint-on-edit hook into the agent's
config.

The fast path is [`wire.mjs`](./wire.mjs) — runs the whole sequence
with one command. Fall back to the playbook below for surgery.

## When to use this skill

- User says "wire up wellmade", "set up the project", "make this
  monorepo wellmade-ready".
- Fresh clone of a customer project where nothing has been configured yet.
- New `services/<name>/` folder added and the user wants it brought up
  to the rest of the monorepo's conventions.

## When NOT to use this skill

- Just one service to configure — use [`configure-project`](../configure-project) directly.
- The project is already wired and you just want to *update* the
  configs — that's `upgrade-wellmade` (not built yet).

## The fast path

```bash
node /path/to/atelier-ai/skills/wire-project/wire.mjs
```

Accepts `--dry-run`, `--yes`, `--skip-hook`, `--skip-template`,
`--services <glob>` (override workspace detection).

## What it does (playbook)

### Step 1 — Discover services

Read `package.json` at the repo root. Pick the discovery method:

1. **If `package.json#workspaces` is declared**, use those globs as the
   service list. Respects existing monorepo wiring (Turborepo, Nx,
   plain npm workspaces).
2. **Otherwise**, scan in order: `services/*`, `apps/*`, `packages/*`.
   Each subfolder with a `package.json` counts.
3. **If neither yields any services**, treat the repo root as a single
   service.

Print the list and **ask the user to confirm** before doing any writes.
A monorepo with 12 services configured silently is a recipe for
regret — show the list, take consent.

### Step 2 — Configure each service

For each discovered service, run the `configure-project` logic
(same script, called per-service). Skip services that already have
`@wellmade/eslint-config` installed *unless* the user asked for a
re-run.

In a monorepo, also configure the **repo root** for shared concerns:
- Root `package.json#prettier` field → `@wellmade/prettier-config`
- Root `tsconfig.json` extending `@wellmade/tsconfig/base.json`
- Root `commitlint.config.js` if the project has `.git/`

### Step 3 — Drop the AGENTS.md template

Copy `templates/AGENTS.md` to the repo root. **Do not clobber** an
existing `AGENTS.md`:

- If no `AGENTS.md` exists → write the template as-is.
- If `AGENTS.md` exists but **does not** contain the
  `<!-- atelier-ai:wellmade-conventions:start -->` marker → **append**
  the Wellmade section to the bottom (preserving the user's content).
- If `AGENTS.md` exists and **contains** the marker block → **replace
  just that block** in place. User's other content untouched.

This way the file works the same on a virgin repo, a repo with a
hand-rolled AGENTS.md, and a repo where atelier-ai has been re-run.

Also: do the same for `CLAUDE.md` if the user wants both surfaces
(Claude Code reads CLAUDE.md preferentially; other agents read AGENTS.md).
Default: write AGENTS.md only. Add `--also-claude-md` to write both.

### Step 4 — Install the lint-on-edit hook (optional, asks first)

Wiring a hook into the agent's config is per-agent. The script asks:

> Install lint-on-edit hook into ~/.claude/settings.json? [y/N]

If yes:
- Ensure `~/.claude/hooks/lint-on-edit.sh` exists (symlink to the
  atelier-ai checkout, or copy if `--copy-hooks`).
- Edit `~/.claude/settings.json` to add the `PostToolUse` entry that
  matches `Edit|Write|MultiEdit` and points at the script.
- If the entry already exists, no-op.

For non-Claude agents, print the equivalent snippet and exit — don't
guess at other agents' config formats.

### Step 5 — Report

Print a summary:

```
Services configured: 3
  ✓ services/api
  ✓ services/web
  ✓ services/admin
Root configs: prettier, tsconfig, commitlint
AGENTS.md: appended Wellmade section
Hook installed: ~/.claude/hooks/lint-on-edit.sh
```

## Future: the wm CLI

Most of `wire.mjs` is mechanical: detect, install, write, verify.
That's CLI work, not skill work. When `@wellmade/cli` ships,
`wm wire` will own this logic, and this SKILL.md becomes a thin
wrapper that says "run `wm wire`". The hook and AGENTS.md template
stay in atelier-ai (they're not CLI-shaped artifacts).

For now: the script lives here so customers can use the workflow
today, without waiting for the CLI.
