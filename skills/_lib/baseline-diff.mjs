// Detect deviations between a project's configs and the @wellmade/*
// baselines. Used by relax-rule (to validate a proposed change is
// actually a relaxation) and audit-relaxations (to find tracked +
// untracked drift).
//
// Three sources, three detection strategies:
//
//   ESLint   — resolve the project's flat config, walk every config
//              block, compare each rule entry to @wellmade defaults.
//   tsconfig — read tsconfig.json + the @wellmade baseline it extends,
//              shallow-diff compilerOptions.
//   Prettier — package.json#prettier should equal "@wellmade/prettier-config"
//              (or the /tailwind variant); anything else is a relaxation.
//
// Implementation notes:
//  - This module shells out to ESLint/TS via their CLIs so it works
//    against the actual installed versions in the project.
//  - We require Wellmade configs to be installed in the project; if
//    they aren't, there's no baseline to diff against and we return
//    `{ baseline: 'missing', reason: '...' }`.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ─── ESLint ────────────────────────────────────────────────────────────────

const WELLMADE_ESLINT_PKG = '@wellmade/eslint-config';

export async function detectEslintRelaxations(projectRoot) {
  const projectPkg = readJson(join(projectRoot, 'package.json'));
  const hasWellmade = isInstalled(projectPkg, WELLMADE_ESLINT_PKG);
  if (!hasWellmade) {
    return { source: 'eslint', baseline: 'missing', reason: `${WELLMADE_ESLINT_PKG} not installed`, relaxations: [] };
  }

  // Use ESLint's `--print-config` against a probe file to get the
  // *resolved* rule set for the project. Then compare each rule to
  // the @wellmade baseline (also resolved against a probe in isolation).
  const probeAbs = join(projectRoot, '.wellmade-baseline-probe.ts');
  const projectRules = await resolveRulesViaProbe(projectRoot, probeAbs);
  const baselineRules = await resolveBaselineRules(projectRoot);

  if (!projectRules || !baselineRules) {
    return { source: 'eslint', baseline: 'unresolvable', reason: 'eslint --print-config failed', relaxations: [] };
  }

  const relaxations = [];
  for (const [rule, baselineValue] of Object.entries(baselineRules)) {
    const projectValue = projectRules[rule];
    if (projectValue === undefined) continue;
    if (isRelaxation(baselineValue, projectValue)) {
      relaxations.push({
        id: rule,
        source: 'eslint',
        baseline: severity(baselineValue),
        relaxedTo: severity(projectValue),
      });
    }
  }
  return { source: 'eslint', baseline: 'resolved', relaxations };
}

async function resolveRulesViaProbe(cwd, probePath) {
  try {
    // We don't actually write the probe file — `--print-config` accepts
    // a path that doesn't exist yet, and we just want the resolved
    // ruleset for a .ts file in this project.
    const out = execSync(`npx --no-install eslint --print-config ${probePath}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out).rules ?? {};
  } catch {
    return null;
  }
}

// Resolve the @wellmade/eslint-config baseline rules by creating a
// throwaway eslint config in a temp dir that uses *only* basePreset.
// Cached per process so repeated calls are cheap.
let cachedBaseline = null;
async function resolveBaselineRules(projectRoot) {
  if (cachedBaseline) return cachedBaseline;
  // Resolve the package's own eslint config in isolation: write a
  // minimal eslint.config.js into a temp dir that requires
  // @wellmade/eslint-config from the project's node_modules.
  // To avoid filesystem churn, we use `node -e` to print the resolved
  // config to stdout.
  const script = `
    import { basePreset } from '${WELLMADE_ESLINT_PKG}';
    import { Linter } from 'eslint';
    const linter = new Linter({ configType: 'flat' });
    const cfg = basePreset(process.cwd());
    const merged = {};
    for (const block of cfg) {
      if (block.rules) Object.assign(merged, block.rules);
    }
    process.stdout.write(JSON.stringify(merged));
  `;
  try {
    const out = execSync(`node --input-type=module -e ${JSON.stringify(script)}`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cachedBaseline = JSON.parse(out);
    return cachedBaseline;
  } catch {
    return null;
  }
}

function severity(value) {
  if (Array.isArray(value)) value = value[0];
  if (value === 0 || value === 'off') return 'off';
  if (value === 1 || value === 'warn') return 'warn';
  if (value === 2 || value === 'error') return 'error';
  return String(value);
}

function isRelaxation(baselineValue, projectValue) {
  const order = { off: 0, warn: 1, error: 2 };
  const b = order[severity(baselineValue)] ?? 0;
  const p = order[severity(projectValue)] ?? 0;
  return p < b;
}

// ─── tsconfig ──────────────────────────────────────────────────────────────

const WELLMADE_TSCONFIG_PKG = '@wellmade/tsconfig';

// Strictness fields where lowering the value relative to the baseline
// counts as a relaxation. Most are boolean true→false; some are tristate.
const STRICTNESS_FIELDS = new Set([
  'strict',
  'noImplicitAny',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'noImplicitThis',
  'alwaysStrict',
  'useUnknownInCatchVariables',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noImplicitOverride',
  'noFallthroughCasesInSwitch',
  'verbatimModuleSyntax',
  'isolatedModules',
  'noPropertyAccessFromIndexSignature',
]);

export function detectTsconfigRelaxations(projectRoot) {
  const projectPkg = readJson(join(projectRoot, 'package.json'));
  if (!isInstalled(projectPkg, WELLMADE_TSCONFIG_PKG)) {
    return { source: 'tsconfig', baseline: 'missing', reason: `${WELLMADE_TSCONFIG_PKG} not installed`, relaxations: [] };
  }
  const projectTsconfigPath = join(projectRoot, 'tsconfig.json');
  if (!existsSync(projectTsconfigPath)) {
    return { source: 'tsconfig', baseline: 'missing', reason: 'no tsconfig.json at project root', relaxations: [] };
  }
  const projectTsconfig = readJson(projectTsconfigPath);
  const extendsPath = projectTsconfig?.extends;
  if (typeof extendsPath !== 'string' || !extendsPath.startsWith(WELLMADE_TSCONFIG_PKG)) {
    return {
      source: 'tsconfig',
      baseline: 'not-extended',
      reason: `tsconfig.json does not extend ${WELLMADE_TSCONFIG_PKG}`,
      relaxations: [],
    };
  }
  // Resolve the baseline by reading the actual file inside node_modules.
  const baselineFile = join(projectRoot, 'node_modules', extendsPath.replace(/^@wellmade\/tsconfig/, '@wellmade/tsconfig'));
  // Normalize: `@wellmade/tsconfig/node.json` -> node_modules/@wellmade/tsconfig/node.json
  const resolvedBaselinePath = baselineFile.endsWith('.json') ? baselineFile : `${baselineFile}.json`;
  if (!existsSync(resolvedBaselinePath)) {
    return {
      source: 'tsconfig',
      baseline: 'unresolvable',
      reason: `could not find baseline file at ${resolvedBaselinePath}`,
      relaxations: [],
    };
  }
  const baseline = readJson(resolvedBaselinePath);
  const baselineOptions = baseline?.compilerOptions ?? {};
  const projectOptions = projectTsconfig?.compilerOptions ?? {};

  const relaxations = [];
  for (const field of STRICTNESS_FIELDS) {
    if (!(field in baselineOptions)) continue;
    if (!(field in projectOptions)) continue;
    const baselineValue = baselineOptions[field];
    const projectValue = projectOptions[field];
    if (baselineValue === true && projectValue === false) {
      relaxations.push({
        id: `tsconfig.${field}`,
        source: 'tsconfig',
        baseline: 'true',
        relaxedTo: 'false',
      });
    }
  }
  return { source: 'tsconfig', baseline: 'resolved', relaxations };
}

// ─── Prettier ──────────────────────────────────────────────────────────────

const WELLMADE_PRETTIER_VALUES = new Set([
  '@wellmade/prettier-config',
  '@wellmade/prettier-config/tailwind',
]);

export function detectPrettierRelaxations(projectRoot) {
  const projectPkg = readJson(join(projectRoot, 'package.json'));
  const prettierField = projectPkg?.prettier;
  if (!prettierField) {
    return { source: 'prettier', baseline: 'missing', reason: 'package.json#prettier not set', relaxations: [] };
  }
  if (typeof prettierField === 'string' && WELLMADE_PRETTIER_VALUES.has(prettierField)) {
    return { source: 'prettier', baseline: 'resolved', relaxations: [] };
  }
  // Anything else (object override, different package) is a relaxation —
  // a single one identified by 'package.json#prettier'.
  return {
    source: 'prettier',
    baseline: 'resolved',
    relaxations: [
      {
        id: 'package.json#prettier',
        source: 'prettier',
        baseline: '@wellmade/prettier-config',
        relaxedTo: typeof prettierField === 'string' ? prettierField : '<object override>',
      },
    ],
  };
}

// ─── Combined ──────────────────────────────────────────────────────────────

export async function detectAllRelaxations(projectRoot) {
  const [eslint, tsconfig, prettier] = await Promise.all([
    detectEslintRelaxations(projectRoot),
    Promise.resolve(detectTsconfigRelaxations(projectRoot)),
    Promise.resolve(detectPrettierRelaxations(projectRoot)),
  ]);
  return { eslint, tsconfig, prettier };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isInstalled(pkg, name) {
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}
