#!/usr/bin/env node
// audit-relaxations: report on .wellmade/relaxations.md vs the current
// state of the project's configs and code.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadRegister, isLikelyOverdue } from '../_lib/relaxations-register.mjs';
import { detectAllRelaxations } from '../_lib/baseline-diff.mjs';

const argv = process.argv.slice(2);
const CHECK_TRAJECTORIES = argv.includes('--check-trajectories');
const CI = argv.includes('--ci');
const ALLOW_OVERDUE = argv.includes('--allow-overdue');
const AS_JSON = argv.includes('--json');

const projectRoot = process.cwd();

async function main() {
  const { exists, entries } = loadRegister(projectRoot);
  const detected = await detectAllRelaxations(projectRoot);

  // Build the report.
  const report = {
    registerExists: exists,
    tracked: entries.map((e) => ({
      ...e,
      overdue: isLikelyOverdue(e),
    })),
    drift: computeDrift(entries, detected),
    overdue: entries.filter(isLikelyOverdue),
    trajectories: [],
  };

  if (CHECK_TRAJECTORIES) {
    for (const entry of entries) {
      if (entry.source !== 'eslint') continue;
      if (typeof entry.initialCount !== 'number') continue;
      const current = countEslintViolations(projectRoot, entry.id);
      report.trajectories.push({
        id: entry.id,
        initial: entry.initialCount,
        current,
        delta: current === null ? null : current - entry.initialCount,
      });
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(decideExitCode(report) ? 0 : 1);
    return;
  }
  printReport(report);
  process.exit(decideExitCode(report) ? 0 : 1);
}

// ─── Reporting ─────────────────────────────────────────────────────────────

function printReport(report) {
  console.log('# Relaxation audit\n');
  if (!report.registerExists) {
    console.log('No `.wellmade/relaxations.md` found. The register hasn\'t been started yet.');
    console.log('Use the `relax-rule` skill to record relaxations as they happen.\n');
  } else {
    console.log(`## Tracked (${report.tracked.length})\n`);
    if (report.tracked.length === 0) {
      console.log('  (no entries)');
    } else {
      for (const e of report.tracked) {
        const overdueMark = e.overdue ? ' ⚠ overdue' : '';
        console.log(`- **${e.source}/${e.id}** — revisit-when: ${e.revisitWhen}${overdueMark}`);
        if (e.initialCount !== undefined) {
          console.log(`  - initial-count: ${e.initialCount}`);
        }
      }
    }
    console.log('');
  }

  console.log(`## Drift (${report.drift.length})\n`);
  if (report.drift.length === 0) {
    console.log('  (no untracked relaxations)\n');
  } else {
    console.log('Rules relaxed in your configs but not recorded in the register:');
    for (const d of report.drift) {
      console.log(`- **${d.source}/${d.id}**: baseline=${d.baseline}, relaxed-to=${d.relaxedTo}`);
    }
    console.log('');
    console.log('Either record them with `relax-rule <id> --why ... --revisit-when ...`');
    console.log('or restore the baseline in the corresponding config file.\n');
  }

  if (report.overdue.length > 0) {
    console.log(`## Overdue (${report.overdue.length})\n`);
    for (const e of report.overdue) {
      console.log(`- ${e.source}/${e.id} — revisit-when: ${e.revisitWhen}`);
    }
    console.log('');
  }

  if (CHECK_TRAJECTORIES && report.trajectories.length > 0) {
    console.log(`## Trajectories\n`);
    for (const t of report.trajectories) {
      if (t.current === null) {
        console.log(`- ${t.id}: (could not measure — ESLint run failed)`);
        continue;
      }
      const arrow = t.delta < 0 ? '↓' : t.delta > 0 ? '↑' : '=';
      console.log(`- ${t.id}: ${t.initial} → ${t.current} (${arrow}${Math.abs(t.delta)})`);
    }
    console.log('');
  }
}

function decideExitCode(report) {
  if (!CI) return true;
  if (report.drift.length > 0) return false;
  if (report.overdue.length > 0 && !ALLOW_OVERDUE) return false;
  return true;
}

// ─── Drift detection ───────────────────────────────────────────────────────

function computeDrift(entries, detected) {
  const tracked = new Set(entries.map((e) => `${e.source}/${e.id}`));
  const allDetected = [
    ...detected.eslint.relaxations,
    ...detected.tsconfig.relaxations,
    ...detected.prettier.relaxations,
  ];
  return allDetected.filter((d) => !tracked.has(`${d.source}/${d.id}`));
}

// ─── Trajectories ──────────────────────────────────────────────────────────

function countEslintViolations(cwd, ruleId) {
  // Re-enable the rule temporarily by passing `--rule '<id>: error'`
  // and counting messages of that rule in the JSON output.
  try {
    const out = execSync(
      `npx --no-install eslint --no-error-on-unmatched-pattern --format json --rule ${JSON.stringify(ruleId + ': error')} .`,
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const results = JSON.parse(out);
    let count = 0;
    for (const file of results) {
      for (const msg of file.messages ?? []) {
        if (msg.ruleId === ruleId) count++;
      }
    }
    return count;
  } catch (err) {
    // ESLint exits non-zero when there are errors; stdout still has JSON.
    try {
      const results = JSON.parse(String(err.stdout || ''));
      let count = 0;
      for (const file of results) {
        for (const msg of file.messages ?? []) {
          if (msg.ruleId === ruleId) count++;
        }
      }
      return count;
    } catch {
      return null;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
