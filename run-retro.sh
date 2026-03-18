#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "${ROOT_DIR}/bin/team-retro.js" "$@"
