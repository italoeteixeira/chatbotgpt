#!/usr/bin/env bash
set -Eeuo pipefail

# Sincronizacao bidirecional sem remocao:
# - puxa remoto -> local PRIMEIRO (bot pode se auto-editar no servidor)
# - depois envia local -> remoto
# - somente add/atualizacao, nunca usa --delete
# - quando sobrescreve, gera backup com sufixo .syncbak-<timestamp>

LOCAL_DIR="${LOCAL_DIR:-$(pwd)}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_HOST="${REMOTE_HOST:-191.252.159.213}"
REMOTE_DIR="${REMOTE_DIR:-/opt/chatbot}"
REMOTE_PASS="${REMOTE_PASS:-}"
KNOWN_HOSTS_FILE="${KNOWN_HOSTS_FILE:-/tmp/chatbot_sync_known_hosts}"
DATE_TAG="${DATE_TAG:-$(date +%Y%m%d-%H%M%S)}"
REPORT_ROOT="${REPORT_ROOT:-$LOCAL_DIR/sync/reports/$DATE_TAG}"

if ! command -v rsync >/dev/null 2>&1; then
  echo "Erro: rsync nao encontrado." >&2
  exit 1
fi

if ! command -v sshpass >/dev/null 2>&1; then
  echo "Erro: sshpass nao encontrado." >&2
  exit 1
fi

if [[ -z "$REMOTE_PASS" ]]; then
  echo "Erro: defina REMOTE_PASS para autenticar no servidor remoto." >&2
  echo "Exemplo:" >&2
  echo "  REMOTE_PASS='NAOsei123@' bash scripts/sync-local-remote-merge.sh" >&2
  exit 1
fi

if [[ ! -d "$LOCAL_DIR" ]]; then
  echo "Erro: LOCAL_DIR nao existe: $LOCAL_DIR" >&2
  exit 1
fi

mkdir -p "$REPORT_ROOT"

SSH_CMD="sshpass -p $(printf '%q' "$REMOTE_PASS") ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$(printf '%q' "$KNOWN_HOSTS_FILE")"
REMOTE_TARGET="${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR%/}/"
LOCAL_TARGET="${LOCAL_DIR%/}/"

# Excludes padrao para evitar artefatos volateis/sessao
EXCLUDES=(
  "node_modules/"
  ".wwebjs_auth/"
  ".wwebjs_auth_validacao/"
  ".wwebjs_cache/"
  "logs/"
  "sync/"
  ".sync_backups/"
  "*.syncbak-*"
  "tools/whisper.cpp/.git/"
)

EXCLUDE_ARGS=()
for item in "${EXCLUDES[@]}"; do
  EXCLUDE_ARGS+=(--exclude "$item")
done

echo "[1/6] Garantindo pasta remota: $REMOTE_DIR"
$SSH_CMD "$REMOTE_USER@$REMOTE_HOST" "mkdir -p $(printf '%q' "$REMOTE_DIR")"

run_dry() {
  local src="$1"
  local dst="$2"
  local out_file="$3"
  rsync -a -n --update --checksum --itemize-changes \
    --omit-dir-times --no-owner --no-group --no-perms \
    "${EXCLUDE_ARGS[@]}" \
    -e "$SSH_CMD" \
    "$src" "$dst" > "$out_file"
}

run_sync() {
  local src="$1"
  local dst="$2"
  local out_file="$3"
  rsync -a --update --checksum --itemize-changes --partial \
    --omit-dir-times --no-owner --no-group --no-perms \
    --backup --backup-dir ".sync_backups/$DATE_TAG" \
    "${EXCLUDE_ARGS[@]}" \
    -e "$SSH_CMD" \
    "$src" "$dst" | tee "$out_file"
}

echo "[2/6] Dry-run remoto -> local (puxar primeiro)"
run_dry "$REMOTE_TARGET" "$LOCAL_TARGET" "$REPORT_ROOT/dry-remote-to-local.txt"

echo "[3/6] Dry-run local -> remoto"
run_dry "$LOCAL_TARGET" "$REMOTE_TARGET" "$REPORT_ROOT/dry-local-to-remote.txt"

echo "[4/6] Sync remoto -> local (puxar primeiro)"
run_sync "$REMOTE_TARGET" "$LOCAL_TARGET" "$REPORT_ROOT/sync-remote-to-local.txt"

echo "[5/6] Sync local -> remoto"
run_sync "$LOCAL_TARGET" "$REMOTE_TARGET" "$REPORT_ROOT/sync-local-to-remote.txt"

echo "[6/6] Verificacao final"
run_dry "$LOCAL_TARGET" "$REMOTE_TARGET" "$REPORT_ROOT/final-local-to-remote.txt"
run_dry "$REMOTE_TARGET" "$LOCAL_TARGET" "$REPORT_ROOT/final-remote-to-local.txt"

printf '\nResumo de diferencas e sincronizacao\n'
wc -l \
  "$REPORT_ROOT/dry-local-to-remote.txt" \
  "$REPORT_ROOT/dry-remote-to-local.txt" \
  "$REPORT_ROOT/sync-local-to-remote.txt" \
  "$REPORT_ROOT/sync-remote-to-local.txt" \
  "$REPORT_ROOT/final-local-to-remote.txt" \
  "$REPORT_ROOT/final-remote-to-local.txt"

cat <<MSG

Concluido.
Relatorios em:
  $REPORT_ROOT

Arquivos relevantes:
  - dry-local-to-remote.txt
  - dry-remote-to-local.txt
  - sync-local-to-remote.txt
  - sync-remote-to-local.txt
  - final-local-to-remote.txt
  - final-remote-to-local.txt

Observacao:
  - Nao houve remocao de arquivos (sem --delete).
  - Quando houve sobrescrita, backup foi mantido em .sync_backups/$DATE_TAG no destino.
MSG
