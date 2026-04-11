#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Erro: este diretorio nao esta em um repositorio Git." >&2
  exit 1
fi

echo "Iniciando plano de backup validado (com README auto e push GitHub)..."
npm run backup:validated

echo "Plano de backup validado concluido."
