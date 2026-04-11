#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Erro: este diretorio nao esta em um repositorio Git." >&2
  exit 1
fi

git add -A

if git diff --cached --quiet; then
  echo "Sem alteracoes para backup."
  exit 0
fi

STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
git commit -m "Backup diario ${STAMP}"
git push origin main

echo "Backup diario enviado com sucesso."

