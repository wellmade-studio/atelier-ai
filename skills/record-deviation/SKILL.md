---
name: record-deviation
description: Record a deliberate departure from a @wellmade/* baseline in .wellmade/deviations.md so it can be revisited. Use whenever you're about to disable or weaken a @wellmade/* rule on a brownfield project, flip a tsconfig strictness flag, replace @wellmade/prettier-config, or skip/substitute a @wellmade/* package (e.g. peer-dep mismatch). Each entry captures why and revisit-when. Also use to update or remove an existing entry.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# record-deviation

Most Wellmade tools are strict by design. Adopting them on a brownfield
project sometimes means temporarily deviating from a baseline — disabling
a lint rule, flipping a tsconfig flag, or skipping a `@wellmade/*`
package whose peer-deps don't fit. That's fine — but a silent deviation
becomes a permanent regression nobody remembers to fix.

This skill makes the deviation explicit. It writes (or updates) an
entry in `.wellmade/deviations.md` capturing what departed from the
baseline, why, and when it should be revisited. The companion skill
[`audit-deviations`](../audit-deviations) reports on the register over
time and detects untracked drift.

## What counts as a deviation

| Source     | Examples                                                                                |
| ---------- | --------------------------------------------------------------------------------------- |
| `eslint`   | Disabling `no-explicit-any`, lowering `no-unused-vars` from `error` to `warn`           |
| `tsconfig` | Setting `verbatimModuleSyntax: false`, `noUncheckedIndexedAccess: false`               |
| `prettier` | Replacing `@wellmade/prettier-config` with a `.prettierrc` or different package         |
| `stylelint`| Disabling a rule from `@wellmade/stylelint-config`                                      |
| `package`  | Skipping `@wellmade/lint-staged-config` because it pins an older `lint-staged` major   |

## When to use this skill

- About to disable a `@wellmade/eslint-config` rule on a project.
- About to set a `@wellmade/tsconfig` strictness flag to `false`.
- About to replace `@wellmade/prettier-config`.
- About to skip a `@wellmade/*` package (peer-dep mismatch, replacement
  in place, project-specific reasons).
- An existing entry needs its `revisit-when` or `why` updated.
- A deviation has been resolved — remove it from the register.

## When NOT to use this skill

- One-off `// eslint-disable-next-line` for a legitimate single-file
  reason. Inline disables don't shift the baseline.
- Adding *new* lint rules on top of `@wellmade/*` defaults (hardening,
  not deviation).
- Choosing not to install an *optional* Wellmade package on a project
  where it doesn't apply (e.g. no stylelint for a CSS-in-JS project).

## The fast path

```bash
node /path/to/atelier-ai/skills/record-deviation/record.mjs <id> \
  --why "..." --revisit-when "..."
```

Examples:

```bash
# ESLint rule — source inferred
record.mjs no-explicit-any \
  --why "143 usages in services/api; INGEST-412" \
  --revisit-when "after migration to @wellmade/bedrock parsers" \
  --initial-count 143

# tsconfig flag — source inferred from `tsconfig.` prefix
record.mjs tsconfig.verbatimModuleSyntax \
  --why "Nest CJS scaffold; ESM migration scheduled" \
  --revisit-when "2026-Q3"

# Skipped package — source inferred from @wellmade/ prefix
record.mjs @wellmade/lint-staged-config \
  --why "peer-dep mismatch with lint-staged@16; inline config works fine" \
  --revisit-when "after standards-js v0.2.0 widens the peer-dep range"

# Remove an entry
record.mjs no-explicit-any --remove
```

Flags:

- `--why <text>` — required when adding. Free-text justification.
- `--revisit-when <text>` — required when adding. Free-text condition
  or date. Loosely interpreted; `audit-deviations` flags entries that
  reference a year or ISO date in the past.
- `--source <kind>` — `eslint` | `tsconfig` | `prettier` | `stylelint`
  | `package`. Inferred from id when sensible.
- `--initial-count <n>` — error count at adoption (rule deviations
  only). Used by `audit-deviations --check-trajectories`.
- `--remove` — drop the entry instead of adding it.
- `--dry-run` — preview without writing.

## End-of-run behavior

The script **always** reports the register's current state at the
end: total count, breakdown by source, count of entries that look
overdue. The producer never leaves the system without surfacing what's
accumulating.

If `audit-deviations` is installed, it suggests running it for a
deeper report. If not, it prints a hint to install it.

## Register format

`.wellmade/deviations.md` is human-readable markdown with structured
fields per entry. The format is documented at the top of the file
itself. Entries can be edited by hand; the structured field lines
(starting with `- **<key>**:`) must stay parseable.

## Status

**New skill.** The format is intentionally simple to keep hand-editing
easy. The `package` source was added after a customer reported having
to skip `@wellmade/lint-staged-config` over a peer-dep mismatch.
