// Read/write the .wellmade/relaxations.md register.
//
// Format: a markdown file with one section per relaxation. Each section
// has YAML front-matter for structured fields and a free-text body for
// the "why". Designed to be both human-readable and machine-parseable.
//
// Example entry:
//
//   ## no-explicit-any
//
//   - **source**: eslint
//   - **relaxed-to**: off
//   - **baseline**: error
//   - **created**: 2026-05-22
//   - **revisit-when**: after migration to @wellmade/bedrock parsers
//   - **initial-count**: 143
//
//   We adopted Wellmade on a brownfield codebase with 143 `any` usages
//   spread across services/api. Re-enabling means typing the Mongoose
//   document shapes first; tracked in INGEST-412.
//
// The skill (relax-rule) appends entries; audit-relaxations parses them
// to compute trajectories. Both go through this module so the format
// stays consistent.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const REGISTER_RELATIVE_PATH = '.wellmade/relaxations.md';

const HEADER = `# Wellmade relaxations

This file tracks deliberate overrides of the Wellmade toolchain
baselines. Each entry exists because someone decided that strict
compliance wasn't sustainable *right now* — not because the rule was
wrong. Each entry should be revisited.

Managed by the \`relax-rule\` and \`audit-relaxations\` skills from
[atelier-ai](https://github.com/wellmade-studio/atelier-ai). You can
edit entries by hand, but the machine-readable fields below the entry
heading must stay in the documented format or the audit skill will
miss them.

`;

/**
 * @typedef {Object} Relaxation
 * @property {string} id              kebab-case identifier (e.g. "no-explicit-any", "tsconfig.verbatimModuleSyntax")
 * @property {string} source          "eslint" | "tsconfig" | "prettier" | "stylelint"
 * @property {string} relaxedTo       new value (e.g. "off", "false")
 * @property {string} baseline        Wellmade baseline value (e.g. "error", "true")
 * @property {string} created         YYYY-MM-DD
 * @property {string} revisitWhen     free-text condition or date
 * @property {number=} initialCount   error count at adoption, if measurable
 * @property {string} why             free-text justification
 */

export function registerPath(projectRoot) {
  return join(projectRoot, REGISTER_RELATIVE_PATH);
}

export function loadRegister(projectRoot) {
  const path = registerPath(projectRoot);
  if (!existsSync(path)) return { exists: false, entries: [] };
  const raw = readFileSync(path, 'utf8');
  return { exists: true, entries: parseRegister(raw) };
}

export function saveRegister(projectRoot, entries) {
  const path = registerPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, HEADER + entries.map(entryToMarkdown).join('\n') + '\n');
}

export function addEntry(projectRoot, entry) {
  const { entries } = loadRegister(projectRoot);
  const idx = entries.findIndex((e) => e.id === entry.id && e.source === entry.source);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  saveRegister(projectRoot, entries);
  return entry;
}

export function removeEntry(projectRoot, id, source) {
  const { entries } = loadRegister(projectRoot);
  const filtered = entries.filter((e) => !(e.id === id && e.source === source));
  if (filtered.length === entries.length) return false;
  saveRegister(projectRoot, filtered);
  return true;
}

// ─── Markdown ⇄ entry ──────────────────────────────────────────────────────

function entryToMarkdown(entry) {
  const fields = [
    `- **source**: ${entry.source}`,
    `- **relaxed-to**: ${formatValue(entry.relaxedTo)}`,
    `- **baseline**: ${formatValue(entry.baseline)}`,
    `- **created**: ${entry.created}`,
    `- **revisit-when**: ${entry.revisitWhen}`,
  ];
  if (typeof entry.initialCount === 'number') {
    fields.push(`- **initial-count**: ${entry.initialCount}`);
  }
  return `## ${entry.id}\n\n${fields.join('\n')}\n\n${entry.why.trim()}\n`;
}

function formatValue(v) {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

const HEADING_RE = /^##\s+(.+?)\s*$/;
const FIELD_RE = /^-\s+\*\*([\w-]+)\*\*:\s*(.+?)\s*$/;

function parseRegister(raw) {
  const lines = raw.split('\n');
  const entries = [];
  let current = null;
  let collectingWhy = false;
  let whyBuf = [];

  for (const line of lines) {
    const h = line.match(HEADING_RE);
    if (h) {
      if (current) {
        current.why = whyBuf.join('\n').trim();
        entries.push(current);
      }
      current = {
        id: h[1].trim(),
        source: '',
        relaxedTo: '',
        baseline: '',
        created: '',
        revisitWhen: '',
        initialCount: undefined,
        why: '',
      };
      whyBuf = [];
      collectingWhy = false;
      continue;
    }
    if (!current) continue;
    const f = line.match(FIELD_RE);
    if (f) {
      collectingWhy = false;
      const [, key, value] = f;
      switch (key) {
        case 'source': current.source = value; break;
        case 'relaxed-to': current.relaxedTo = value; break;
        case 'baseline': current.baseline = value; break;
        case 'created': current.created = value; break;
        case 'revisit-when': current.revisitWhen = value; break;
        case 'initial-count': current.initialCount = Number(value); break;
        default: break;
      }
      continue;
    }
    if (line.trim() === '' && !collectingWhy && whyBuf.length === 0) continue;
    collectingWhy = true;
    whyBuf.push(line);
  }
  if (current) {
    current.why = whyBuf.join('\n').trim();
    entries.push(current);
  }
  return entries.filter((e) => e.id && e.source);
}

// ─── Reporting helpers ─────────────────────────────────────────────────────

export function summarize(entries) {
  if (entries.length === 0) return 'No relaxations tracked.';
  const bySource = entries.reduce((acc, e) => {
    acc[e.source] = (acc[e.source] ?? 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(bySource).map(([s, n]) => `${n} ${s}`);
  return `${entries.length} relaxation(s) tracked: ${parts.join(', ')}.`;
}

export function isLikelyOverdue(entry) {
  // Heuristic: if revisit-when is an ISO date in the past, it's overdue.
  // If it mentions a year that's already passed, also overdue.
  const yearMatch = entry.revisitWhen.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    const thisYear = new Date().getUTCFullYear();
    if (Number(yearMatch[1]) < thisYear) return true;
  }
  const isoMatch = entry.revisitWhen.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const target = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00Z`);
    return target.getTime() < Date.now();
  }
  return false;
}
