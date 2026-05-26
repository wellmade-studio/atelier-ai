#!/usr/bin/env node
// update-wellmade: bump every @wellmade/* package across a project
// (or monorepo) to the latest published versions in lockstep.
//
// Discovery: same as wire-project — package.json#workspaces, then
// services/*/apps/*/packages/*, then single-repo.
//
// Lockstep: every workspace gets the same latest version per package.
// No staged rollouts within a single run.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ASSUME_YES = argv.includes('--yes');
const SKIP_AUDIT = argv.includes('--skip-audit');
const EXACT = argv.includes('--exact');
const INCLUDE = argv.find((a) => a.startsWith('--include='))?.split('=')[1];

const cwd = process.cwd();
const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIT_SCRIPT = resolve(__dirname, '..', 'audit-deviations', 'audit.mjs');

// ─── Workspace discovery ───────────────────────────────────────────────────

function rootPackageJson() {
  const p = join(cwd, 'package.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function expandGlob(glob) {
  if (!glob.endsWith('/*')) {
    return existsSync(join(cwd, glob, 'package.json')) ? [glob] : [];
  }
  const dir = glob.slice(0, -2);
  const abs = join(cwd, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .map((name) => join(dir, name))
    .filter((rel) => existsSync(join(cwd, rel, 'package.json')));
}

function discoverWorkspaces(pkg) {
  if (INCLUDE) {
    return { source: 'override', workspaces: INCLUDE.split(',').flatMap(expandGlob) };
  }
  const ws = pkg?.workspaces;
  const wsList = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : null;
  if (wsList && wsList.length > 0) {
    const found = wsList.flatMap(expandGlob);
    // Include root too — root-level @wellmade/* deps (e.g. commitlint) are common.
    return { source: 'workspaces', workspaces: ['.', ...found] };
  }
  const fallback = ['services/*', 'apps/*', 'packages/*'].flatMap(expandGlob);
  if (fallback.length > 0) {
    return { source: 'convention', workspaces: ['.', ...fallback] };
  }
  return { source: 'single', workspaces: ['.'] };
}

// ─── Dep extraction ────────────────────────────────────────────────────────

function extractWellmadeDeps(workspacePath) {
  const abs = workspacePath === '.' ? cwd : join(cwd, workspacePath);
  const pkgPath = join(abs, 'package.json');
  if (!existsSync(pkgPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const deps = {};
  for (const section of ['dependencies', 'devDependencies']) {
    if (!pkg[section]) continue;
    for (const [name, range] of Object.entries(pkg[section])) {
      if (name.startsWith('@wellmade/')) {
        deps[name] = { current: range, section };
      }
    }
  }
  return { path: workspacePath, abs, pkg, deps };
}

// ─── Latest-version lookup ─────────────────────────────────────────────────

const latestCache = new Map();
function latestVersion(pkgName) {
  if (latestCache.has(pkgName)) return latestCache.get(pkgName);
  try {
    const out = execSync(`npm view ${pkgName} version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const v = out.trim();
    latestCache.set(pkgName, v);
    return v;
  } catch {
    latestCache.set(pkgName, null);
    return null;
  }
}

function formatRange(version, exact) {
  if (!version) return null;
  return exact ? version : `^${version}`;
}

// ─── Plan ──────────────────────────────────────────────────────────────────

function buildPlan(workspaces) {
  const plan = [];
  for (const ws of workspaces) {
    const extracted = extractWellmadeDeps(ws);
    if (!extracted) continue;
    const wellmadeNames = Object.keys(extracted.deps);
    if (wellmadeNames.length === 0) continue;
    const wsPlan = { path: ws, abs: extracted.abs, bumps: [] };
    for (const name of wellmadeNames) {
      const current = extracted.deps[name].current;
      const section = extracted.deps[name].section;
      const latest = latestVersion(name);
      const desiredRange = formatRange(latest, EXACT);
      const needsBump = desiredRange && current !== desiredRange;
      wsPlan.bumps.push({
        name,
        section,
        current,
        latest,
        desiredRange,
        needsBump,
      });
    }
    plan.push(wsPlan);
  }
  return plan;
}

// ─── Apply ─────────────────────────────────────────────────────────────────

function applyPlan(plan) {
  for (const ws of plan) {
    const bumpsToApply = ws.bumps.filter((b) => b.needsBump && b.desiredRange);
    if (bumpsToApply.length === 0) {
      console.log(`  ${ws.path}: nothing to update`);
      continue;
    }
    // Split by section so dev deps stay dev deps and runtime deps stay runtime.
    const byFlag = { '--save-dev': [], '--save': [] };
    for (const b of bumpsToApply) {
      const flag = b.section === 'devDependencies' ? '--save-dev' : '--save';
      byFlag[flag].push(`${b.name}@${b.desiredRange}`);
    }
    console.log(`\n  ${ws.path}: installing ${bumpsToApply.length} bump(s)…`);
    for (const [flag, pkgs] of Object.entries(byFlag)) {
      if (pkgs.length === 0) continue;
      const result = spawnSync('npm', ['install', flag, ...pkgs], {
        cwd: ws.abs,
        stdio: 'inherit',
      });
      if (result.status !== 0) {
        console.error(`  ✗ npm install failed in ${ws.path}`);
        process.exit(3);
      }
    }
  }
}

// ─── Reporting ─────────────────────────────────────────────────────────────

function printPlan(discovery, plan) {
  console.log(`Discovery method: ${discovery.source}`);
  console.log(`Workspaces scanned: ${discovery.workspaces.length}`);
  console.log(`Workspaces with @wellmade/* deps: ${plan.length}\n`);

  let totalBumps = 0;
  let totalCurrent = 0;
  for (const ws of plan) {
    console.log(`${ws.path}`);
    for (const b of ws.bumps) {
      if (!b.latest) {
        console.log(`  ${b.name}: ${b.current} → (npm lookup failed) ?`);
        continue;
      }
      const arrow = b.needsBump ? '↑' : '=';
      const tag = b.needsBump ? '' : '  (already current)';
      console.log(`  ${b.name}: ${b.current} → ${b.desiredRange}  ${arrow}${tag}`);
      if (b.needsBump) totalBumps++;
      else totalCurrent++;
    }
  }
  console.log(`\nTotal: ${totalBumps} bump(s) needed, ${totalCurrent} already current.`);
  return { totalBumps, totalCurrent };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const pkg = rootPackageJson();
  if (!pkg) fail('No package.json in current directory.');

  const discovery = discoverWorkspaces(pkg);
  const plan = buildPlan(discovery.workspaces);

  if (plan.length === 0) {
    console.log('No @wellmade/* packages found in any workspace. Nothing to update.');
    console.log('If this is unexpected, run `wire-project` first to install the toolchain.');
    return;
  }

  const { totalBumps } = printPlan(discovery, plan);

  if (DRY_RUN) {
    console.log('\n(--dry-run) No changes made.');
    return;
  }

  if (totalBumps === 0) {
    console.log('\nEverything is already current. Done.');
    if (!SKIP_AUDIT) await runAudit();
    return;
  }

  if (!ASSUME_YES) {
    const answer = await ask(`\nProceed with ${totalBumps} bump(s)? [y/N] `);
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted. No changes made.');
      process.exit(2);
    }
  }

  applyPlan(plan);

  console.log('\n✓ Updates installed.');

  let auditExitCode = null;
  if (!SKIP_AUDIT) {
    console.log('\nRunning audit-deviations to check whether any tracked deviations are now resolvable…\n');
    auditExitCode = await runAudit();
  } else {
    console.log('\nSkipped audit (--skip-audit). Run `audit-deviations` manually to check for resolvable package deviations.');
  }

  console.log('\nSuggested next steps:');
  console.log('  • Run typecheck + lint to catch any breakage from the new versions');
  console.log('  • Review .wellmade/deviations.md — package deviations may now be resolvable');
  console.log('  • git add -A && git commit -m "chore: bump @wellmade/* packages"');

  // audit-deviations exits 0 when clean, 1 when drift or overdue items
  // found. If it found something, point at record-deviation as the next move.
  if (auditExitCode === 1) {
    console.log('\n  The audit above flagged drift or overdue entries.');
    console.log('  • For untracked drift: run `record-deviation <id> --why ... --revisit-when ...`');
    console.log('  • For tracked entries now resolvable: run `record-deviation <id> --remove`');
  }
}

async function runAudit() {
  if (!existsSync(AUDIT_SCRIPT)) {
    console.log('  (audit-deviations not installed — skipping)');
    return null;
  }
  // Run audit with --ci so it returns a non-zero exit code on drift/overdue,
  // even though we treat that as informational here (not a failure). This
  // lets the caller decide whether to surface follow-up suggestions.
  const result = spawnSync('node', [AUDIT_SCRIPT, '--ci'], { cwd, stdio: 'inherit' });
  if (result.status !== 0 && result.status !== 1) {
    console.warn(`  audit-deviations exited ${result.status}`);
  }
  return result.status;
}

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
