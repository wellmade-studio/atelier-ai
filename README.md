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

- **[`skills/configure-project`](./skills/configure-project)** — detects
  the project stack (NestJS API, Vite-React frontend, plain Node, etc.)
  and wires up `@wellmade/eslint-config`, `@wellmade/prettier-config`,
  `@wellmade/stylelint-config`, and (when published) `@wellmade/tsconfig`
  end-to-end. The thing you reach for on a fresh service.

More to come. Each piece ships when there's a real need for it — not
before.

## Install

Three ways, pick the one that fits your setup.

### 1. Single skill via [skills.sh](https://skills.sh) (recommended for one-offs)

```bash
npx skills add wellmade-studio/atelier-ai/skills/configure-project
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
ln -s ~/.atelier-ai/skills/configure-project ~/.claude/skills/configure-project
```

Useful when you want a specific subset and prefer to wire it yourself.

## Sibling repos

- [`wellmade-studio/standards-js`](https://github.com/wellmade-studio/standards-js) — the lint/format/TS configs `configure-project` installs.
- [`wellmade-studio/bedrock-js`](https://github.com/wellmade-studio/bedrock-js) — the runtime library standards-js's opt-in `bedrockPreset` points at.

## License

MIT. See [LICENSE](./LICENSE).
