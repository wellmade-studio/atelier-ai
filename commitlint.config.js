/**
 * atelier-ai's commitlint config. Eats the dogfood
 * (`@wellmade/commitlint-config`).
 *
 * Atelier-ai has a fast cadence and a wide surface (skills, hooks,
 * templates, agents, the installer) — locking commit scopes to an
 * allow-list would be friction without payoff. We let any scope
 * through and rely on PR review for the "is this scope reasonable?"
 * call.
 *
 * Once the published @wellmade/commitlint-config 0.2.x lands (which
 * drops the default scope-enum and subject-case), the two overrides
 * below become no-ops and can be removed.
 *
 * @type {import('@commitlint/types').UserConfig}
 */
export default {
  extends: ['@wellmade/commitlint-config'],
  rules: {
    // The published 0.1.x default enumerates wellmade-package scopes
    // only. Atelier-ai's scopes (`configure-service`, `setup-project`,
    // skill names, etc.) aren't in that list. Disable the rule
    // entirely — any scope is fine, no scope is fine.
    'scope-enum': [0],

    // The published 0.1.x default rejects subjects with proper nouns
    // and acronyms (Claude, JSON, NestJS, ESLint, etc.) which we use
    // constantly in skill descriptions. Disable for the same reason
    // bedrock-js does — see that repo's commitlint.config.js comment
    // for the full rationale.
    'subject-case': [0],
  },
};
