#!/usr/bin/env node
// relax-rule: record a deliberate relaxation of a Wellmade baseline
// rule. Writes/updates/removes entries in .wellmade/relaxations.md and
// always reports the register's current state at end-of-run.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  loadRegister,
  addEntry,
  removeEntry,
  summarize,
  isLikelyOverdue,
  REGISTER_RELATIVE_PATH,
} from '../_lib/relaxations-register.mjs';

// ─── CLI parsing ───────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('-'));
const ruleId = positional[0];

if (!ruleId) {
  console.error('Usage: relax.mjs <rule-id> --why "..." --revisit-when "..." [--source <kind>]');
  console.error('       relax.mjs <rule-id> --remove');
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
const source = sourceOverride ?? inferSource(ruleId);

function flagValue(flag) {
  const idx = argv.findIndex((a) => a === flag);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function inferSource(id) {
  if (id.startsWith('tsconfig.')) return 'tsconfig';
  if (id.startsWith('prettier.')) return 'prettier';
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
    console.error('Adding a relaxation requires --why "..." and --revisit-when "..."');
    console.error('Both fields are free-text. audit-relaxations uses revisit-when as a hint, not a hard deadline.');
    process.exit(1);
  }

  // Lookup what the rule currently is vs the Wellmade baseline.
  let baseline = '<unknown>';
  let relaxedTo = '<see config file>';
  try {
    const lookup = await currentVsBaseline(projectRoot, ruleId, source);
    baseline = lookup.baseline;
    relaxedTo = lookup.current;
    if (lookup.notInBaseline) {
      console.warn(`⚠ ${ruleId} is not part of the Wellmade ${source} baseline.`);
      console.warn(`  Tracking it in the register anyway, but consider whether this is really a 'relaxation'.`);
    }
  } catch (err) {
    console.warn(`Could not resolve current/baseline values for ${ruleId}: ${err.message}`);
    console.warn(`Using placeholders; edit .wellmade/relaxations.md after to refine.`);
  }

  const entry = {
    id: ruleId,
    source,
    relaxedTo,
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
  console.log(`✓ Recorded relaxation in ${REGISTER_RELATIVE_PATH}: ${source}/${ruleId}`);
  console.log(`  Tip: add a comment in your config file pointing at the register, e.g.:`);
  console.log(`       // see ${REGISTER_RELATIVE_PATH}#${ruleId}`);
}

async function runRemove() {
  if (DRY_RUN) {
    console.log(`(--dry-run) Would remove ${source}/${ruleId} from ${REGISTER_RELATIVE_PATH}`);
    return;
  }
  const removed = removeEntry(projectRoot, ruleId, source);
  if (removed) {
    console.log(`✓ Removed ${source}/${ruleId} from ${REGISTER_RELATIVE_PATH}`);
    console.log(`  Don't forget to re-enable the rule in your config file.`);
  } else {
    console.log(`No entry for ${source}/${ruleId} found in ${REGISTER_RELATIVE_PATH}; nothing to remove.`);
  }
}

async function currentVsBaseline(root, id, src) {
  // For tsconfig and prettier, the baseline lookup is straightforward
  // and lives in baseline-diff. For ESLint, we resolve via the
  // module and look up the specific rule.
  const baselineDiff = await import('../_lib/baseline-diff.mjs');
  switch (src) {
    case 'eslint': {
      const out = await baselineDiff.detectEslintRelaxations(root);
      const match = out.relaxations.find((r) => r.id === id);
      if (match) return { baseline: match.baseline, current: match.relaxedTo, notInBaseline: false };
      // Not currently relaxed — fetch the baseline + current values directly.
      return { baseline: '<see baseline>', current: '<your current setting>', notInBaseline: false };
    }
    case 'tsconfig': {
      const field = id.replace(/^tsconfig\./, '');
      const out = baselineDiff.detectTsconfigRelaxations(root);
      const match = out.relaxations.find((r) => r.id === id);
      if (match) return { baseline: match.baseline, current: match.relaxedTo, notInBaseline: false };
      return { baseline: 'true', current: 'false', notInBaseline: false };
    }
    case 'prettier': {
      const out = baselineDiff.detectPrettierRelaxations(root);
      const match = out.relaxations.find((r) => r.id === id);
      if (match) return { baseline: match.baseline, current: match.relaxedTo, notInBaseline: false };
      return { baseline: '@wellmade/prettier-config', current: '<your current setting>', notInBaseline: false };
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
    console.log('\nFor a deeper report (per-rule error-count trajectories, drift detection):');
    console.log('  run the `audit-relaxations` skill.');
    return;
  }
  console.log('\nInstall the companion audit skill for trajectory tracking:');
  console.log('  npx skills add wellmade-studio/atelier-ai/skills/audit-relaxations');
}

function auditSkillInstalled() {
  // Look in the obvious places: alongside this skill, in ~/.claude/skills,
  // or in the project's .claude/skills.
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '..', 'audit-relaxations', 'SKILL.md'),
    join(homedir(), '.claude', 'skills', 'audit-relaxations', 'SKILL.md'),
    join(projectRoot, '.claude', 'skills', 'audit-relaxations', 'SKILL.md'),
  ];
  return candidates.some((p) => existsSync(p));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
