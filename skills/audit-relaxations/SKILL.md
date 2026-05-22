---
name: audit-relaxations
description: Audit the .wellmade/relaxations.md register on a project — re-run each tracked rule, report whether it's now more tractable to re-enable, surface drift (rules relaxed in configs but not in the register), and flag entries that look overdue. Use periodically (e.g. quarterly), before a release, or in CI. Companion to relax-rule.
allowed-tools: Read, Bash, Glob, Grep
---

# audit-relaxations

Periodic check on the relaxations register. The register is only
useful if someone looks at it. This skill makes that easy and ships
it as either a one-shot report or a CI gate.

## When to use this skill

- Quarterly housekeeping on a Wellmade-adopting project.
- Before a major release, to see what tech debt is on the books.
- In CI, to prevent new untracked relaxations from sneaking in.
- After a big refactor (e.g. a migration to `@wellmade/bedrock`)
  to see which entries are now ripe for removal.

## When NOT to use this skill

- Before any relaxations have been recorded — there's nothing to
  audit. Use `relax-rule` to populate the register first.
- For one-off questions about a single rule. Just grep
  `.wellmade/relaxations.md` directly.

## The fast path

```bash
node /path/to/atelier-ai/skills/audit-relaxations/audit.mjs
```

Flags:

- `--check-trajectories` — for each tracked ESLint rule, re-runs the
  rule against current code and compares the violation count to the
  entry's `initial-count`. Slower (re-runs ESLint per entry) but
  surfaces "this is now tractable to fix" signals. Off by default.
- `--ci` — non-zero exit code if there are untracked drift entries,
  overdue entries, or (with `--check-trajectories`) a violation count
  trajectory that improved enough to flag as "consider re-enabling."
- `--json` — machine-readable output.

## What it reports

Three sections, each meaningful on its own:

### Tracked relaxations

Reads `.wellmade/relaxations.md`, lists each entry with its
`revisit-when`, age, and (with `--check-trajectories`) current vs
initial violation count.

### Drift

Compares the project's resolved configs to the Wellmade baselines.
Any rule that's relaxed in the config but **not** in the register is
flagged as drift — someone weakened the baseline without recording it.
Drift entries are actionable: either record them in the register
(`relax-rule <id>`) or restore the baseline.

### Overdue

Entries whose `revisit-when` mentions an ISO date or year that's
already passed. The check is intentionally loose — `audit-relaxations`
flags it for human review, doesn't hard-fail.

## CI integration

```yaml
# .github/workflows/audit.yml
- run: node skills/audit-relaxations/audit.mjs --ci
```

In `--ci` mode, the script exits non-zero on:

- Any drift (untracked relaxations) — a hard error; either track or fix.
- Any overdue entry — a softer signal; configurable via
  `--allow-overdue` if you want CI to be lenient.

Trajectory improvements never fail CI — they're informational.

## Status

**New skill.** The drift-detection accuracy depends on ESLint's
`--print-config` resolving the same way for both your project and a
clean Wellmade baseline. If you see false-positive drift, file an
issue at https://github.com/wellmade-studio/atelier-ai/issues with the
output and your `eslint.config.js`.
