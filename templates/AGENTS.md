<!-- atelier-ai:wellmade-conventions:start -->
# Wellmade conventions

This project uses the [Wellmade toolchain](https://github.com/wellmade-studio).
The block below tells coding agents (Claude Code, Cursor, etc.) the
conventions to follow. Don't remove the marker comments — they let
`atelier-ai` update this section in place when conventions evolve.

## Definition of done

A task is **done** when, in this order:

1. `npm run typecheck` passes
2. `npm run lint` passes
3. `npm run format:check` passes
4. The change does what was asked

Run them before reporting a task complete. Don't claim "done" on a
green test suite alone — Wellmade's strict TS config catches things
tests miss.

## Code style

- **Use `??` not `||`** for default values. `||` swallows `0`, `''`,
  `false`, `null` — almost always a bug.
- **Use `for...of` not `forEach`** when the loop body needs `await`
  or `return` / `break`.
- **No `console.log` in committed code.** The lint config will fail
  CI on it. Use a real logger or remove before committing.
- **Prefer named exports.** Default exports work, but they cost
  refactor-by-rename tooling. The lint config flags them outside
  framework-mandated locations (Next pages, etc.).
- **No `as` casts** without a comment explaining *why* the type system
  can't see what you can. Type assertions are a smell.

## Parsing and primitives

If `@wellmade/bedrock` is installed (check `package.json`):

- **`JSON.parse` → `parseJson`** — returns a typed `Result`, no throws.
- **`new Date(string)` → `parseIsoDateTime`** — strict ISO-8601 only,
  no permissive coercion.
- **`Number(x)` → `parseNumber`** — rejects `""`, `" "`, `"NaN"`.
- **`parseInt` / `parseFloat` → `parseNumber`** — same rules.

If `@wellmade/bedrock` is **not** installed, the rules above don't
apply — use the native versions but be aware of their quirks.

## Testing

- **Use Vitest** unless the project explicitly uses Jest. Test files
  are `*.test.ts` next to the source they cover, or under `__tests__/`.
- **Test behavior, not implementation.** A test that breaks when an
  internal function is renamed is testing the wrong thing.
- **No mocked databases in integration tests.** Mock-passing prod-failing
  tests are worse than no tests.

## Deviating from a Wellmade baseline

Sometimes a Wellmade lint, TypeScript, or Prettier rule isn't
sustainable on this project *right now*. Sometimes a `@wellmade/*`
package can't be installed (peer-dep mismatch, project-specific
choice). Both happen on brownfield adoption — that's allowed. But a
silent deviation becomes a permanent regression nobody remembers to fix.

**Don't edit `eslint.config.js` / `tsconfig.json` directly to disable a
Wellmade rule, and don't silently skip a `@wellmade/*` package.** Use
the [`record-deviation`](https://github.com/wellmade-studio/atelier-ai/tree/main/skills/record-deviation)
skill instead. It records the deviation in `.wellmade/deviations.md`
with a `why` and a `revisit-when`, so the debt is tracked and revisitable.

```bash
# Disable an ESLint rule with a documented reason
record-deviation no-explicit-any \
  --why "143 usages in services/api need Mongoose typing first" \
  --revisit-when "after migration to @wellmade/bedrock parsers"

# Skip a @wellmade/* package
record-deviation @wellmade/lint-staged-config \
  --why "peer-dep mismatch with lint-staged@16; inline config works fine" \
  --revisit-when "after standards-js v0.2.0 widens the peer-dep range"

# Flip a tsconfig strictness flag
record-deviation tsconfig.verbatimModuleSyntax \
  --why "Nest CJS scaffold; ESM migration scheduled" \
  --revisit-when "2026-Q3"
```

For inline single-line disables (`// eslint-disable-next-line foo`),
no register entry is needed — those don't shift the baseline.

Run [`audit-deviations`](https://github.com/wellmade-studio/atelier-ai/tree/main/skills/audit-deviations)
periodically (e.g. quarterly) to see whether any entries can now be
removed, or whether the project has drifted (deviations in the configs
that aren't in the register).

After a `standards-js` release widens a peer-dep range, run
[`bump-packages`](https://github.com/wellmade-studio/atelier-ai/tree/main/skills/bump-packages)
to bump all `@wellmade/*` packages across the monorepo in lockstep —
it also re-runs the audit afterward to surface package deviations
that may now be resolvable.

## Commits and PRs

- **Conventional Commits**: `feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`, `test:`, `ci:`. Scope optional.
- **One concern per commit.** Drive-by formatting changes go in a
  separate commit so reviewers can see the real diff.
- **No "WIP" or "fix tests" commits on `main`.** Squash before
  merging if your local history is messy.

## Project structure

- Source in `src/`. Build output in `dist/` (gitignored).
- Public exports declared in `package.json#exports`, not by file
  convention.
- Don't add `index.ts` barrel files unless they're the public entry
  point — barrels hurt tree-shaking and slow down ESLint.

## What this project ships

<!-- Customize this section per project. The rest of the file is
     auto-maintained by atelier-ai. -->

(describe what this service/app/library does, who runs it, and where
it's deployed)

<!-- atelier-ai:wellmade-conventions:end -->
