// Detect deviations between a project's configs and the @wellmade/*
// baselines. Used by record-deviation (to validate a proposed change
// against the baseline) and audit-deviations (to find tracked +
// untracked drift).
//
// Four sources, four detection strategies:
//
//   ESLint   — resolve the project's flat config, walk every config
//              block, compare each rule entry to @wellmade defaults.
//   tsconfig — read tsconfig.json + the @wellmade baseline it extends,
//              shallow-diff compilerOptions.
//   Prettier — package.json#prettier should equal "@wellmade/prettier-config"
//              (or the /tailwind variant); anything else is a deviation.
//   package  — every @wellmade/* package the project "should" have for
//              its stack must be installed. Anything missing or replaced
//              counts as a deviation, since the project is opting out of
//              a Wellmade baseline at the package level.
//
// Implementation notes:
//  - This module shells out to ESLint via the project's installed CLI
//    so it sees the actual resolved configs.
//  - We require the corresponding Wellmade config to be installed to
//    diff against; if it isn't, that itself is a `package` deviation
//    (caught by detectPackageDeviations) and the rule/option detector
//    returns `{ baseline: 'missing', ... }`.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ─── ESLint ────────────────────────────────────────────────────────────────

const WELLMADE_ESLINT_PKG = '@wellmade/eslint-config';

export async function detectEslintDeviations(projectRoot) {
  const projectPkg = readJson(join(projectRoot, 'package.json'));
  const hasWellmade = isInstalled(projectPkg, WELLMADE_ESLINT_PKG);
  if (!hasWellmade) {
    return { source: 'eslint', baseline: 'missing', reason: `${WELLMADE_ESLINT_PKG} not installed`, deviations: [] };
  }

  // Use ESLint's `--print-config` against a probe file to get the
  // *resolved* rule set for the project. Then compare each rule to
  // the @wellmade baseline (also resolved against a probe in isolation).
  const probeAbs = join(projectRoot, '.wellmade-baseline-probe.ts');
  const projectRules = await resolveRulesViaProbe(projectRoot, probeAbs);
  const baselineRules = await resolveBaselineRules(projectRoot);

  if (!projectRules || !baselineRules) {
    return { source: 'eslint', baseline: 'unresolvable', reason: 'eslint --print-config failed', deviations: [] };
  }

  const deviations = [];
  for (const [rule, baselineValue] of Object.entries(baselineRules)) {
    const projectValue = projectRules[rule];
    if (projectValue === undefined) continue;
    if (isLowered(baselineValue, projectValue)) {
      deviations.push({
        id: rule,
        source: 'eslint',
        baseline: severity(baselineValue),
        actualValue: severity(projectValue),
      });
    }
  }
  return { source: 'eslint', baseline: 'resolved', deviations };
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

// Resolve the @wellmade/eslint-config baseline rules by importing
// basePreset from the project's node_modules and flattening its rules.
// Cached per process so repeated calls are cheap.
let cachedBaseline = null;
async function resolveBaselineRules(projectRoot) {
  if (cachedBaseline) return cachedBaseline;
  const script = `
    import { basePreset } from '${WELLMADE_ESLINT_PKG}';
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

function isLowered(baselineValue, projectValue) {
  const order = { off: 0, warn: 1, error: 2 };
  const b = order[severity(baselineValue)] ?? 0;
  const p = order[severity(projectValue)] ?? 0;
  return p < b;
}

// ─── tsconfig ──────────────────────────────────────────────────────────────

const WELLMADE_TSCONFIG_PKG = '@wellmade/tsconfig';

// Strictness fields where lowering the value relative to the baseline
// counts as a deviation. Most are boolean true→false.
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

export function detectTsconfigDeviations(projectRoot) {
  const projectPkg = readJson(join(projectRoot, 'package.json'));
  if (!isInstalled(projectPkg, WELLMADE_TSCONFIG_PKG)) {
    return { source: 'tsconfig', baseline: 'missing', reason: `${WELLMADE_TSCONFIG_PKG} not installed`, deviations: [] };
  }
  const projectTsconfigPath = join(projectRoot, 'tsconfig.json');
  if (!existsSync(projectTsconfigPath)) {
    return { source: 'tsconfig', baseline: 'missing', reason: 'no tsconfig.json at project root', deviations: [] };
  }
  const projectTsconfig = readJson(projectTsconfigPath);
  const extendsPath = projectTsconfig?.extends;
  if (typeof extendsPath !== 'string' || !extendsPath.startsWith(WELLMADE_TSCONFIG_PKG)) {
    return {
      source: 'tsconfig',
      baseline: 'not-extended',
      reason: `tsconfig.json does not extend ${WELLMADE_TSCONFIG_PKG}`,
      deviations: [],
    };
  }
  // Resolve the baseline by reading the actual file inside node_modules.
  const baselineFile = join(projectRoot, 'node_modules', extendsPath);
  const resolvedBaselinePath = baselineFile.endsWith('.json') ? baselineFile : `${baselineFile}.json`;
  if (!existsSync(resolvedBaselinePath)) {
    return {
      source: 'tsconfig',
      baseline: 'unresolvable',
      reason: `could not find baseline file at ${resolvedBaselinePath}`,
      deviations: [],
    };
  }
  const baseline = readJson(resolvedBaselinePath);
  const baselineOptions = baseline?.compilerOptions ?? {};
  const projectOptions = projectTsconfig?.compilerOptions ?? {};

  const deviations = [];
  for (const field of STRICTNESS_FIELDS) {
    if (!(field in baselineOptions)) continue;
    if (!(field in projectOptions)) continue;
    const baselineValue = baselineOptions[field];
    const projectValue = projectOptions[field];
    if (baselineValue === true && projectValue === false) {
      deviations.push({
        id: `tsconfig.${field}`,
        source: 'tsconfig',
        baseline: 'true',
        actualValue: 'false',
      });
    }
  }
  return { source: 'tsconfig', baseline: 'resolved', deviations };
}

// ─── Prettier ──────────────────────────────────────────────────────────────

const WELLMADE_PRETTIER_VALUES = new Set([
  '@wellmade/prettier-config',
  '@wellmade/prettier-config/tailwind',
]);

export function detectPrettierDeviations(projectRoot) {
  const projectPkg = readJson(join(projectRoot, 'package.json'));
  const prettierField = projectPkg?.prettier;
  if (!prettierField) {
    return { source: 'prettier', baseline: 'missing', reason: 'package.json#prettier not set', deviations: [] };
  }
  if (typeof prettierField === 'string' && WELLMADE_PRETTIER_VALUES.has(prettierField)) {
    return { source: 'prettier', baseline: 'resolved', deviations: [] };
  }
  return {
    source: 'prettier',
    baseline: 'resolved',
    deviations: [
      {
        id: 'package.json#prettier',
        source: 'prettier',
        baseline: '@wellmade/prettier-config',
        actualValue: typeof prettierField === 'string' ? prettierField : '<object override>',
      },
    ],
  };
}

// ─── Packages ──────────────────────────────────────────────────────────────
//
// "Should this project have @wellmade/X installed?" The honest answer
// depends on the stack. Rather than hardcode per-stack expectations
// (which duplicates configure-project's detection), we infer:
//
//   - Any @wellmade/* package already in dependencies/devDependencies
//     is the "the project opted in to this baseline." Compare against
//     all known @wellmade/* packages; flag anything plausibly expected
//     for this stack that's missing.
//   - "Plausibly expected" = sibling-of-installed packages. If a project
//     has @wellmade/eslint-config but not @wellmade/prettier-config or
//     @wellmade/tsconfig, that's a deviation worth recording.
//
// This is intentionally conservative — false negatives over false
// positives. A project that explicitly doesn't want prettier-config
// can record the deviation with record-deviation and audit-deviations
// stops complaining.

const WELLMADE_CORE_PACKAGES = [
  '@wellmade/eslint-config',
  '@wellmade/prettier-config',
  '@wellmade/tsconfig',
];

const WELLMADE_OPTIONAL_PACKAGES = [
  '@wellmade/stylelint-config',
  '@wellmade/commitlint-config',
  '@wellmade/lint-staged-config',
  '@wellmade/bedrock',
];

export function detectPackageDeviations(projectRoot) {
  const projectPkg = readJson(join(projectRoot, 'package.json'));
  if (!projectPkg) {
    return { source: 'package', baseline: 'missing', reason: 'no package.json', deviations: [] };
  }
  const allDeps = { ...projectPkg.dependencies, ...projectPkg.devDependencies };
  const installed = new Set(Object.keys(allDeps).filter((d) => d.startsWith('@wellmade/')));
  if (installed.size === 0) {
    return {
      source: 'package',
      baseline: 'opt-out',
      reason: 'no @wellmade/* packages installed — this project hasn\'t opted into the toolchain',
      deviations: [],
    };
  }
  // The project has opted in to some @wellmade/* packages. Flag any
  // *core* package that's missing as a deviation (treating the user's
  // partial adoption as the baseline "they want Wellmade").
  const deviations = [];
  for (const pkg of WELLMADE_CORE_PACKAGES) {
    if (!installed.has(pkg)) {
      deviations.push({
        id: pkg,
        source: 'package',
        baseline: 'installed',
        actualValue: 'missing',
      });
    }
  }
  // Optional packages are not flagged automatically — only via explicit
  // record-deviation, since "not using stylelint" is a legitimate choice
  // for many stacks (CSS-in-JS, etc.).
  return { source: 'package', baseline: 'resolved', deviations };
}

// ─── Combined ──────────────────────────────────────────────────────────────

export async function detectAllDeviations(projectRoot) {
  const [eslint, tsconfig, prettier, pkg] = await Promise.all([
    detectEslintDeviations(projectRoot),
    Promise.resolve(detectTsconfigDeviations(projectRoot)),
    Promise.resolve(detectPrettierDeviations(projectRoot)),
    Promise.resolve(detectPackageDeviations(projectRoot)),
  ]);
  return { eslint, tsconfig, prettier, package: pkg };
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
