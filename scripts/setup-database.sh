#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  printf 'Usage: bash scripts/setup-database.sh [--skip-install]\n'
}

skip_install=false
case "${1:-}" in
  '') ;;
  --skip-install) skip_install=true ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 1 ;;
esac
if (( $# > 1 )); then
  usage >&2
  exit 1
fi
if (( EUID == 0 )); then
  printf 'Run setup as the app user, not root or sudo.\n' >&2
  exit 1
fi

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$root"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  printf 'Install Node.js 20.19+ (or 22.12+) with npm, then rerun setup.\n' >&2
  exit 1
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24 ? 0 : 1)'; then
  printf 'Use Node.js 20.19+, 22.12+, or a newer supported LTS release.\n' >&2
  exit 1
fi
if [[ "$skip_install" == false ]]; then
  printf 'Installing locked workspace dependencies using npm 10...\n'
  npx --yes npm@10 ci --include=dev
fi
if [[ ! -x node_modules/.bin/tsx ]]; then
  printf 'Dependencies are missing. Rerun setup without --skip-install.\n' >&2
  exit 1
fi

printf 'Initializing database with the existing storage migrations...\n'
node_modules/.bin/tsx scripts/setup-database.ts