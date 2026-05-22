#!/usr/bin/env bash
# lint-on-edit — PostToolUse hook for Edit/Write/MultiEdit.
#
# Receives the agent's tool-call JSON on stdin, extracts the file path,
# runs eslint --fix + prettier --write on just that file, and reports
# any remaining errors back to the agent without blocking the tool call.
#
# Wire this into ~/.claude/settings.json (or your agent's equivalent):
#
#   {
#     "hooks": {
#       "PostToolUse": [
#         {
#           "matcher": "Edit|Write|MultiEdit",
#           "hooks": [{ "type": "command", "command": "$HOME/.claude/hooks/lint-on-edit.sh" }]
#         }
#       ]
#     }
#   }
#
# Designed to be agent-agnostic: reads the file path from the JSON
# payload's tool_input.file_path (Claude Code's convention). For other
# agents, set ATELIER_AI_FILE_PATH_JQ to a different jq filter.

set -euo pipefail

FILE_PATH_FILTER="${ATELIER_AI_FILE_PATH_JQ:-.tool_input.file_path // .tool_input.path // empty}"

# Read the hook payload from stdin. If jq isn't available, fall back to
# a minimal grep-based parser (works for the simple case).
payload="$(cat)"

extract_file_path() {
  if command -v jq >/dev/null 2>&1; then
    jq -r "$FILE_PATH_FILTER" <<< "$payload" 2>/dev/null
  else
    # Crude fallback: grab the first "file_path" value
    sed -nE 's/.*"file_path"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' <<< "$payload" | head -n1
  fi
}

file_path="$(extract_file_path)"

# Silently skip if there's no path or the file no longer exists
# (e.g. the tool deleted it).
[[ -z "${file_path:-}" ]] && exit 0
[[ -f "$file_path" ]] || exit 0

# Find the project root (closest ancestor with a package.json).
find_project_root() {
  local dir
  dir="$(dirname "$file_path")"
  while [[ "$dir" != "/" && "$dir" != "." ]]; do
    if [[ -f "$dir/package.json" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

project_root="$(find_project_root || true)"
[[ -z "${project_root:-}" ]] && exit 0
cd "$project_root"

# Only act on files this toolchain knows how to handle.
case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.astro|*.vue|*.svelte|*.json|*.md|*.css|*.scss|*.html|*.yml|*.yaml) ;;
  *) exit 0;;
esac

# Skip if the project doesn't have the relevant tools.
has_eslint="$(test -d node_modules/eslint && echo 1 || echo 0)"
has_prettier="$(test -d node_modules/prettier && echo 1 || echo 0)"
[[ "$has_eslint" == "0" && "$has_prettier" == "0" ]] && exit 0

errors=""
ran=""

# Lint pass — auto-fix what we can, capture what we can't.
if [[ "$has_eslint" == "1" ]]; then
  case "$file_path" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.astro|*.vue|*.svelte)
      ran="${ran}eslint "
      if ! eslint_out="$(npx --no-install eslint --fix "$file_path" 2>&1)"; then
        errors="${errors}${eslint_out}"$'\n'
      fi
      ;;
  esac
fi

# Format pass — prettier handles JSON/MD/YAML too, so this runs broadly.
if [[ "$has_prettier" == "1" ]]; then
  ran="${ran}prettier "
  if ! prettier_out="$(npx --no-install prettier --write "$file_path" 2>&1)"; then
    errors="${errors}${prettier_out}"$'\n'
  fi
fi

# If there are remaining errors, surface them to the agent via stderr
# with exit code 2 — Claude Code's convention for "show this to the
# model without blocking." For agents that don't support this, the
# message still appears in the transcript.
if [[ -n "${errors:-}" ]]; then
  printf 'Lint/format check on %s reported:\n%s\n' "$file_path" "$errors" >&2
  exit 2
fi

exit 0
