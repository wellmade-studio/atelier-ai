# atelier-ai

AI tooling for the Wellmade toolchain — the workshop where coding
agents get the context, skills, and agents they need to be useful on a
Wellmade project.

Agent-agnostic by design. The pieces here work with any coding agent
that respects the common conventions (skills as markdown with
frontmatter, `AGENTS.md` / `CLAUDE.md` context files, hook scripts).
Claude Code, Cursor, Continue, Aider, whatever — same artifacts.

Not a framework. Not a runtime. A collection of small, opinionated
pieces — each one earns its keep on its own.

| Folder                              | What lives here                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| [`skills/`](./skills)               | Skill definitions (markdown + optional helpers). User-invoked or auto-triggered by the skill's description. |
| [`agents/`](./agents)               | Subagent definitions for agents that support spawning scoped, parallelizable workers.        |
| [`hooks/`](./hooks)                 | Shell scripts wired into agent settings as lifecycle hooks. The harness runs these, not the model. |
| [`templates/`](./templates)         | `AGENTS.md`, `CLAUDE.md`, and other context files dropped into scaffolded projects.          |

## What's here today

- **[`skills/setup-project`](./skills/setup-project)** — top-level "make
  this project Wellmade-ready" skill. Detects services
  (`package.json#workspaces` if declared, else `services/* apps/*
  packages/*`), runs `configure-service` on each, drops the AGENTS.md
  template, optionally installs the lint-on-edit hook. The thing you
  reach for on a fresh clone.
- **[`skills/configure-service`](./skills/configure-service)** —
  per-service configurator. Detects the stack (NestJS, Vite, Astro,
  Vite-React, Next.js, plain Node/TS) and wires the `@wellmade/*`
  configs end-to-end. Called by `setup-project` per service; can also
  be used standalone.
- **[`skills/record-deviation`](./skills/record-deviation)** — record a
  deliberate departure from a Wellmade baseline in
  `.wellmade/deviations.md`. Covers disabled rules, flipped tsconfig
  flags, replaced Prettier configs, *and* skipped `@wellmade/*` packages.
  Stops brownfield adoption from accumulating invisible tech debt:
  every deviation gets a `why` and a `revisit-when`. Always reports
  register state on every run.
- **[`skills/audit-deviations`](./skills/audit-deviations)** — periodic
  check on the register. Detects drift across all four sources (eslint,
  tsconfig, prettier, package), flags overdue entries, optionally
  re-runs each ESLint rule to compute violation-count trajectories.
  CI-friendly with `--ci`.
- **[`skills/bump-packages`](./skills/bump-packages)** — bump every
  `@wellmade/*` package across a project (or monorepo) to the latest
  versions in lockstep. Pairs with `audit-deviations`: a `standards-js`
  release that widens a peer-dep range may now allow a previously-skipped
  package to be installed. Run periodically.
- **[`templates/AGENTS.md`](./templates/AGENTS.md)** — the Wellmade
  conventions in a portable file. Wrapped in marker comments so
  `atelier-ai` can update it in place without clobbering project-specific
  content the user added.
- **[`hooks/lint-on-edit.sh`](./hooks/lint-on-edit.sh)** — `PostToolUse`
  hook that runs `eslint --fix` + `prettier --write` on the changed
  file after every `Edit`/`Write`/`MultiEdit`. Surfaces remaining
  errors to the agent without blocking the tool call.

More to come. Each piece ships when there's a real need for it — not
before.

### Which skill do I want?

| If you want to…                                                            | Use                  |
| -------------------------------------------------------------------------- | -------------------- |
| Set up Wellmade on a fresh clone (single repo or monorepo)                 | `setup-project`       |
| Set up Wellmade on one service that doesn't have it yet                    | `configure-service`  |
| Disable a Wellmade rule, flip a tsconfig flag, or skip a `@wellmade/*` pkg | `record-deviation`   |
| See what deviations are tracked + find untracked drift                     | `audit-deviations`   |
| Bump every `@wellmade/*` package to latest in lockstep                     | `bump-packages`    |
| Get inline lint/format on every file the agent edits                       | `hooks/lint-on-edit` |
| Drop the Wellmade conventions into a project's `AGENTS.md`                 | `templates/AGENTS.md` (auto, via `setup-project`) |

How they fit together:

```
setup-project ──────────→ configure-service (per service)
                    └──→ AGENTS.md template
                    └──→ lint-on-edit hook (optional)

day-to-day:    record-deviation ←→ audit-deviations
                                          ↑
                                  bump-packages
                          (re-runs audit afterward to
                           surface resolvable entries)
```

### Wiring the hook (per agent)

The hook script is portable; the *wiring* depends on which agent you
use. `setup-project` does this for Claude Code automatically. For
others:

**Claude Code** — add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "$HOME/.claude/hooks/lint-on-edit.sh" }]
      }
    ]
  }
}
```

**Cursor / Continue / other agents** — consult your agent's hook
documentation. The script reads the tool-call JSON on stdin and looks
for `.tool_input.file_path`; override with `ATELIER_AI_FILE_PATH_JQ` if
your agent uses a different field.

## Install

Three ways, pick the one that fits your setup.

### 1. Single skill via [skills.sh](https://skills.sh) (recommended for one-offs)

```bash
npx skills add wellmade-studio/atelier-ai/skills/configure-service
```

The skills.sh CLI accepts a subpath. Substitute any skill name to
install just that one. Re-run later to update.

### 2. Everything at once via `install.sh`

```bash
curl -fsSL https://raw.githubusercontent.com/wellmade-studio/atelier-ai/main/install.sh | bash
```

What it does:

- Clones (or updates) the repo into `~/.atelier-ai/`
- Symlinks `skills/*`, `agents/*`, `hooks/*` into `~/.claude/skills/`,
  `~/.claude/agents/`, `~/.claude/hooks/`
- Idempotent — re-run anytime to pull updates

Flags worth knowing (pass them with `bash -s --`):

```bash
# Install into a different agent's config dir
curl -fsSL https://raw.githubusercontent.com/wellmade-studio/atelier-ai/main/install.sh \
  | bash -s -- --prefix ~/.cursor

# Skills only, no agents or hooks
curl -fsSL .../install.sh | bash -s -- --only skills

# Pin a branch or tag
curl -fsSL .../install.sh | bash -s -- --branch v1.0.0

# Uninstall (removes symlinks, keeps the clone)
curl -fsSL .../install.sh | bash -s -- --uninstall
```

Don't want to pipe curl to bash? Same script, run manually:

```bash
git clone https://github.com/wellmade-studio/atelier-ai.git ~/.atelier-ai
~/.atelier-ai/install.sh
```

### 3. Manual git clone + symlink

```bash
git clone https://github.com/wellmade-studio/atelier-ai.git ~/.atelier-ai
ln -s ~/.atelier-ai/skills/configure-service ~/.claude/skills/configure-service
```

Useful when you want a specific subset and prefer to wire it yourself.

## Sibling repos

- [`wellmade-studio/standards-js`](https://github.com/wellmade-studio/standards-js) — the lint/format/TS configs `configure-service` installs.
- [`wellmade-studio/bedrock-js`](https://github.com/wellmade-studio/bedrock-js) — the runtime library standards-js's opt-in `bedrockPreset` points at.

## License

MIT. See [LICENSE](./LICENSE).
