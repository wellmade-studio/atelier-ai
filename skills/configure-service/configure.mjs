#!/usr/bin/env node
// configure-service: detect the stack of the project in cwd and wire up
// the @wellmade/* lint/format/TS configs end-to-end.
//
// Usage:
//   node configure.mjs                  # detect + prompt + apply
//   node configure.mjs --dry-run        # print what it would do, no writes
//   node configure.mjs --yes            # skip the confirmation prompts; auto-backs-up conflicts
//   node configure.mjs --stack=nestjs   # force a stack, skip detection
//   node configure.mjs --with-hooks     # also install commitlint + lint-staged + husky
//   node configure.mjs --verify=smoke   # verify tool *wiring* only (one-file lint), not full repo
//   node configure.mjs --verify=full    # default: run typecheck + lint + format:check on full repo
//   node configure.mjs --verify=none    # skip verification entirely
//
// Exit codes:
//   0 success, 1 detection failure, 2 conflict (user declined), 3 verify failed

import { readFileSync, writeFileSync, existsSync, renameSync, statSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ASSUME_YES = argv.includes('--yes');
const WITH_HOOKS = argv.includes('--with-hooks');
const STACK_OVERRIDE = argv.find((a) => a.startsWith('--stack='))?.split('=')[1];
const VERIFY_MODE = argv.find((a) => a.startsWith('--verify='))?.split('=')[1] ?? 'full';
if (!['full', 'smoke', 'none'].includes(VERIFY_MODE)) {
  console.error(`--verify must be one of: full, smoke, none (got: ${VERIFY_MODE})`);
  process.exit(1);
}

const cwd = process.cwd();
const pkgPath = join(cwd, 'package.json');

if (!existsSync(pkgPath)) {
  fail('No package.json in current directory. Run this from a project root.');
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

// ─── Stack detection ────────────────────────────────────────────────────────

function detectStack() {
  if (STACK_OVERRIDE) return STACK_OVERRIDE;

  const isMonorepo =
    Array.isArray(pkg.workspaces) ||
    (pkg.workspaces && typeof pkg.workspaces === 'object') ||
    existsSync(join(cwd, 'pnpm-workspace.yaml')) ||
    existsSync(join(cwd, 'turbo.json'));
  if (isMonorepo) return 'monorepo-root';

  if (deps['@nestjs/core']) return 'nestjs';
  if (deps['next']) return 'nextjs';
  if (deps['astro']) return 'astro';
  if (deps['vite'] && deps['react']) return 'vite-react';
  if (deps['vite']) return 'vite-vanilla';
  if (deps['express'] || deps['fastify'] || deps['hono']) return 'node-api';
  if (pkg.type === 'module' || hasTsFiles()) return 'plain-ts';
  return 'plain-js';
}

function hasTsFiles() {
  try {
    return existsSync(join(cwd, 'tsconfig.json'));
  } catch {
    return false;
  }
}

function hasCssFiles() {
  try {
    const out = execSync(
      `find . -name 'node_modules' -prune -o -type f \\( -name '*.css' -o -name '*.scss' \\) -print -quit`,
      { cwd, encoding: 'utf8' },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function usingTailwind() {
  return (
    !!deps['tailwindcss'] ||
    existsSync(join(cwd, 'tailwind.config.js')) ||
    existsSync(join(cwd, 'tailwind.config.ts')) ||
    existsSync(join(cwd, 'tailwind.config.mjs'))
  );
}

// ─── Plan ────────────────────────────────────────────────────────────────────

// Presets exported by @wellmade/eslint-config today. If you add a new one,
// add it here. Order in the eslint.config.js matches the README's canonical
// layering: base → environment (node/browser) → test runner → framework.
//
// `basePreset(import.meta.dirname)` returns an array and must be spread.
// `astroPreset()` is async and returns an array — also spread.
// `vitePreset` is an array and must be spread. Other presets are objects.

function planFor(stack) {
  const css = hasCssFiles();
  const tailwind = usingTailwind();
  const hasVitest = !!deps['vitest'];
  const hasJest = !!deps['jest'] || !!deps['@types/jest'];

  const base = ['@wellmade/eslint-config', '@wellmade/prettier-config', '@wellmade/tsconfig'];

  // presets is a list of { name, kind: 'spread' | 'object' | 'async-spread' }
  // so the file writer knows which import syntax to emit.
  const plan = {
    stack,
    tailwind,
    cssDetected: css,
    install: [...base],
    presets: [{ name: 'basePreset', kind: 'spread' }],
    tsconfigVariant: 'node.json',
    needsStylelint: false,
    writeEslintConfig: true,
    writeStylelintConfig: false,
    writeTsconfig: true,
    notes: [],
  };

  const addTestPreset = () => {
    if (hasVitest) plan.presets.push({ name: 'vitestPreset', kind: 'object' });
    else if (hasJest) plan.presets.push({ name: 'jestPreset', kind: 'object' });
  };

  switch (stack) {
    case 'nestjs':
      plan.presets.push({ name: 'nodePreset', kind: 'object' });
      addTestPreset();
      plan.presets.push({ name: 'nestjsPreset', kind: 'object' });
      plan.notes.push('NestJS detected — keeping tsconfig.build.json untouched.');
      break;
    case 'vite-react':
      plan.tsconfigVariant = 'dom.json';
      plan.presets.push({ name: 'browserPreset', kind: 'object' });
      plan.presets.push({ name: 'reactPreset', kind: 'object' });
      plan.presets.push({ name: 'vitePreset', kind: 'spread' });
      addTestPreset();
      if (css) {
        plan.install.push('@wellmade/stylelint-config');
        plan.needsStylelint = true;
        plan.writeStylelintConfig = true;
      } else {
        plan.notes.push('No CSS files found — skipping stylelint (CSS-in-JS assumed).');
      }
      break;
    case 'astro':
      plan.tsconfigVariant = 'dom.json';
      plan.presets.push({ name: 'browserPreset', kind: 'object' });
      plan.presets.push({ name: 'reactPreset', kind: 'object' });
      plan.presets.push({ name: 'astroPreset', kind: 'async-spread' });
      addTestPreset();
      plan.install.push('@wellmade/stylelint-config');
      plan.needsStylelint = true;
      plan.writeStylelintConfig = true;
      break;
    case 'vite-vanilla':
      plan.tsconfigVariant = 'dom.json';
      plan.presets.push({ name: 'browserPreset', kind: 'object' });
      plan.presets.push({ name: 'vitePreset', kind: 'spread' });
      addTestPreset();
      break;
    case 'nextjs':
      // No Next-specific Wellmade preset (yet). Treat like a browser-side
      // React app; Next's bundler-specific rules are out of scope.
      plan.tsconfigVariant = 'dom.json';
      plan.presets.push({ name: 'browserPreset', kind: 'object' });
      plan.presets.push({ name: 'reactPreset', kind: 'object' });
      addTestPreset();
      plan.notes.push(
        'Next.js: no @wellmade/* Next-specific preset exists. Using base + browser + react. Add Next-specific rules manually if needed.',
      );
      if (deps['eslint-config-next']) {
        plan.notes.push(
          'eslint-config-next is installed — incompatible with flat config. Recommend uninstalling.',
        );
      }
      if (css) {
        plan.install.push('@wellmade/stylelint-config');
        plan.needsStylelint = true;
        plan.writeStylelintConfig = true;
      }
      break;
    case 'node-api':
    case 'plain-ts':
    case 'plain-js':
      plan.presets.push({ name: 'nodePreset', kind: 'object' });
      addTestPreset();
      break;
    case 'monorepo-root':
      plan.install = [
        '@wellmade/prettier-config',
        '@wellmade/tsconfig',
        '@wellmade/commitlint-config',
      ];
      plan.tsconfigVariant = 'base.json';
      plan.writeEslintConfig = false;
      plan.notes.push(
        'Monorepo root: writing prettier + tsconfig base only. Re-run this skill inside each workspace package for framework-specific configs.',
      );
      break;
    default:
      fail(`Unknown stack: ${stack}`);
  }

  return plan;
}

// ─── Conflict detection ─────────────────────────────────────────────────────
//
// Conflicts split into two kinds:
//   - file conflicts: real files we'll back up to .bak before our write wins
//   - inline conflicts: existing values inside package.json we'll just overwrite
// Both get reported in the plan; only file conflicts move through backupConflicts.

function detectConflicts(plan) {
  const fileConflicts = [];
  const inlineConflicts = [];

  // Legacy ESLint configs (RC era).
  const legacyEslint = [
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yaml',
    '.eslintrc.yml',
  ];
  for (const f of legacyEslint) {
    if (existsSync(join(cwd, f))) fileConflicts.push(f);
  }

  // Flat-config siblings — extensions ESLint resolves *before* eslint.config.js.
  // We always write eslint.config.js, so any sibling needs to move or the wrong
  // one wins. Order here is informational; we back them all up.
  const flatEslintSiblings = ['eslint.config.cjs', 'eslint.config.mjs', 'eslint.config.ts'];
  if (plan.writeEslintConfig) {
    for (const f of flatEslintSiblings) {
      if (existsSync(join(cwd, f))) fileConflicts.push(f);
    }
    if (existsSync(join(cwd, 'eslint.config.js'))) fileConflicts.push('eslint.config.js');
  }

  // Prettier RC files (any form). package.json#prettier wins, so all of these
  // become silent losers — back them up to make the winner explicit.
  const legacyPrettier = [
    '.prettierrc',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.mjs',
    '.prettierrc.json',
    '.prettierrc.yaml',
    '.prettierrc.yml',
    '.prettierrc.toml',
    'prettier.config.js',
    'prettier.config.cjs',
    'prettier.config.mjs',
  ];
  for (const f of legacyPrettier) {
    if (existsSync(join(cwd, f))) fileConflicts.push(f);
  }
  if (pkg.prettier && pkg.prettier !== '@wellmade/prettier-config' && pkg.prettier !== '@wellmade/prettier-config/tailwind') {
    inlineConflicts.push(`package.json#prettier (existing: ${JSON.stringify(pkg.prettier)} → will overwrite)`);
  }

  // tsconfig is opt-in — only flag it if we'd actually overwrite something
  // non-Wellmade.
  if (plan.writeTsconfig && existsSync(join(cwd, 'tsconfig.json'))) {
    try {
      const existing = JSON.parse(readFileSync(join(cwd, 'tsconfig.json'), 'utf8'));
      const ext = typeof existing.extends === 'string' ? existing.extends : '';
      if (!ext.startsWith('@wellmade/tsconfig')) {
        fileConflicts.push('tsconfig.json');
      }
    } catch {
      // Malformed tsconfig — back it up rather than guess.
      fileConflicts.push('tsconfig.json');
    }
  }

  return { fileConflicts, inlineConflicts };
}

// Stale-script detection: scripts that point at paths we're about to deprecate
// (legacy .eslintrc.*, sibling eslint.config.cjs, etc.).
function detectStaleScripts(scripts, fileConflicts) {
  const stale = [];
  const deprecatedNeedles = [
    '.eslintrc',
    'eslint.config.cjs',
    'eslint.config.mjs',
    'eslint.config.ts',
    '.prettierrc',
  ];
  for (const [name, cmd] of Object.entries(scripts ?? {})) {
    for (const needle of deprecatedNeedles) {
      if (cmd.includes(needle)) {
        stale.push({ name, cmd, needle });
        break;
      }
    }
  }
  return stale;
}

// Detect whether the current cwd is inside an npm/pnpm workspace, returning
// the root path if so. Used to warn that `npm install` from a sub-package
// updates the root lockfile.
function detectWorkspaceRoot() {
  let dir = cwd;
  while (true) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    const parentPkgPath = join(parent, 'package.json');
    if (existsSync(parentPkgPath)) {
      try {
        const parentPkg = JSON.parse(readFileSync(parentPkgPath, 'utf8'));
        const ws = parentPkg.workspaces;
        const wsList = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : null;
        if (wsList) return parent;
      } catch { /* fall through */ }
    }
    if (existsSync(join(parent, 'pnpm-workspace.yaml'))) return parent;
    dir = parent;
  }
}

// ─── File writers ───────────────────────────────────────────────────────────

function eslintConfigContents(presets) {
  const names = presets.map((p) => p.name).join(', ');
  const hasAsync = presets.some((p) => p.kind === 'async-spread');
  const usage = presets
    .map((p) => {
      switch (p.kind) {
        case 'spread':
          return p.name === 'basePreset'
            ? '...basePreset(import.meta.dirname)'
            : `...${p.name}`;
        case 'async-spread':
          return `...(await ${p.name}())`;
        case 'object':
          return p.name;
        default:
          return p.name;
      }
    })
    .join(',\n  ');

  // Async presets force the default export to be async-evaluated.
  // ESLint supports a top-level async config since 9.x, but we use the
  // explicit-array form for clarity.
  if (hasAsync) {
    return `import { ${names} } from '@wellmade/eslint-config';

export default [
  ${usage},
];
`;
  }
  return `import { ${names} } from '@wellmade/eslint-config';

export default [
  ${usage},
];
`;
}

function tsconfigContents(variant) {
  return JSON.stringify(
    {
      extends: `@wellmade/tsconfig/${variant}`,
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  ) + '\n';
}

function stylelintConfigContents(tailwind) {
  const extendsTarget = tailwind ? '@wellmade/stylelint-config/tailwind' : '@wellmade/stylelint-config';
  return `export default {
  extends: ['${extendsTarget}'],
};
`;
}

const SCRIPTS = {
  lint: 'eslint .',
  'lint:fix': 'eslint . --fix',
  format: 'prettier --write .',
  'format:check': 'prettier --check .',
  typecheck: 'tsc --noEmit',
};

// ─── Apply ──────────────────────────────────────────────────────────────────

// Events accumulator — drives the end-of-run summary and decides whether
// to prompt for agent feedback. Anything noteworthy gets recorded here.
const events = {
  backedUp: [],           // files moved to .bak
  inlineOverwrites: [],   // package.json values we silently overwrote
  staleScripts: [],       // detected stale scripts (kept or replaced)
  preservedScripts: [],   // user scripts left untouched
  workspaceRoot: null,    // path to detected workspace root (if any)
  hooksOffered: false,
  hooksInstalled: false,
  hooksSkipped: false,
  verifyFailedAt: null,
  verifyMode: VERIFY_MODE,
  nestVerbatimWarning: false,
};

async function main() {
  const stack = detectStack();
  const plan = planFor(stack);
  const { fileConflicts, inlineConflicts } = detectConflicts(plan);
  const fresh = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const staleScripts = detectStaleScripts(fresh.scripts, fileConflicts);
  events.workspaceRoot = detectWorkspaceRoot();
  events.staleScripts = staleScripts;
  events.inlineOverwrites = inlineConflicts;

  // Nest + verbatimModuleSyntax warning — flagged early so it appears in
  // both the plan and the post-install summary.
  if (stack === 'nestjs' && (!pkg.type || pkg.type !== 'module')) {
    events.nestVerbatimWarning = true;
    plan.notes.push(
      'NestJS + @wellmade/tsconfig/node.json enables `verbatimModuleSyntax`. Nest scaffolds without "type": "module" in package.json, which is the biggest source of friction on this stack. If you hit "Cannot use import statement outside a module" errors, either add `"type": "module"` or override `compilerOptions.verbatimModuleSyntax: false` in tsconfig.json.',
    );
  }

  printPlan(plan, fileConflicts, inlineConflicts, staleScripts);

  if (DRY_RUN) {
    console.log('\n(--dry-run) No changes made.');
    return;
  }

  // Conflict handling — runs under --yes too. Previously skipped, which
  // meant the script wrote new configs alongside the old ones.
  if (fileConflicts.length > 0) {
    if (ASSUME_YES) {
      console.log('\nBacking up conflicting files (--yes):');
    } else {
      const answer = await ask(
        '\nConflicting files exist. (b)ack up and replace / (a)bort? [a] ',
      );
      if (answer.toLowerCase() !== 'b') {
        console.log('Aborted. No changes made.');
        process.exit(2);
      }
    }
    backupConflicts(fileConflicts);
  }

  // Stale-script handling — prompt to replace, or note it for the summary
  // under --yes.
  if (staleScripts.length > 0 && !ASSUME_YES) {
    console.log('\nStale scripts detected (reference paths this skill is deprecating):');
    for (const s of staleScripts) {
      console.log(`  ! ${s.name}: "${s.cmd}" (mentions ${s.needle})`);
    }
    const answer = await ask('(r)eplace with Wellmade defaults / (k)eep as-is? [k] ');
    if (answer.toLowerCase() === 'r') {
      events.staleScripts = staleScripts.map((s) => ({ ...s, replaced: true }));
    }
  }

  if (!ASSUME_YES) {
    const answer = await ask('\nProceed with install + write? [y/N] ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted. No changes made.');
      process.exit(2);
    }
  }

  installPackages(plan.install);
  writeConfigs(plan);
  mergeScripts(plan);

  // Hooks (commitlint + lint-staged + husky) — installed only when
  // explicitly requested via --with-hooks, but always reported.
  if (WITH_HOOKS) {
    events.hooksOffered = true;
    events.hooksInstalled = installCommitHooks();
  } else {
    events.hooksSkipped = true;
  }

  const ok = verify(plan);
  if (!ok) {
    events.verifyFailedAt = events.verifyFailedAt ?? 'unknown';
    printSummary(plan);
    process.exit(3);
  }

  printSummary(plan);

  // Agent-feedback prompt — only fires when something notable happened
  // that the skill owner would want to know about.
  await maybePromptForFeedback(plan);
}

function printPlan(plan, fileConflicts, inlineConflicts, staleScripts) {
  console.log(`\nDetected stack: ${plan.stack}`);
  if (plan.cssDetected) console.log('  CSS files detected.');
  if (plan.tailwind) console.log('  Tailwind detected — will use Tailwind variant.');
  if (events.workspaceRoot) {
    console.log(`  npm workspace detected — root at ${events.workspaceRoot}.`);
    console.log('  Heads up: npm install from a sub-package updates the root package-lock.json and node_modules/.');
  }
  console.log(`\nWill install (${plan.install.length} packages):`);
  for (const p of plan.install) console.log(`  • ${p}`);
  console.log('\nWill write:');
  if (plan.writeEslintConfig) console.log(`  • eslint.config.js  (${plan.presets.map((p) => p.name).join(' + ')})`);
  if (plan.writeTsconfig) console.log(`  • tsconfig.json     (extends @wellmade/tsconfig/${plan.tsconfigVariant})`);
  if (plan.writeStylelintConfig) console.log('  • stylelint.config.js');
  console.log('  • package.json (prettier field + scripts)');
  if (fileConflicts.length > 0) {
    console.log('\nFile conflicts (will back up to .bak):');
    for (const c of fileConflicts) console.log(`  ! ${c}`);
  }
  if (inlineConflicts.length > 0) {
    console.log('\nInline conflicts (will overwrite — no backup possible):');
    for (const c of inlineConflicts) console.log(`  ! ${c}`);
  }
  if (staleScripts.length > 0) {
    console.log('\nStale scripts detected:');
    for (const s of staleScripts) console.log(`  ! ${s.name} references ${s.needle}`);
  }
  if (plan.notes.length > 0) {
    console.log('\nNotes:');
    for (const n of plan.notes) console.log(`  - ${n}`);
  }
  if (!WITH_HOOKS) {
    console.log('\nHooks (commitlint + lint-staged + husky): not installed. Pass --with-hooks to enable.');
  }
}

function backupConflicts(conflicts) {
  for (const c of conflicts) {
    const from = join(cwd, c);
    const to = `${from}.bak`;
    if (!existsSync(from)) continue; // already gone
    if (existsSync(to)) {
      // Pick a free .bakN slot so we never silently fail to back something up.
      let i = 2;
      while (existsSync(`${from}.bak${i}`)) i++;
      const fallback = `${from}.bak${i}`;
      renameSync(from, fallback);
      console.log(`  → backed up ${c} → ${c}.bak${i} (.bak already existed)`);
      events.backedUp.push(`${c}.bak${i}`);
      continue;
    }
    renameSync(from, to);
    console.log(`  → backed up ${c} → ${c}.bak`);
    events.backedUp.push(`${c}.bak`);
  }
}

function installPackages(packages) {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) {
    fail('pnpm-lock.yaml detected. This script only supports npm. Run manually with pnpm.');
  }
  if (existsSync(join(cwd, 'yarn.lock'))) {
    fail('yarn.lock detected. This script only supports npm. Run manually with yarn.');
  }
  console.log(`\nInstalling ${packages.length} packages…`);
  execSync(`npm install --save-dev ${packages.join(' ')}`, { cwd, stdio: 'inherit' });
}

function writeConfigs(plan) {
  if (plan.writeEslintConfig) {
    writeFileSync(join(cwd, 'eslint.config.js'), eslintConfigContents(plan.presets));
    console.log('  ✓ eslint.config.js');
  }
  if (plan.writeTsconfig) {
    writeFileSync(join(cwd, 'tsconfig.json'), tsconfigContents(plan.tsconfigVariant));
    console.log('  ✓ tsconfig.json');
  }
  if (plan.writeStylelintConfig) {
    writeFileSync(join(cwd, 'stylelint.config.js'), stylelintConfigContents(plan.tailwind));
    console.log('  ✓ stylelint.config.js');
  }
  // package.json#prettier — single source of truth. Any sibling
  // .prettierrc/* files were already backed up in backupConflicts.
  const fresh = JSON.parse(readFileSync(pkgPath, 'utf8'));
  fresh.prettier = plan.tailwind ? '@wellmade/prettier-config/tailwind' : '@wellmade/prettier-config';
  writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + '\n');
  console.log('  ✓ package.json#prettier');
}

function mergeScripts(plan) {
  const fresh = JSON.parse(readFileSync(pkgPath, 'utf8'));
  fresh.scripts = fresh.scripts || {};
  const desired = { ...SCRIPTS };
  if (plan.needsStylelint) desired.stylelint = 'stylelint "**/*.{css,scss}"';
  const added = [];
  const replaced = [];
  const preserved = [];
  const staleByName = new Map(events.staleScripts.map((s) => [s.name, s]));
  for (const [name, cmd] of Object.entries(desired)) {
    const existing = fresh.scripts[name];
    if (!existing) {
      fresh.scripts[name] = cmd;
      added.push(name);
      continue;
    }
    const stale = staleByName.get(name);
    if (stale?.replaced) {
      fresh.scripts[name] = cmd;
      replaced.push(`${name} (was: "${existing}")`);
      continue;
    }
    preserved.push(`${name} (existing: "${existing}", suggested: "${cmd}")`);
  }
  writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + '\n');
  if (added.length > 0) console.log(`  ✓ scripts added: ${added.join(', ')}`);
  if (replaced.length > 0) {
    console.log('  ↻ scripts replaced (were stale):');
    for (const r of replaced) console.log(`      ${r}`);
  }
  if (preserved.length > 0) {
    console.log('  ! existing scripts preserved (review manually):');
    for (const p of preserved) console.log(`      ${p}`);
  }
  events.preservedScripts = preserved;
}

function installCommitHooks() {
  // Adds @wellmade/commitlint-config + lint-staged + husky and wires them
  // into package.json. Idempotent: skips anything already present.
  const additions = ['@wellmade/commitlint-config', 'lint-staged', 'husky'];
  console.log(`\nInstalling commit hooks: ${additions.join(', ')}`);
  try {
    execSync(`npm install --save-dev ${additions.join(' ')}`, { cwd, stdio: 'inherit' });
  } catch {
    console.warn('  ! npm install for hook packages failed — skipping hook wiring.');
    return false;
  }
  const fresh = JSON.parse(readFileSync(pkgPath, 'utf8'));
  fresh.scripts ??= {};
  fresh.scripts.prepare ??= 'husky';
  fresh['lint-staged'] ??= {
    '*.{js,jsx,ts,tsx,mjs,cjs}': ['eslint --fix', 'prettier --write'],
    '*.{json,md,yml,yaml,css,scss,html}': ['prettier --write'],
  };
  writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + '\n');
  console.log('  ✓ scripts.prepare = "husky"');
  console.log('  ✓ package.json#lint-staged populated');
  console.log('  Run `npx husky init` (or wire .husky/pre-commit yourself) to finish.');
  return true;
}

// --verify=smoke: lint/format a temp file using the installed configs.
// Confirms the toolchain is wired correctly without surfacing every
// brownfield violation. --verify=full: original behavior, run on full repo.
// --verify=none: skip entirely.
function verify(plan) {
  if (VERIFY_MODE === 'none') {
    console.log('\nVerification skipped (--verify=none).');
    return true;
  }
  if (VERIFY_MODE === 'smoke') return verifySmoke(plan);
  return verifyFull(plan);
}

function verifyFull(plan) {
  const checks = [
    ['typecheck', 'npm run typecheck'],
    ['lint', 'npm run lint'],
    ['format:check', 'npm run format:check'],
  ];
  if (plan.needsStylelint) checks.push(['stylelint', 'npm run stylelint']);

  console.log('\nVerifying (full repo)…');
  for (const [name, cmd] of checks) {
    try {
      execSync(cmd, { cwd, stdio: 'pipe' });
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.log(`  ✗ ${name} failed`);
      console.log(String(err.stdout || '').split('\n').slice(0, 20).join('\n'));
      console.log(
        `\nVerification stopped at "${name}". This is expected on brownfield repos; the toolchain is installed correctly, but existing code doesn't yet comply.`,
      );
      console.log('Try one of:');
      console.log('  • `npm run lint:fix` and `npm run format` to auto-fix what can be auto-fixed');
      console.log('  • `--verify=smoke` to confirm only that the toolchain is wired correctly');
      console.log('  • `--verify=none` to skip verification entirely');
      events.verifyFailedAt = name;
      return false;
    }
  }
  return true;
}

function verifySmoke(plan) {
  console.log('\nVerifying (smoke test — tool wiring only)…');
  const tmp = mkdtempSync(join(tmpdir(), 'wellmade-smoke-'));
  try {
    // Write a deliberately ugly file in the project so the installed
    // configs apply (they may parse from the project's tsconfig path).
    const probeRel = '.wellmade-smoke-probe.ts';
    const probe = join(cwd, probeRel);
    writeFileSync(probe, "const  x =  'hello';\nconsole.log(x);\n");
    const checks = [
      ['eslint', `npx --no-install eslint --no-error-on-unmatched-pattern ${probeRel}`],
      ['prettier', `npx --no-install prettier --check ${probeRel}`],
    ];
    for (const [name, cmd] of checks) {
      try {
        execSync(cmd, { cwd, stdio: 'pipe' });
        // Smoke test passes when the tool exits 0 *or* reports the
        // expected diagnostic. We don't care about the verdict on the
        // probe file; we care that the tool ran without a config error.
        console.log(`  ✓ ${name} ran`);
      } catch (err) {
        const out = String(err.stdout || '') + String(err.stderr || '');
        // ESLint reports failures with exit 1 (lint errors) or exit 2
        // (config errors). Prettier returns 1 for "would reformat", 2
        // for "had errors trying to parse", 3 for config issues. We
        // care only about config failures — pattern-match the output.
        const configError = /Cannot find|Failed to load|missing|no such file|Couldn't resolve|Error \[/i.test(out);
        if (configError) {
          console.log(`  ✗ ${name} failed (config error)`);
          console.log(out.split('\n').slice(0, 15).join('\n'));
          events.verifyFailedAt = name;
          return false;
        }
        console.log(`  ✓ ${name} ran (reported lint/format violations on probe — expected)`);
      }
    }
    // Try `tsc --noEmit` only if we have a tsconfig; smoke means: does
    // tsc parse our config?
    if (existsSync(join(cwd, 'tsconfig.json'))) {
      try {
        execSync('npx --no-install tsc --noEmit --pretty false', { cwd, stdio: 'pipe' });
        console.log('  ✓ tsc ran');
      } catch (err) {
        const out = String(err.stdout || '') + String(err.stderr || '');
        if (/error TS\d+/i.test(out)) {
          console.log('  ✓ tsc ran (reported type errors on existing code — expected on brownfield)');
        } else {
          console.log('  ✗ tsc failed (config error)');
          console.log(out.split('\n').slice(0, 15).join('\n'));
          events.verifyFailedAt = 'tsc';
          return false;
        }
      }
    }
    return true;
  } finally {
    try { rmSync(join(cwd, '.wellmade-smoke-probe.ts')); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function printSummary(plan) {
  console.log('\n─── Summary ─────────────────────────────────');
  console.log(`  Stack: ${plan.stack}`);
  console.log(`  Packages installed: ${plan.install.length}`);
  if (events.backedUp.length > 0) {
    console.log(`  Backed up: ${events.backedUp.join(', ')}`);
  }
  if (events.inlineOverwrites.length > 0) {
    console.log('  Overwrote (no backup possible):');
    for (const c of events.inlineOverwrites) console.log(`    - ${c}`);
  }
  if (events.preservedScripts.length > 0) {
    console.log(`  Preserved ${events.preservedScripts.length} existing script(s) — review manually.`);
  }
  if (events.workspaceRoot) {
    console.log(`  npm workspace root: ${events.workspaceRoot} (lockfile updates happen there)`);
  }
  if (events.hooksInstalled) {
    console.log('  Hooks installed: commitlint + lint-staged + husky (run `npx husky init` to finish)');
  } else if (events.hooksSkipped) {
    console.log('  Hooks NOT installed (commitlint / lint-staged / husky). Re-run with `--with-hooks` to enable.');
  }
  if (events.nestVerbatimWarning) {
    console.log('  ⚠ NestJS + verbatimModuleSyntax — see plan notes above if you hit ESM errors.');
  }
  if (events.verifyFailedAt) {
    console.log(`  ✗ Verification failed at: ${events.verifyFailedAt} (mode: ${events.verifyMode})`);
  } else if (events.verifyMode !== 'none') {
    console.log(`  ✓ Verification passed (mode: ${events.verifyMode})`);
  }
  console.log('─────────────────────────────────────────────');
  console.log('\nSuggested next steps:');
  console.log('  • git add -A && git commit -m "chore: wire @wellmade/* configs"');
  console.log('  • Set up editor integration (see standards-js README)');

  // If anything notable happened that the user might want to track as a
  // deviation, point at record-deviation. Brownfield projects almost always
  // hit this — backed-up files mean "we chose to replace what was there"
  // (possibly intentionally, possibly not), preserved scripts mean "we kept
  // a custom version of something we'd normally standardize." Both are the
  // exact shape of a deviation worth tracking.
  const deviationCandidates = [];
  if (events.backedUp.length > 0) {
    deviationCandidates.push(
      `${events.backedUp.length} file(s) backed up — if you'd intentionally diverged from Wellmade defaults there, record those as deviations`,
    );
  }
  if (events.preservedScripts.length > 0) {
    deviationCandidates.push(
      `${events.preservedScripts.length} preserved script(s) — if any are deliberate customizations (not stale), record them so the audit doesn't flag them later`,
    );
  }
  if (events.inlineOverwrites.length > 0) {
    deviationCandidates.push(
      `${events.inlineOverwrites.length} inline value(s) overwritten — if the previous value was a deliberate choice, record it before it's forgotten`,
    );
  }
  if (deviationCandidates.length > 0) {
    console.log('\n  Consider recording deviations for non-default choices:');
    for (const c of deviationCandidates) console.log(`    • ${c}`);
    console.log('    Use the `record-deviation` skill (each entry takes --why and --revisit-when).');
  }
}

// Returns the list of notable signals for the skill owner. Empty list
// means the run was boring; no need to ask the agent for feedback.
function notableSignals() {
  const signals = [];
  if (events.backedUp.length > 0) signals.push(`backed up ${events.backedUp.length} file(s)`);
  if (events.inlineOverwrites.length > 0) signals.push(`overwrote ${events.inlineOverwrites.length} inline value(s)`);
  if (events.preservedScripts.length > 0) signals.push(`preserved ${events.preservedScripts.length} script(s) — possibly stale`);
  if (events.workspaceRoot) signals.push('ran inside an npm workspace sub-package');
  if (events.verifyFailedAt) signals.push(`verification failed at ${events.verifyFailedAt} (mode: ${events.verifyMode})`);
  if (events.nestVerbatimWarning) signals.push('NestJS + verbatimModuleSyntax warning surfaced');
  if (events.hooksSkipped && !ASSUME_YES) signals.push('hooks were not installed (no --with-hooks)');
  return signals;
}

// Surface a feedback prompt to the agent when something non-routine
// happened during the run. Skipped when the run was uneventful so we
// don't train agents to spam the skill owner.
async function maybePromptForFeedback(plan) {
  const signals = notableSignals();
  if (signals.length === 0) return;

  console.log('\n─── Skill feedback (atelier-ai) ─────────────');
  console.log('This run hit a few situations the skill owner would want to know about:');
  for (const s of signals) console.log(`  • ${s}`);
  console.log('');
  console.log('If you are an AI coding agent running this skill on behalf of a user, consider');
  console.log('passing a short note back to your user about anything that surprised you or');
  console.log('didn\'t match the skill description. Feedback flows to:');
  console.log('  https://github.com/wellmade-studio/atelier-ai/issues');
  console.log('Useful signal: stack name, what was expected vs what happened, log lines.');
  console.log('─────────────────────────────────────────────');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function ask(prompt) {
  const rl = createInterface({ input, output });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim();
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
