#!/usr/bin/env node
// record-deviation: record a deliberate departure from a @wellmade/*
// baseline. Writes/updates/removes entries in .wellmade/deviations.md
// and always reports the register's current state at end-of-run.
//
// Sources supported:
//   eslint    — rule disabled or lowered (id is the rule name)
//   tsconfig  — strict flag flipped (id is `tsconfig.<field>`)
//   prettier  — package.json#prettier replaced (id is `package.json#prettier`)
//   stylelint — rule disabled (id is the rule name)
//   package   — a @wellmade/* package skipped or replaced (id is the package name)

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  loadRegister,
  addEntry,
  removeEntry,
  summarize,
  isLikelyOverdue,
  REGISTER_RELATIVE_PATH,
} from '../_lib/deviations-register.mjs';

// ─── CLI parsing ───────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('-'));
const id = positional[0];

if (!id) {
  console.error('Usage: record.mjs <id> --why "..." --revisit-when "..." [--source <kind>]');
  console.error('       record.mjs <id> --remove');
  console.error('');
  console.error('Examples:');
  console.error('  record.mjs no-explicit-any --why "143 usages in services/api" --revisit-when "after bedrock migration"');
  console.error('  record.mjs tsconfig.verbatimModuleSyntax --why "Nest CJS scaffold" --revisit-when "2026-Q3"');
  console.error('  record.mjs @wellmade/lint-staged-config --source package --why "peer-dep mismatch" --revisit-when "after standards-js v0.2.0"');
  process.exit(1);
}

const DRY_RUN = argv.includes('--dry-run');
const REMOVE = argv.includes('--remove');
const why = flagValue('--why');
const revisitWhen = flagValue('--revisit-when');
const sourceOverride = flagValue('--source');
const initialCountRaw = flagValue('--initial-count');
const initialCount = initialCountRaw ? Number(initialCountRaw) : undefined;
if (initialCountRaw && Number.isNaN(initialCount)) {
  console.error(`--initial-count must be a number (got: ${initialCountRaw})`);
  process.exit(1);
}

const projectRoot = process.cwd();
const source = sourceOverride ?? inferSource(id);

function flagValue(flag) {
  const idx = argv.findIndex((a) => a === flag);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function inferSource(id) {
  if (id.startsWith('@wellmade/')) return 'package';
  if (id.startsWith('tsconfig.')) return 'tsconfig';
  if (id.startsWith('prettier.') || id === 'package.json#prettier') return 'prettier';
  if (id.startsWith('stylelint.')) return 'stylelint';
  return 'eslint';
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  if (REMOVE) {
    await runRemove();
  } else {
    await runAdd();
  }
  await reportRegisterState();
  await suggestAuditSkill();
}

async function runAdd() {
  if (!why || !revisitWhen) {
    console.error('Adding a deviation requires --why "..." and --revisit-when "..."');
    console.error('Both fields are free-text. audit-deviations uses revisit-when as a hint, not a hard deadline.');
    process.exit(1);
  }

  // Lookup what the current value is vs the Wellmade baseline.
  let baseline = '<unknown>';
  let actualValue = '<see config file>';
  try {
    const lookup = await currentVsBaseline(projectRoot, id, source);
    baseline = lookup.baseline;
    actualValue = lookup.current;
    if (lookup.notInBaseline) {
      console.warn(`⚠ ${id} is not part of the Wellmade ${source} baseline.`);
      console.warn(`  Tracking it anyway, but consider whether this is really a deviation from a Wellmade default.`);
    }
  } catch (err) {
    console.warn(`Could not resolve current/baseline values for ${id}: ${err.message}`);
    console.warn(`Using placeholders; edit .wellmade/deviations.md after to refine.`);
  }

  const entry = {
    id,
    source,
    actualValue,
    baseline,
    created: new Date().toISOString().slice(0, 10),
    revisitWhen,
    initialCount,
    why,
  };

  if (DRY_RUN) {
    console.log('(--dry-run) Would write entry:');
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  addEntry(projectRoot, entry);
  console.log(`✓ Recorded deviation in ${REGISTER_RELATIVE_PATH}: ${source}/${id}`);

  // For rule deviations, also suggest a config-file comment pointing
  // back at the register. For package deviations, the suggestion is
  // different (record-only — no config file edit).
  if (source !== 'package') {
    console.log(`  Tip: add a comment in your config file pointing at the register, e.g.:`);
    console.log(`       // see ${REGISTER_RELATIVE_PATH}#${id.replace(/[^\w-]/g, '-').toLowerCase()}`);
  } else {
    console.log(`  This deviation is registry-only — no config file edit is needed.`);
    console.log(`  The audit will re-check whether ${id} can be installed against your current peer-deps.`);
  }
}

async function runRemove() {
  if (DRY_RUN) {
    console.log(`(--dry-run) Would remove ${source}/${id} from ${REGISTER_RELATIVE_PATH}`);
    return;
  }
  const removed = removeEntry(projectRoot, id, source);
  if (removed) {
    console.log(`✓ Removed ${source}/${id} from ${REGISTER_RELATIVE_PATH}`);
    if (source !== 'package') {
      console.log(`  Don't forget to re-enable the rule in your config file.`);
    }
  } else {
    console.log(`No entry for ${source}/${id} found in ${REGISTER_RELATIVE_PATH}; nothing to remove.`);
  }
}

async function currentVsBaseline(root, id, src) {
  const baselineDiff = await import('../_lib/baseline-diff.mjs');
  switch (src) {
    case 'eslint': {
      const out = await baselineDiff.detectEslintDeviations(root);
      const match = out.deviations.find((d) => d.id === id);
      if (match) return { baseline: match.baseline, current: match.actualValue, notInBaseline: false };
      return { baseline: '<see baseline>', current: '<your current setting>', notInBaseline: false };
    }
    case 'tsconfig': {
      const out = baselineDiff.detectTsconfigDeviations(root);
      const match = out.deviations.find((d) => d.id === id);
      if (match) return { baseline: match.baseline, current: match.actualValue, notInBaseline: false };
      return { baseline: 'true', current: 'false', notInBaseline: false };
    }
    case 'prettier': {
      const out = baselineDiff.detectPrettierDeviations(root);
      const match = out.deviations.find((d) => d.id === id);
      if (match) return { baseline: match.baseline, current: match.actualValue, notInBaseline: false };
      return { baseline: '@wellmade/prettier-config', current: '<your current setting>', notInBaseline: false };
    }
    case 'package': {
      return { baseline: 'installed', current: 'skipped/replaced', notInBaseline: false };
    }
    default:
      return { baseline: '<unknown>', current: '<unknown>', notInBaseline: true };
  }
}

// ─── End-of-run reporting ─────────────────────────────────────────────────

async function reportRegisterState() {
  const { entries } = loadRegister(projectRoot);
  console.log('\n─── Register state ──────────────────────────');
  console.log(`  ${summarize(entries)}`);
  const overdue = entries.filter(isLikelyOverdue);
  if (overdue.length > 0) {
    console.log(`  ⚠ ${overdue.length} entry/entries look overdue:`);
    for (const e of overdue) {
      console.log(`    • ${e.source}/${e.id} (revisit-when: ${e.revisitWhen})`);
    }
  }
  console.log('─────────────────────────────────────────────');
}

async function suggestAuditSkill() {
  if (auditSkillInstalled()) {
    console.log('\nFor a deeper report (per-rule error-count trajectories, untracked drift):');
    console.log('  run the `audit-deviations` skill.');
    return;
  }
  console.log('\nInstall the companion audit skill for trajectory tracking + drift detection:');
  console.log('  npx skills add wellmade-studio/atelier-ai/skills/audit-deviations');
}

function auditSkillInstalled() {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '..', 'audit-deviations', 'SKILL.md'),
    join(homedir(), '.claude', 'skills', 'audit-deviations', 'SKILL.md'),
    join(projectRoot, '.claude', 'skills', 'audit-deviations', 'SKILL.md'),
  ];
  return candidates.some((p) => existsSync(p));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
