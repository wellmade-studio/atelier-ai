/**
 * atelier-ai's commitlint config — inlined, not extended.
 *
 * Earlier this file extended `@wellmade/commitlint-config`, but
 * atelier-ai has no `package.json`, and the action that lints
 * commits in CI (wagoid/commitlint-github-action) runs in a Docker
 * container with no way to install the extends'd package — it
 * errors with "Cannot find module @wellmade/commitlint-config". So
 * the rule set lives directly here instead — same shape as the
 * published `@wellmade/commitlint-config@0.2.x`, no npm machinery.
 *
 * Atelier-ai isn't an npm consumer (no package.json, no node_modules),
 * so the "dogfood the published package" framing doesn't quite fit
 * here. Standards-js and bedrock-js really do dogfood it via
 * devDeps; atelier-ai just mirrors the rule set locally.
 *
 * Atelier-ai has a fast cadence and a wide surface (skills, hooks,
 * templates, agents, the installer). We deliberately don't enforce
 * a `scope-enum` — locking commit scopes would be friction without
 * payoff. Any scope or none is fine.
 *
 * @type {import('@commitlint/types').UserConfig}
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Standard Conventional Commits message shape.
    'body-leading-blank': [2, 'always'],

    // Warning, not error — the conventional-changelog parser treats
    // any blank line in the body as the body→footer boundary, then
    // fails the trailing line (e.g. `Co-Authored-By:`) against a
    // missing-leading-blank check. Mis-fires on perfectly valid
    // markdown bodies with multiple bullet groups; warning preserves
    // the signal without blocking the commit.
    'footer-leading-blank': [1, 'always'],

    // 100-char subject keeps `git log --oneline` tidy.
    'header-max-length': [2, 'always', 100],
  },
};
