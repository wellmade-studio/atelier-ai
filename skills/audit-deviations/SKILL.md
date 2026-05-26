---
name: audit-deviations
description: Audit the .wellmade/deviations.md register on a project — list tracked deviations, detect drift (departures from a @wellmade/* baseline not recorded in the register), flag entries that look overdue, optionally re-run each ESLint rule to compute violation-count trajectories. Use periodically (quarterly, before a release) or in CI. Companion to record-deviation.
allowed-tools: Read, Bash, Glob, Grep
---

# audit-deviations

Periodic check on the deviations register. The register is only
useful if someone looks at it. This skill makes that easy and ships
it as either a one-shot report or a CI gate.

## When to use this skill

- Quarterly housekeeping on a Wellmade-adopting project.
- Before a major release, to see what tech debt is on the books.
- In CI, to prevent new untracked deviations from sneaking in.
- After a big refactor (e.g. a migration to `@wellmade/bedrock`) or a
  `standards-js` peer-dep widening, to see which entries are now ripe
  for removal.

## When NOT to use this skill

- Before any deviations have been recorded — there's nothing to audit.
  Use `record-deviation` to populate the register first.
- For one-off questions about a single entry. Just grep
  `.wellmade/deviations.md` directly.

## The fast path

```bash
node /path/to/atelier-ai/skills/audit-deviations/audit.mjs
```

Flags:

- `--check-trajectories` — for each tracked ESLint rule with an
  `initial-count`, re-runs the rule against current code and compares.
  Slower; surfaces "this is now tractable to fix" signals.
- `--ci` — exit non-zero on untracked drift or overdue entries.
- `--allow-overdue` — in CI mode, allow overdue entries to pass.
- `--json` — machine-readable output.

## What it reports

### Tracked

Lists every entry in `.wellmade/deviations.md` with its `revisit-when`,
overdue marker, and (with `--check-trajectories`) initial vs current
violation count.

### Drift

Compares the project's actual configs + installed packages to the
Wellmade baselines. Any deviation present in the configs but **not** in
the register is flagged as drift — someone weakened the baseline (or
skipped a package) without recording it.

Drift detection runs across all four sources:

- **eslint** — rules lowered in the project's resolved flat config
- **tsconfig** — strictness flags flipped from baseline
- **prettier** — `package.json#prettier` set to something non-Wellmade
- **package** — core `@wellmade/*` packages missing when other
  `@wellmade/*` packages are installed (partial adoption signals an
  intent to adopt the rest)

### Overdue

Entries whose `revisit-when` mentions an ISO date or year in the past.
Heuristic — flagged for review, not hard-failed (unless `--ci`).

### Trajectories (opt-in)

For ESLint rule entries with `--initial-count` recorded, re-runs the
rule against the current code and reports: did the count go down? That
signals the underlying issue might now be tractable to fix and the
deviation could be removed.

## CI integration

```yaml
- run: node skills/audit-deviations/audit.mjs --ci
```

Exits non-zero on:

- Any drift entry (hard error)
- Any overdue entry (unless `--allow-overdue`)

Trajectory improvements never fail CI — they're informational.

## Status

**New skill.** Drift accuracy depends on ESLint's `--print-config`
resolving the same way for both your project and the baseline. If you
see false-positive drift, file an issue at
https://github.com/wellmade-studio/atelier-ai/issues with output and
your `eslint.config.js`.
