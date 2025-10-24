#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PB_TEMPLATES_DIR="${ROOT_DIR}/config/templates"

# Prefer portable Node runtime if present
PORTABLE_NODE="${ROOT_DIR}/mcp-sandbox/runtimes/nodejs/bin/node"
if [[ -x "${PORTABLE_NODE}" ]]; then
  NODE_BIN="${PORTABLE_NODE}"
else
  NODE_BIN="node"
fi

if [[ ! -d "${ROOT_DIR}/dist" ]]; then
  echo "[build] Compiling TypeScript..."
  npm --prefix "${ROOT_DIR}" run build
fi

exec "${NODE_BIN}" "${ROOT_DIR}/dist/index.js"

