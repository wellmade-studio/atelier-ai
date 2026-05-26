---
name: bump-packages
description: Bump every @wellmade/* package across a project (or monorepo) to the latest published versions in lockstep. Detects per-service and root-level @wellmade/* deps, surfaces what would change, optionally runs npm install + audit-deviations after to see if any tracked deviations are now resolvable. Use periodically (monthly, before a release) or whenever a customer reports that a new @wellmade/* version landed.
allowed-tools: Read, Bash, Glob, Grep
---

# bump-packages

Companion to `configure-service` and `setup-project`. Those skills get
Wellmade onto a project; this one keeps it current.

The mechanics — find every `@wellmade/*` dep, look up the latest
version, bump in lockstep, run install — are the kind of thing the
future `@wellmade/cli` will own as `wm bump`. For now this skill
embeds the logic so customers don't have to write the same loop by
hand on every monorepo.

## When to use this skill

- Periodically (monthly is reasonable for active customers).
- After a `standards-js` release widens a peer-dep range, to see if
  any previously-skipped packages can now be installed (pairs with
  `audit-deviations` to clear `package` deviations).
- Before a major release of the customer's product, to land the
  current toolchain alongside the release.
- When a customer reports "the toolchain feels stale."

## When NOT to use this skill

- On a project that doesn't have any `@wellmade/*` packages yet —
  start with `setup-project` instead.
- For a one-off update of a single package — `npm install --save-dev
  @wellmade/<x>@latest` is simpler. This skill is for the *cross-service
  lockstep* case.

## The fast path

```bash
node /path/to/atelier-ai/skills/bump-packages/bump.mjs
```

Flags:

- `--dry-run` — preview the bump plan without installing.
- `--yes` — skip the confirmation prompt.
- `--include <glob>` — restrict to specific workspaces (default: all).
- `--skip-audit` — don't run `audit-deviations` after the bump.
- `--exact` — install exact versions (`1.2.3`) instead of caret ranges
  (`^1.2.3`). Default is caret.

## What it does

### Step 1 — Discover all `@wellmade/*` deps

Walks the project for `package.json` files (using
`package.json#workspaces` if declared, else `services/*`, `apps/*`,
`packages/*`, else the repo root as a single package — same discovery
order as `setup-project`).

For each `package.json`, extracts every `@wellmade/*` package from
`dependencies` and `devDependencies` with its current version range.

### Step 2 — Resolve latest versions

For each unique `@wellmade/*` package found, runs
`npm view <pkg> version` to get the current `latest` tag from npm.
Caches per-package to avoid duplicate lookups.

### Step 3 — Print the plan

Per workspace, lists which packages would be bumped:

```
services/api
  @wellmade/eslint-config:    ^0.1.2 → ^0.2.0  ↑
  @wellmade/prettier-config:  ^0.1.0 → ^0.1.0  (already current)
  @wellmade/tsconfig:         ^0.1.2 → ^0.1.2  (already current)
services/web
  @wellmade/eslint-config:    ^0.1.2 → ^0.2.0  ↑
  @wellmade/prettier-config:  ^0.1.0 → ^0.1.0  (already current)
Root
  @wellmade/commitlint-config: ^0.1.1 → ^0.1.1  (already current)
```

### Step 4 — Confirm + install

Unless `--yes`, asks before running. On confirm, runs
`npm install --save-dev @wellmade/foo@^X @wellmade/bar@^Y ...` *per
workspace*. In an npm-workspaces monorepo, the lockfile updates at
the root automatically (same caveat as `configure-service` Step 5
calls out).

### Step 5 — Post-update audit (optional)

Unless `--skip-audit`, runs `audit-deviations` afterward. Surfaces:

- Whether any *package*-source deviations have been resolved (e.g.
  `@wellmade/lint-staged-config` was previously skipped because of a
  peer-dep mismatch, and the new version now satisfies it).
- Whether the bump introduced new drift (rare but possible if a new
  `@wellmade/*` version added a baseline rule that the project's
  config doesn't yet honor).

## What it doesn't do

- **Doesn't bump non-`@wellmade/*` packages.** That's the job of
  `npm-check-updates` / `dependabot` / `renovate`. This skill stays
  narrowly focused on the Wellmade toolchain.
- **Doesn't open PRs.** Local install only. Wire it into CI or a
  scheduled job if you want PR-style updates.
- **Doesn't migrate breaking changes.** If a new `@wellmade/*` major
  introduces a breaking change, this skill won't run the codemod —
  it'll just bump the version and let the verify step (typecheck +
  lint) surface the breakage.

## Future: the wm CLI

Like `configure-service` and `setup-project`, this skill's body is
embedded `.mjs` today. When `@wellmade/cli` ships, the logic moves
into `wm bump`, and this SKILL.md becomes a thinner wrapper that
tells the agent to invoke the CLI. The judgment layer (when to use,
when not to) stays here.

## Status

**New skill.** Conceived after a peer-dep audit revealed multiple
`@wellmade/*` packages with narrowable ranges; the skill exists so
customers don't have to manually walk every service after a Wellmade
release.
