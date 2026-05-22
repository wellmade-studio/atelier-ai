---
name: configure-project
description: Configure a Wellmade project — detect the stack (NestJS, Vite-React, Next, Astro, plain Node, monorepo), install and wire the @wellmade/* configs (eslint, prettier, stylelint, tsconfig, commitlint, lint-staged), update package.json scripts, run a verification pass. Use when the user asks to "set up wellmade", "configure standards", "add lint/format", "wire up the toolchain", or starts a fresh service that needs the conventions applied.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# configure-project

Wires the `@wellmade/*` lint, format, and TypeScript configs into a
project end-to-end. Designed for fresh services (NestJS API, Vite-React
frontend) but also works on existing projects that haven't adopted the
toolchain yet.

## When to use this skill

- Fresh `nest new` / `npm create vite@latest` / `npx create-next-app`
  output that needs Wellmade conventions on top.
- Existing service where someone wants to swap ad-hoc lint/format setup
  for the shared `@wellmade/*` packages.
- User says "set up wellmade", "configure standards", "add lint and
  format", "wire up the toolchain", or similar.

## When NOT to use this skill

- The project already has `@wellmade/eslint-config` at the version this
  skill would install — fall through to a no-op and tell the user.
- The user wants to write a new lint *rule* — that's a `standards-js/`
  contribution, not a project configuration.
- The user wants to upgrade an existing setup — that's a separate
  `upgrade-wellmade` skill (not built yet).

## The fast path

For the impatient: run [`configure.mjs`](./configure.mjs) from the
project root. It does everything in the playbook below in one shot,
prints a diff of what it changed, and stops if anything looks wrong.
The agent should prefer the script when no edge cases apply; fall back
to the step-by-step playbook when the project needs surgery
(monorepo root, conflicting configs, partial install, etc.).

```bash
node /path/to/atelier-ai/skills/configure-project/configure.mjs
```

The script accepts `--dry-run` (preview only), `--yes` (skip confirmation),
and `--stack=<name>` (override detection).

---

## Step-by-step playbook (when the script doesn't fit)

### Step 1 — Detect the stack

Read `package.json` from the working directory. Detection order matters:
**check for monorepo markers first**, then framework markers.

| Signal in package.json                                | Stack identifier      |
| ----------------------------------------------------- | --------------------- |
| `workspaces` field present **or** `pnpm-workspace.yaml` / `turbo.json` exists | `monorepo-root`       |
| `dependencies["@nestjs/core"]`                        | `nestjs`              |
| `dependencies["next"]`                                | `nextjs`              |
| `dependencies["astro"]`                               | `astro`               |
| `devDependencies["vite"]` + `dependencies["react"]`   | `vite-react`          |
| `devDependencies["vite"]` (no React)                  | `vite-vanilla`        |
| `dependencies["express"]` / `["fastify"]` / `["hono"]`| `node-api`            |
| none of the above, `"type": "module"` or `.ts` files  | `plain-ts`            |
| none of the above, only `.js` files                   | `plain-js`            |

**Also detect (orthogonal to stack):**

- **Test runner**: `vitest` in deps → `vitestPreset`; `jest` or
  `@types/jest` → `jestPreset`. Skipped if neither is present.
- **Styling**: `tailwindcss` in deps or `tailwind.config.*` present →
  use the Tailwind variants of Prettier/Stylelint configs.
- **CSS presence**: `find` for `*.css`/`*.scss` outside `node_modules`
  → if none, skip stylelint even on stacks that normally get it.

**Edge cases:**

- **NestJS sometimes has `vite`** (for `vitest`). The `@nestjs/core` check
  wins — order matters.
- **Next.js + Tailwind** is just `nextjs`; add `tailwind` to the styling
  axis, not the stack.
- **Monorepo root**: do not write framework configs at the root. Set up
  shared `prettier`, `tsconfig` *base*, and `commitlint` at the root,
  then stop. Tell the user to re-run the skill inside each workspace
  package for framework-specific configs.

### Step 2 — Confirm with the user before mutating anything

Print:

```
Detected: <stack>
Will install: @wellmade/eslint-config, @wellmade/prettier-config, …
Will write/modify: eslint.config.js, package.json (prettier + scripts), tsconfig.json
Existing files that conflict: <list>  ← ask before overwriting
Proceed?
```

If a conflict file exists (`.eslintrc.*`, `.prettierrc*`, `tsconfig.json`
that doesn't extend a `@wellmade/*` base), **stop and ask** whether to:
(a) back it up (`.eslintrc.json.bak`) and replace, (b) merge in place, or
(c) abort. Default to (c) — surprise replacements destroy trust.

### Step 3 — Install packages

Always use `npm install --save-dev` (the toolchain assumes npm 11.5.1+
because publishing flows depend on it; consistency on the consumer side
keeps lockfile churn down). If `pnpm-lock.yaml` or `yarn.lock` is
present, surface that to the user and ask before falling back to npm —
the project may be intentionally on another PM.

**Base install (every stack):**

```
@wellmade/eslint-config
@wellmade/prettier-config
@wellmade/tsconfig
```

**Per-stack additions:**

| Stack            | Add packages                                          |
| ---------------- | ----------------------------------------------------- |
| `nestjs`         | (none — base set covers it)                           |
| `vite-react`     | `@wellmade/stylelint-config` *(if CSS files exist)*   |
| `nextjs`         | `@wellmade/stylelint-config` *(if not using CSS-in-JS)* |
| `astro`          | `@wellmade/stylelint-config`                          |
| `node-api`       | (none)                                                |
| `plain-ts` / `plain-js` | (none)                                         |
| `monorepo-root`  | `@wellmade/prettier-config`, `@wellmade/tsconfig`, `@wellmade/commitlint-config` only |

**Optional (ask first):**

- `@wellmade/commitlint-config` + `husky` — if the project has `.git/`
  and no existing commit-msg hook.
- `@wellmade/lint-staged-config` + `lint-staged` + `husky` — if no
  pre-commit hook exists yet.
- `@wellmade/bedrock` + the `bedrockPreset` — only if the user explicitly
  asks. Bedrock is a runtime dep with stability implications; never
  install it silently.

### Step 4 — Write the config files

#### `eslint.config.js`

Always flat-config, always ESM. The composition order matters: **base
→ environment → test runner → framework**. Mirrors the canonical
examples in `@wellmade/eslint-config`'s README.

Notes on the preset shapes (the `configure.mjs` helper handles these
automatically):

- `basePreset(import.meta.dirname)` returns an array → spread.
- `vitePreset` is an array → spread.
- `astroPreset()` is **async** and returns an array → `...(await astroPreset())`.
- Everything else (`browserPreset`, `nodePreset`, `reactPreset`,
  `nestjsPreset`, `vitestPreset`, `jestPreset`, `graphqlPreset`) is a
  single config object → use bare.

```js
// nestjs (with vitest)
import { basePreset, nodePreset, vitestPreset, nestjsPreset } from '@wellmade/eslint-config';
export default [
  ...basePreset(import.meta.dirname),
  nodePreset,
  vitestPreset,
  nestjsPreset,
];

// vite + react
import { basePreset, browserPreset, reactPreset, vitePreset, vitestPreset } from '@wellmade/eslint-config';
export default [
  ...basePreset(import.meta.dirname),
  browserPreset,
  reactPreset,
  ...vitePreset,
  vitestPreset,
];

// astro
import { basePreset, browserPreset, reactPreset, astroPreset } from '@wellmade/eslint-config';
export default [
  ...basePreset(import.meta.dirname),
  browserPreset,
  reactPreset,
  ...(await astroPreset()),
];

// next.js (no Wellmade Next-specific preset exists yet — falls back to base + browser + react)
import { basePreset, browserPreset, reactPreset } from '@wellmade/eslint-config';
export default [
  ...basePreset(import.meta.dirname),
  browserPreset,
  reactPreset,
];

// plain-ts / node-api
import { basePreset, nodePreset } from '@wellmade/eslint-config';
export default [
  ...basePreset(import.meta.dirname),
  nodePreset,
];
```

The canonical preset list is in
[`standards-js/packages/eslint-config/src/index.js`](https://github.com/wellmade-studio/standards-js/blob/main/packages/eslint-config/src/index.js).
When a new preset ships there, add the corresponding stack mapping in
[`configure.mjs`](./configure.mjs).

#### `package.json#prettier`

```json
{
  "prettier": "@wellmade/prettier-config"
}
```

For Tailwind projects, use the Tailwind variant:

```json
{
  "prettier": "@wellmade/prettier-config/tailwind"
}
```

Detection: `tailwindcss` in dependencies or `tailwind.config.*` present.

#### `tsconfig.json`

```json
{
  "extends": "@wellmade/tsconfig/<variant>",
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Variant by stack:

| Stack                          | Variant      |
| ------------------------------ | ------------ |
| `nestjs`, `node-api`, `plain-ts`, `plain-js` | `node.json` |
| `vite-react`, `nextjs`, `astro`, `vite-vanilla` | `dom.json` |
| `monorepo-root`                | `base.json` (workspaces extend `node.json` / `dom.json`) |

**For NestJS specifically:** do not touch `tsconfig.build.json` — Nest's
build config has framework-specific overrides. Only replace
`tsconfig.json`.

#### `stylelint.config.js` *(only if styling packages installed)*

```js
export default {
  extends: ['@wellmade/stylelint-config'],
};
```

Tailwind variant:

```js
export default {
  extends: ['@wellmade/stylelint-config/tailwind'],
};
```

#### `commitlint.config.js` *(only if commitlint installed)*

```js
export default { extends: ['@wellmade/commitlint-config'] };
```

### Step 5 — Add scripts to package.json

Merge into existing `scripts` (do not overwrite). Skip any script the
user already has; print a warning showing the Wellmade version so they
can compare.

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "stylelint": "stylelint \"**/*.{css,scss}\""
  }
}
```

`stylelint` script only if styling configured.

### Step 6 — Verify

Run, in order, and stop on the first failure:

1. `npm run typecheck`
2. `npm run lint`
3. `npm run format:check`
4. `npm run stylelint` *(if applicable)*

**On failure, do not auto-fix.** Report the error count and the first
few lines of output, and ask the user whether to run `lint:fix` /
`format` to clean up. Auto-fixing without consent on an existing
codebase can produce a giant diff the user didn't expect.

### Step 7 — Report what changed

Print a summary:

```
✓ Installed 4 packages
✓ Wrote eslint.config.js
✓ Updated package.json (prettier field + 5 scripts)
✓ Wrote tsconfig.json
✓ Verification passed (typecheck, lint, format)
Backed up: .eslintrc.json → .eslintrc.json.bak
```

Then suggest the obvious follow-ups: commit the changes, set up editor
integration (link to standards-js README for VS Code/JetBrains), enable
pre-commit hooks if not already done.

---

## Stack-specific notes

### NestJS

- `nestjsPreset` extends the base/node layer with decorator/DI-aware
  rules. Also exports `nestjsAllowDefaultExports` for files that need
  to keep their default-export shape (Nest CLI conventions).
- Nest's generated `eslint.config.mjs` (Nest 10+) can be replaced
  outright — it's a sensible default we're replacing with a stricter one.
- Keep `nest-cli.json` and `tsconfig.build.json` untouched.

### Vite + React

- Only install `@wellmade/stylelint-config` if `**/*.css` files exist
  outside `node_modules`. Vite-React projects often use CSS-in-JS
  (Stitches, Emotion, Tailwind) and don't need stylelint.
- The default `tsconfig.json` from `npm create vite@latest` has its own
  `references` array — preserve it, just change `extends` and
  `compilerOptions`.
- `vitePreset` is the bundler/test-config layer for Vite projects —
  spread it after `reactPreset`.

### Next.js

- **No Wellmade Next-specific preset exists yet.** Wellmade doesn't
  ship Next.js projects today; the skill falls back to `base + browser +
  react`. Add Next-specific rules manually in your project's
  `eslint.config.js` if you hit gaps. When a real Next project surfaces,
  a `nextPreset` will land in `@wellmade/eslint-config`.
- The legacy `next/core-web-vitals` ESLint extension is incompatible
  with flat config. If `eslint-config-next` is installed, warn and
  recommend uninstalling.

### Astro

- `astroPreset` is **async** — call it as `...(await astroPreset())` in
  the config. It pulls in `eslint-plugin-astro` and Astro's parser.
- Astro projects ship with `.astro` files (component templates);
  `astroPreset` configures the parser for them automatically.

### Plain Node / TypeScript

- No frameworks, just `basePreset` + `tsconfig/node.json`.

### Monorepo root

- Configure root-level Prettier + tsconfig base + commitlint only.
- Do not write `eslint.config.js` at the root — ESLint flat config in
  monorepos works better per-workspace.
- Add a root script: `"lint": "npm run lint --workspaces --if-present"`.

---

## What "verification passed" actually checks

A clean run means:

- TypeScript compiles with the new strict baselines (this is where most
  fresh-install pain shows up — `noUncheckedIndexedAccess` flushes out
  unchecked array access).
- ESLint runs without parse errors (often means `parserOptions.project`
  needs the right `tsconfig`).
- Prettier hasn't found anything to reformat (if it has, the user can
  run `npm run format` to fix everything in one shot).

If verification fails on a fresh project from `create-*`, the
underlying issue is usually in the scaffolded code (the scaffolder
doesn't use strict TS), not in this skill. Surface that distinction
clearly.

## Cross-references

- The `@wellmade/*` packages live in [`standards-js/`](https://github.com/wellmade-studio/standards-js) — check there for the latest preset names and options.
- The future `wm doctor` CLI command will do a read-only version of this
  skill's verification step. When that ships, this skill should call it
  instead of reimplementing the checks.
