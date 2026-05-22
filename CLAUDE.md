# atelier-ai

This repo holds AI tooling for the Wellmade toolchain — skills, agents,
hooks, and templates that make any coding agent useful on a Wellmade
project. Agent-agnostic by design (Claude Code, Cursor, Continue,
Aider, etc. — same artifacts, different install paths).

It's a sibling to `standards-js/` (lint/format configs), `bedrock-js/`
(runtime library), and the future `cli/` and `gh-actions/` repos. See
the meta workspace `CLAUDE.md` one level up for the full picture.

## What goes where

Organize by **kind**, not by target framework. A skill that configures
NestJS lives in `skills/`, not `nestjs/`. This keeps the layout stable
as we add new targets and makes "what kind of artifact am I writing?"
the first question.

| Folder        | What goes here                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `skills/`     | Skill definitions. Each is a folder with `SKILL.md` + optional helpers.                         |
| `agents/`     | Subagent definitions (markdown with frontmatter) for agents that support spawning sub-workers.  |
| `hooks/`      | Shell scripts called by agent lifecycle hooks. Must be executable and self-contained.           |
| `templates/`  | `AGENTS.md`, `CLAUDE.md`, and other context-injecting templates dropped into scaffolds.         |

## Conventions

- **Agent-agnostic.** Skills and agents target the common conventions
  (markdown + frontmatter, `AGENTS.md`-style context, hook scripts).
  Don't hard-code paths or tool names unique to one vendor's CLI when a
  generic form works.
- **Brand-neutral.** No prior-employer or third-party brand names ([REDACTED],
  [REDACTED], [REDACTED], [REDACTED], [REDACTED], [REDACTED], `[REDACTED]`). Wellmade's own
  brand is fine and expected.
- **MIT-licensed**, copyright Wellmade.
- **Voice** matches Wellmade's: anti-hype, conversational, plain English.
  Skills and agents talk to the user the same way the rest of the
  toolchain does.
- **One job per skill/agent.** If it's doing two things, split it. The
  skill list is the discovery surface — names should be obvious.
- **No half-finished pieces shipped.** A stub in the README is fine; a
  half-working skill that fails silently is not.

## What goes in `standards-js/` vs here

If it's a **lint rule, format rule, or TS config** that runs at
dev/CI time → `standards-js/`. It ships to npm, customers install it.

If it's **AI-facing tooling** (a skill, an agent, a template that
tells the agent how to work in a Wellmade project) → here.

If you're not sure, ask: *does the customer's CI need this?* If yes,
it's `standards-js`. If only the agent needs it, it's `atelier-ai`.

## What goes in `atelier-ai/` vs the future `@wellmade/cli`

This is the trickier seam. The factoring:

- **Mechanical wiring** (detect stack, install packages, write files,
  run typecheck/lint/format) → **CLI**. No judgment required, runnable
  from CI, useful even without an agent in the loop.
- **Agent-facing context** (skill descriptions, hooks, AGENTS.md
  templates) → **atelier-ai**. Only meaningful inside an agent session.
- **Orchestrators** (`configure-project`, `wire-project`) live here
  **today** with embedded scripts (`configure.mjs`, `wire.mjs`)
  because the CLI doesn't exist yet. The scripts are written so the
  logic can migrate cleanly into `wm configure` / `wm wire` when the
  CLI ships, leaving thin SKILL.md wrappers behind that say "run `wm
  <command>`."

Rule of thumb: if a script's body would work unchanged as a CLI
subcommand body, it's CLI work temporarily living here. Don't add
agent-only assumptions (no prompting beyond what `--yes` controls, no
calls back into the agent) — those would prevent the migration.

## Adding a skill

1. Create `skills/<skill-name>/SKILL.md` with the standard frontmatter
   (`name`, `description`, `allowed-tools`).
2. The `description` field is what Claude reads to decide when to use
   the skill — be specific about when it applies and when it doesn't.
3. Add an entry to the README table.
4. If the skill needs helper scripts, put them in
   `skills/<skill-name>/` alongside `SKILL.md`.

## Adding an agent

1. Create `agents/<agent-name>.md` with frontmatter for `name`,
   `description`, `tools`, optional `model`.
2. The `description` should tell the parent agent *when* to spawn this
   subagent.
3. Keep the tool list minimal — fewer tools = more predictable behavior.

## Sibling-repo coupling

When a skill or agent here references something from `standards-js/` or
`bedrock-js/`, treat that reference as an **optional peer** — the
artifact should degrade gracefully if the customer hasn't installed the
sibling package. Don't hard-fail on a missing `@wellmade/*` peer; detect
and suggest.
