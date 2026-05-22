#!/usr/bin/env bash
# atelier-ai installer
#
# Clones (or updates) atelier-ai under ~/.atelier-ai/, then symlinks
# skills/agents/hooks into the agent config directory of your choice.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wellmade-studio/atelier-ai/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/wellmade-studio/atelier-ai/main/install.sh | bash -s -- --prefix ~/.cursor
#
# Flags:
#   --prefix <dir>   Target agent config dir. Default: ~/.claude
#   --only <kinds>   Comma-separated kinds to install (skills,agents,hooks). Default: all
#   --branch <name>  Branch or tag to install. Default: main
#   --uninstall      Remove only symlinks pointing into ~/.atelier-ai (leaves the clone)
#   -h, --help       Show this help

set -euo pipefail

REPO_URL="${ATELIER_AI_REPO:-https://github.com/wellmade-studio/atelier-ai.git}"
CLONE_DIR="${ATELIER_AI_DIR:-$HOME/.atelier-ai}"
PREFIX="$HOME/.claude"
KINDS="skills,agents,hooks"
BRANCH="main"
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2;;
    --only) KINDS="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --uninstall) UNINSTALL=1; shift;;
    -h|--help)
      awk 'NR==1 { next } /^# / { sub(/^# ?/, ""); print; next } /^#$/ { print ""; next } { exit }' "$0"
      exit 0;;
    *) echo "Unknown flag: $1" >&2; exit 1;;
  esac
done

note()  { printf '  %s\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_cmd git

# ── Uninstall path ──────────────────────────────────────────────────────────
if [[ "$UNINSTALL" == "1" ]]; then
  echo "Removing atelier-ai symlinks under $PREFIX…"
  for kind in skills agents hooks; do
    target_dir="$PREFIX/$kind"
    [[ -d "$target_dir" ]] || continue
    while IFS= read -r link; do
      [[ -L "$link" ]] || continue
      resolved="$(readlink "$link")"
      case "$resolved" in
        "$CLONE_DIR"/*) rm "$link" && note "removed $link";;
      esac
    done < <(find "$target_dir" -maxdepth 1 -mindepth 1 -type l 2>/dev/null)
  done
  ok "Uninstall complete. Clone at $CLONE_DIR left intact (remove manually if you want it gone)."
  exit 0
fi

# ── Clone or update ─────────────────────────────────────────────────────────
if [[ -d "$CLONE_DIR/.git" ]]; then
  echo "Updating atelier-ai at $CLONE_DIR…"
  git -C "$CLONE_DIR" fetch --quiet origin "$BRANCH"
  git -C "$CLONE_DIR" checkout --quiet "$BRANCH"
  git -C "$CLONE_DIR" pull --quiet --ff-only
  ok "Updated to latest $BRANCH"
else
  echo "Cloning atelier-ai into $CLONE_DIR…"
  git clone --quiet --branch "$BRANCH" --depth 1 "$REPO_URL" "$CLONE_DIR"
  ok "Cloned $REPO_URL ($BRANCH)"
fi

# ── Symlink each requested kind ─────────────────────────────────────────────
mkdir -p "$PREFIX"

IFS=',' read -ra KIND_LIST <<< "$KINDS"
linked=0
skipped=0

for kind in "${KIND_LIST[@]}"; do
  src_dir="$CLONE_DIR/$kind"
  dest_dir="$PREFIX/$kind"
  if [[ ! -d "$src_dir" ]]; then
    warn "Source missing: $src_dir (skipping)"
    continue
  fi
  mkdir -p "$dest_dir"
  echo "Linking $kind/ → $dest_dir/"
  for entry in "$src_dir"/*; do
    [[ -e "$entry" ]] || continue
    name="$(basename "$entry")"
    [[ "$name" == ".gitkeep" ]] && continue
    target="$dest_dir/$name"

    if [[ -L "$target" ]]; then
      current="$(readlink "$target")"
      if [[ "$current" == "$entry" ]]; then
        note "$name (already linked)"
        skipped=$((skipped+1))
        continue
      fi
      warn "$name exists as a symlink pointing elsewhere ($current) — leaving it"
      skipped=$((skipped+1))
      continue
    fi

    if [[ -e "$target" ]]; then
      warn "$name exists at $target (not a symlink) — leaving it. Move it aside to install."
      skipped=$((skipped+1))
      continue
    fi

    ln -s "$entry" "$target"
    ok "$name"
    linked=$((linked+1))
  done
done

echo
ok "Installed $linked, skipped $skipped"
echo "  Source: $CLONE_DIR"
echo "  Target: $PREFIX"
echo
echo "Re-run anytime to pull updates. Use --uninstall to remove symlinks."
