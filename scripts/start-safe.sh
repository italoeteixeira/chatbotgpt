#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_DIR="${ROOT_DIR}/.wwebjs_auth/session-grupo-autorizado"
LOCK_FILE="${ROOT_DIR}/data/.bot.lock"

kill_orphaned_session_chrome() {
  local pattern
  pattern="chrome.*--user-data-dir=${SESSION_DIR}"
  local pids
  pids="$(pgrep -f "${pattern}" || true)"
  if [[ -z "${pids}" ]]; then
    return 0
  fi

  while IFS= read -r pid; do
    [[ -z "${pid}" ]] && continue
    kill -9 "${pid}" 2>/dev/null || true
  done <<< "${pids}"
}

clear_session_locks() {
  [[ -d "${SESSION_DIR}" ]] || return 0
  rm -f \
    "${SESSION_DIR}/SingletonLock" \
    "${SESSION_DIR}/SingletonSocket" \
    "${SESSION_DIR}/SingletonCookie" \
    "${SESSION_DIR}/DevToolsActivePort"
}

mkdir -p "$(dirname "${LOCK_FILE}")"
exec 9>"${LOCK_FILE}"

if ! flock -n 9; then
  echo "Outra instancia do bot ja esta em execucao. Abortando novo start." >&2
  exit 0
fi

kill_orphaned_session_chrome
clear_session_locks

cd "${ROOT_DIR}"
exec node src/index.js
