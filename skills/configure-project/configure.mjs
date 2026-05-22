#!/usr/bin/env node
// configure-project: detect the stack of the project in cwd and wire up
// the @wellmade/* lint/format/TS configs end-to-end.
//
// Usage:
//   node configure.mjs                  # detect + prompt + apply
//   node configure.mjs --dry-run        # print what it would do, no writes
//   node configure.mjs --yes            # skip the confirmation prompt
//   node configure.mjs --stack=nestjs   # force a stack, skip detection
//
// Exit codes:
//   0 success, 1 detection failure, 2 conflict (user declined), 3 verify failed

import { readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ASSUME_YES = argv.includes('--yes');
const STACK_OVERRIDE = argv.find((a) => a.startsWith('--stack='))?.split('=')[1];

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

function detectConflicts(plan) {
  const conflicts = [];
  const legacyEslint = [
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yaml',
    '.eslintrc.yml',
  ];
  for (const f of legacyEslint) {
    if (existsSync(join(cwd, f))) conflicts.push(f);
  }
  const legacyPrettier = ['.prettierrc', '.prettierrc.js', '.prettierrc.json', '.prettierrc.yaml'];
  for (const f of legacyPrettier) {
    if (existsSync(join(cwd, f))) conflicts.push(f);
  }
  if (pkg.prettier && pkg.prettier !== '@wellmade/prettier-config') {
    conflicts.push('package.json#prettier (existing value, not @wellmade)');
  }
  if (plan.writeEslintConfig && existsSync(join(cwd, 'eslint.config.js'))) {
    conflicts.push('eslint.config.js');
  }
  return conflicts;
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

async function main() {
  const stack = detectStack();
  const plan = planFor(stack);
  const conflicts = detectConflicts(plan);

  printPlan(plan, conflicts);

  if (DRY_RUN) {
    console.log('\n(--dry-run) No changes made.');
    return;
  }

  if (conflicts.length > 0 && !ASSUME_YES) {
    const answer = await ask(
      'Conflicting files exist. (b)ack up and replace / (a)bort? [a] ',
    );
    if (answer.toLowerCase() !== 'b') {
      console.log('Aborted. No changes made.');
      process.exit(2);
    }
    backupConflicts(conflicts);
  }

  if (!ASSUME_YES) {
    const answer = await ask('Proceed with install + write? [y/N] ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted. No changes made.');
      process.exit(2);
    }
  }

  installPackages(plan.install);
  writeConfigs(plan);
  mergeScripts(plan);
  const ok = verify(plan);
  if (!ok) process.exit(3);

  console.log('\nDone. Suggested next steps:');
  console.log('  • git add -A && git commit -m "chore: wire @wellmade/* configs"');
  console.log('  • Set up editor integration (see standards-js README)');
}

function printPlan(plan, conflicts) {
  console.log(`\nDetected stack: ${plan.stack}`);
  if (plan.cssDetected) console.log('  CSS files detected.');
  if (plan.tailwind) console.log('  Tailwind detected — will use Tailwind variant.');
  console.log(`\nWill install (${plan.install.length} packages):`);
  for (const p of plan.install) console.log(`  • ${p}`);
  console.log('\nWill write:');
  if (plan.writeEslintConfig) console.log(`  • eslint.config.js  (${plan.presets.map((p) => p.name).join(' + ')})`);
  if (plan.writeTsconfig) console.log(`  • tsconfig.json     (extends @wellmade/tsconfig/${plan.tsconfigVariant})`);
  if (plan.writeStylelintConfig) console.log('  • stylelint.config.js');
  console.log('  • package.json (prettier field + scripts)');
  if (conflicts.length > 0) {
    console.log('\nConflicts:');
    for (const c of conflicts) console.log(`  ! ${c}`);
  }
  if (plan.notes.length > 0) {
    console.log('\nNotes:');
    for (const n of plan.notes) console.log(`  - ${n}`);
  }
}

function backupConflicts(conflicts) {
  for (const c of conflicts) {
    if (c.startsWith('package.json#')) continue; // handled inline
    const from = join(cwd, c);
    const to = `${from}.bak`;
    if (existsSync(to)) {
      console.warn(`Skipping backup: ${to} already exists`);
      continue;
    }
    renameSync(from, to);
    console.log(`  → backed up ${c} → ${c}.bak`);
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
  // prettier field on package.json
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
  const skipped = [];
  for (const [name, cmd] of Object.entries(desired)) {
    if (fresh.scripts[name]) {
      skipped.push(`${name} (existing: "${fresh.scripts[name]}", suggested: "${cmd}")`);
      continue;
    }
    fresh.scripts[name] = cmd;
    added.push(name);
  }
  writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + '\n');
  if (added.length > 0) console.log(`  ✓ scripts: ${added.join(', ')}`);
  if (skipped.length > 0) {
    console.log('  ! existing scripts preserved (review manually):');
    for (const s of skipped) console.log(`      ${s}`);
  }
}

function verify(plan) {
  const checks = [
    ['typecheck', 'npm run typecheck'],
    ['lint', 'npm run lint'],
    ['format:check', 'npm run format:check'],
  ];
  if (plan.needsStylelint) checks.push(['stylelint', 'npm run stylelint']);

  console.log('\nVerifying…');
  for (const [name, cmd] of checks) {
    try {
      execSync(cmd, { cwd, stdio: 'pipe' });
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.log(`  ✗ ${name} failed`);
      console.log(String(err.stdout || '').split('\n').slice(0, 20).join('\n'));
      console.log(
        `\nVerification stopped at "${name}". Fix the issues, or run "npm run lint:fix" / "npm run format" to auto-fix.`,
      );
      return false;
    }
  }
  return true;
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
