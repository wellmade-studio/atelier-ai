#!/usr/bin/env node
// wire-project: bring a project (single repo or monorepo) up to the
// Wellmade standard in one shot.
//
//   1. Discover services (workspaces if declared, else services/apps/packages)
//   2. Run configure-project on each
//   3. Drop / merge the AGENTS.md template
//   4. Offer to install the lint-on-edit hook
//
// Designed to be lifted into `wm wire` when @wellmade/cli ships.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ASSUME_YES = argv.includes('--yes');
const SKIP_HOOK = argv.includes('--skip-hook');
const SKIP_TEMPLATE = argv.includes('--skip-template');
const ALSO_CLAUDE_MD = argv.includes('--also-claude-md');
const COPY_HOOKS = argv.includes('--copy-hooks');
const SERVICES_OVERRIDE = argv.find((a) => a.startsWith('--services='))?.split('=')[1];

const cwd = process.cwd();
const __dirname = dirname(fileURLToPath(import.meta.url));
const ATELIER_ROOT = resolve(__dirname, '..', '..');
const CONFIGURE_SCRIPT = join(ATELIER_ROOT, 'skills', 'configure-project', 'configure.mjs');
const AGENTS_TEMPLATE = join(ATELIER_ROOT, 'templates', 'AGENTS.md');
const HOOK_SCRIPT = join(ATELIER_ROOT, 'hooks', 'lint-on-edit.sh');

const CONVENTIONS_START = '<!-- atelier-ai:wellmade-conventions:start -->';
const CONVENTIONS_END = '<!-- atelier-ai:wellmade-conventions:end -->';

// ─── Service discovery ─────────────────────────────────────────────────────

function rootPackageJson() {
  const p = join(cwd, 'package.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function expandGlob(glob) {
  // Minimal glob: only supports trailing /*. Anything fancier, defer to
  // the user's --services override.
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

function discoverServices(pkg) {
  if (SERVICES_OVERRIDE) {
    return SERVICES_OVERRIDE.split(',').flatMap(expandGlob);
  }
  // 1. package.json#workspaces
  const ws = pkg?.workspaces;
  const wsList = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : null;
  if (wsList && wsList.length > 0) {
    const found = wsList.flatMap(expandGlob);
    if (found.length > 0) return { source: 'workspaces', services: found };
  }
  // 2. services/* apps/* packages/*
  const fallback = ['services/*', 'apps/*', 'packages/*'].flatMap(expandGlob);
  if (fallback.length > 0) {
    return { source: 'convention', services: fallback };
  }
  // 3. single-repo
  return { source: 'single', services: ['.'] };
}

// ─── AGENTS.md merge ───────────────────────────────────────────────────────

function readTemplate() {
  return readFileSync(AGENTS_TEMPLATE, 'utf8');
}

function mergeAgentsMd(targetPath) {
  const template = readTemplate();
  if (!existsSync(targetPath)) {
    writeFileSync(targetPath, template);
    return 'created';
  }
  const existing = readFileSync(targetPath, 'utf8');
  if (existing.includes(CONVENTIONS_START) && existing.includes(CONVENTIONS_END)) {
    // Replace just the marked block.
    const re = new RegExp(
      `${CONVENTIONS_START}[\\s\\S]*?${CONVENTIONS_END}`,
    );
    const blockMatch = template.match(re);
    if (!blockMatch) return 'template-missing-markers';
    const merged = existing.replace(re, blockMatch[0]);
    writeFileSync(targetPath, merged);
    return 'updated';
  }
  // No markers in existing file — append.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(targetPath, existing + sep + template);
  return 'appended';
}

// ─── Hook installer (Claude Code wiring) ───────────────────────────────────

function defaultClaudeSettingsPath() {
  return join(homedir(), '.claude', 'settings.json');
}

function readSettings(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // signal corruption
  }
}

function writeSettings(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

function installHook() {
  const claudeHome = join(homedir(), '.claude');
  const hookDest = join(claudeHome, 'hooks', 'lint-on-edit.sh');
  mkdirSync(dirname(hookDest), { recursive: true });
  if (!existsSync(hookDest)) {
    if (COPY_HOOKS) copyFileSync(HOOK_SCRIPT, hookDest);
    else symlinkSync(HOOK_SCRIPT, hookDest);
  }

  const settingsPath = defaultClaudeSettingsPath();
  const settings = readSettings(settingsPath);
  if (settings === null) {
    console.warn(`  ! ${settingsPath} is not valid JSON — leaving it alone. Add the hook block manually.`);
    return { installed: false, reason: 'corrupted-settings' };
  }
  settings.hooks ??= {};
  settings.hooks.PostToolUse ??= [];
  const matcher = 'Edit|Write|MultiEdit';
  const command = '$HOME/.claude/hooks/lint-on-edit.sh';
  const already = settings.hooks.PostToolUse.some(
    (entry) => entry.matcher === matcher && entry.hooks?.some((h) => h.command === command),
  );
  if (already) return { installed: false, reason: 'already-present' };
  settings.hooks.PostToolUse.push({
    matcher,
    hooks: [{ type: 'command', command }],
  });
  writeSettings(settingsPath, settings);
  return { installed: true };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const pkg = rootPackageJson();
  if (!pkg) fail('No package.json in current directory.');

  const discovery = discoverServices(pkg);
  const isMonorepo = discovery.source !== 'single';

  console.log('Discovery method:', discovery.source);
  console.log('Services to configure:');
  for (const s of discovery.services) console.log(`  • ${s}`);

  if (!ASSUME_YES && !DRY_RUN) {
    const answer = await ask('\nProceed? [y/N] ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(2);
    }
  }

  // Step 2: configure each
  for (const service of discovery.services) {
    const abs = service === '.' ? cwd : join(cwd, service);
    const pkgPath = join(abs, 'package.json');
    if (!existsSync(pkgPath)) {
      console.warn(`  ! skipping ${service} (no package.json)`);
      continue;
    }
    const servicePkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const alreadyConfigured = Boolean(
      servicePkg.devDependencies?.['@wellmade/eslint-config'] ||
        servicePkg.dependencies?.['@wellmade/eslint-config'],
    );
    if (alreadyConfigured && !ASSUME_YES) {
      console.log(`  ↷ ${service} (already has @wellmade/eslint-config — skipping)`);
      continue;
    }
    console.log(`\n=== Configuring ${service} ===`);
    if (DRY_RUN) {
      console.log(`  (dry-run) would invoke configure-project`);
      continue;
    }
    const args = ['--yes'];
    const result = spawnSync('node', [CONFIGURE_SCRIPT, ...args], {
      cwd: abs,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.error(`  ✗ configure-project failed in ${service}`);
      process.exit(3);
    }
  }

  // Step 3: AGENTS.md
  if (!SKIP_TEMPLATE) {
    const target = join(cwd, 'AGENTS.md');
    if (DRY_RUN) {
      console.log(`\n(dry-run) would merge ${AGENTS_TEMPLATE} → ${target}`);
    } else {
      const outcome = mergeAgentsMd(target);
      console.log(`\nAGENTS.md: ${outcome}`);
      if (ALSO_CLAUDE_MD) {
        const claudeMd = join(cwd, 'CLAUDE.md');
        const claudeOutcome = mergeAgentsMd(claudeMd);
        console.log(`CLAUDE.md: ${claudeOutcome}`);
      }
    }
  }

  // Step 4: hook
  if (!SKIP_HOOK) {
    const answer = ASSUME_YES
      ? 'y'
      : await ask('\nInstall lint-on-edit hook into ~/.claude/settings.json? [y/N] ');
    if (answer.toLowerCase() === 'y') {
      if (DRY_RUN) {
        console.log('(dry-run) would install hook + edit ~/.claude/settings.json');
      } else {
        const r = installHook();
        if (r.installed) console.log('  ✓ hook installed');
        else console.log(`  ↷ hook not changed (${r.reason})`);
      }
    } else {
      console.log('  Skipped. To install later for a non-Claude agent, see README.');
    }
  }

  console.log('\nDone.');
}

// ─── Helpers ───────────────────────────────────────────────────────────────

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
