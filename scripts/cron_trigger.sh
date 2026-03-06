#!/bin/sh
# cron_trigger.sh — Chamado pelo crontab do sistema para disparar ações do bot.
# Uso: cron_trigger.sh <job_id>
#
# Lê a definição do job de /data/cron_jobs.json (via jq),
# escreve um arquivo trigger em /data/cron_triggers/ para o bot processar.

JOB_ID="$1"
DATA_DIR="${DATA_DIR:-/data}"
TRIGGER_DIR="${DATA_DIR}/cron_triggers"
JOBS_FILE="${DATA_DIR}/cron_jobs.json"

if [ -z "$JOB_ID" ]; then
    echo "ERROR: job_id não informado" >&2
    exit 1
fi

mkdir -p "$TRIGGER_DIR"

if [ ! -f "$JOBS_FILE" ]; then
    echo "ERROR: Arquivo de jobs não encontrado: $JOBS_FILE" >&2
    exit 1
fi

# Extrair dados do job via jq
JOB_DATA=$(jq -e --arg id "$JOB_ID" '[.[] | select(.id == $id)][0]' "$JOBS_FILE" 2>/dev/null)

if [ $? -ne 0 ] || [ "$JOB_DATA" = "null" ]; then
    echo "ERROR: Job não encontrado: $JOB_ID" >&2
    exit 1
fi

# Escrever arquivo trigger com timestamp para unicidade
TIMESTAMP=$(date +%s)
TRIGGER_FILE="${TRIGGER_DIR}/${TIMESTAMP}-${JOB_ID}.json"

echo "$JOB_DATA" > "$TRIGGER_FILE"
