# `_lib/`

Shared code consumed by multiple skills. Not a skill itself — the
underscore prefix signals "don't index this as a skill, it has no
`SKILL.md`."

When a skill in `atelier-ai/skills/` needs logic that another skill
also needs, factor it here. Keep modules small, single-purpose, and
free of agent-only assumptions so the same code can be lifted into
`@wellmade/cli` later.
