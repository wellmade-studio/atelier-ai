---
name: relax-rule
description: Record a deliberate relaxation of a Wellmade lint/TS/Prettier rule in .wellmade/relaxations.md so it can be revisited. Use whenever you're about to disable or weaken a @wellmade/* baseline rule on a brownfield project — instead of silently editing eslint.config.js / tsconfig.json, run this so the relaxation gets tracked with a "why" and a "revisit-when". Also use to update or remove an existing entry.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# relax-rule

Most Wellmade tools are strict by design. Adopting them on a brownfield
project often means temporarily relaxing a rule to keep the project
buildable. That's fine — but a relaxation without a record is a
permanent regression nobody remembers to fix.

This skill makes the relaxation explicit. It writes (or updates) an
entry in `.wellmade/relaxations.md` capturing what was relaxed, why,
and when it should be revisited. The companion skill
[`audit-relaxations`](../audit-relaxations) reports on the register
over time.

## When to use this skill

- An agent or human is about to disable a `@wellmade/eslint-config`
  rule on a project, set a `@wellmade/tsconfig` strictness flag to
  `false`, or replace `@wellmade/prettier-config` with something else.
- An existing relaxation needs its `revisit-when` or `why` updated.
- A relaxation has been resolved and should be removed from the register.

## When NOT to use this skill

- For one-off `// eslint-disable-next-line` on a single line for a
  legitimate reason. Inline disables are fine; they don't shift the
  baseline. The register is for *config-level* shifts that affect
  every file.
- For project-wide rules that *weren't* in the Wellmade baseline. If
  the rule is being added on top of `@wellmade/*` defaults (not
  relaxing them), it's a hardening, not a relaxation.

## The fast path

```bash
node /path/to/atelier-ai/skills/relax-rule/relax.mjs <rule-id> \
  --why "..." --revisit-when "..."
```

Examples:

```bash
# Disable an ESLint rule, document why and when to revisit
node relax.mjs no-explicit-any \
  --why "143 usages in services/api need to type Mongoose docs first; tracked in INGEST-412" \
  --revisit-when "after migration to @wellmade/bedrock parsers"

# Override a tsconfig strictness flag
node relax.mjs tsconfig.verbatimModuleSyntax \
  --why "Nest scaffold uses CommonJS; ESM migration scheduled for Q3" \
  --revisit-when "2026-Q3"

# Remove an entry once the underlying issue is fixed
node relax.mjs no-explicit-any --remove
```

Flags:

- `--why <text>` — required when adding. Free-text justification.
- `--revisit-when <text>` — required when adding. Free-text condition
  or date. Loosely interpreted; `audit-relaxations` flags entries that
  reference a year or ISO date in the past.
- `--source <kind>` — `eslint` (default) | `tsconfig` | `prettier` |
  `stylelint`. Inferred from rule id for the common cases (any rule id
  starting with `tsconfig.` is treated as a tsconfig override).
- `--initial-count <n>` — error count at adoption time. Helpful when
  the relaxation came from a brownfield-import; `audit-relaxations`
  uses it to compute trajectories.
- `--remove` — drop the entry instead of adding it.
- `--dry-run` — show what would change without writing.

## What the script does

1. Validates the rule actually *exists* in the relevant Wellmade
   baseline (an ESLint rule that isn't part of `@wellmade/eslint-config`
   doesn't need to be in this register — go disable it directly).
2. Adds or updates the entry in `.wellmade/relaxations.md`.
3. Adds a comment to the corresponding config file pointing at the
   register (e.g. `// see .wellmade/relaxations.md#no-explicit-any`
   above the override block in `eslint.config.js`).
4. **Always reports the register's current state** at end-of-run:
   total count, breakdown by source, count of entries that look
   overdue. The producer never leaves the system without surfacing
   what's accumulating.
5. If `audit-relaxations` is installed, suggests running it for a
   deeper report. If not, prints a hint to install it for
   trajectory tracking.

## Register format

`.wellmade/relaxations.md` is human-readable markdown with structured
fields per entry. The format is documented at the top of the file
itself. Entries can be edited by hand; the structured field lines
(starting with `- **<key>**:`) must stay parseable.

## Status

**New skill.** Format and behavior may change as it's used on real
projects. The register format is intentionally simple to keep
hand-editing easy.
