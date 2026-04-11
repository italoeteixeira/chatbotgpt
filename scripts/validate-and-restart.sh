#!/usr/bin/env bash
# validate-and-restart.sh
# Executa npm run check e, se OK, reinicia o bot de forma controlada.
# Uso: bash scripts/validate-and-restart.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
VALIDATION_LOG="${LOG_DIR}/last-validation.json"
RESTART_LOG="${LOG_DIR}/restart.log"

mkdir -p "${LOG_DIR}"

echo "[validate-and-restart] Iniciando validacao tecnica em ${ROOT_DIR}"
cd "${ROOT_DIR}"

VALIDATION_OUTPUT=""
VALIDATION_OK=false
VALIDATION_STATUS=""

if npm run check 2>&1; then
  VALIDATION_OK=true
  VALIDATION_STATUS="exit 0"
  echo "[validate-and-restart] Validacao OK."
else
  VALIDATION_STATUS="exit $?"
  echo "[validate-and-restart] Validacao FALHOU (${VALIDATION_STATUS}). Reinicio cancelado." >&2
fi

# Persiste resultado da validacao
cat > "${VALIDATION_LOG}" << JSONEOF
{
  "ts": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "ok": ${VALIDATION_OK},
  "status": "${VALIDATION_STATUS}",
  "summary": "Validacao manual via validate-and-restart.sh",
  "output": "(consultar logs do terminal)",
  "willRestart": ${VALIDATION_OK}
}
JSONEOF

if [ "${VALIDATION_OK}" != "true" ]; then
  exit 1
fi

# Reinicio controlado: encerra processo atual e inicia novo
BOT_PID="$(pgrep -f 'node src/index.js' || true)"
if [ -n "${BOT_PID}" ]; then
  echo "[validate-and-restart] Encerrando PID ${BOT_PID}..."
  kill "${BOT_PID}" 2>/dev/null || true
  sleep 2
fi

echo "[validate-and-restart] Iniciando bot..."
nohup bash scripts/start-safe.sh >> "${RESTART_LOG}" 2>&1 &
echo "[validate-and-restart] Bot reiniciado. PID do processo novo sera registrado em ${RESTART_LOG}"
