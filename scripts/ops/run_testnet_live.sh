#!/usr/bin/env bash
# IRMarket testnet live run — Monad testnet with verifier bot
#
# Bounded probe on the Monad testnet. Key objectives:
#   1. Pre-flight health gate — RPC reachable, contracts deployed, wallet funded
#   2. Run verifier bot for a bounded duration
#   3. Collect artifacts (logs, events) for analysis
#   4. No auto-flatten / cleanup — review leftovers manually
#
# Usage:  bash scripts/ops/run_testnet_live.sh
# Env:    TIMEOUT_S        run duration in seconds — MANDATORY
#         BOT_ENV_FILE     path to bot .env (default: bot/.env)
#         LOG_LEVEL        bot log level (default: INFO)
set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$(dirname "$0")/.." && pwd)")"
cd "$REPO"

# ── 0. TIMEOUT_S is MANDATORY ──────────────────────────────────────────────
if [ -z "${TIMEOUT_S:-}" ]; then
    echo "FATAL: TIMEOUT_S is required for a testnet live run (no default)." >&2
    echo "       Example: TIMEOUT_S=3600 bash scripts/ops/run_testnet_live.sh" >&2
    exit 1
fi
case "$TIMEOUT_S" in
    ''|*[!0-9]*)
        echo "FATAL: TIMEOUT_S must be a positive integer, got '$TIMEOUT_S'." >&2
        exit 1
        ;;
esac

BOT_ENV_FILE="${BOT_ENV_FILE:-bot/.env}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"
LOGDIR="docs/liverun/testnet"

mkdir -p "$LOGDIR"
STAMP=$(date -u +%Y%m%d_%H%M%S)
RUNNER_LOG="$LOGDIR/runner_${STAMP}.log"
exec > >(tee -a "$RUNNER_LOG") 2>&1

echo "===== IRMarket testnet live start $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
echo "HEAD=$(git rev-parse --short HEAD) branch=$(git branch --show-current)"
echo "TIMEOUT_S=$TIMEOUT_S BOT_ENV_FILE=$BOT_ENV_FILE LOG_LEVEL=$LOG_LEVEL"

# ── 1. Sanity: keys must be injected (never committed) ──────────────────────
if grep -q "0x_your_private_key_here" "$BOT_ENV_FILE"; then
    echo "[sanity] FATAL: PRIVATE_KEY is placeholder in $BOT_ENV_FILE — inject keys first. Aborting."
    exit 1
fi
echo "[sanity] keys present (not placeholders)"

# ── Export bot env vars ──────────────────────────────────────────────────────
set -a
# shellcheck disable=SC1090
source "$BOT_ENV_FILE"
set +a

# ── 2. Pre-flight health gate ───────────────────────────────────────────────
echo "--- pre-run health gate ---"
python scripts/ops/check_health.py --env-file "$BOT_ENV_FILE" || {
    echo "[gate] FATAL: pre-run health gate FAILED. Aborting."
    exit 1
}
echo "[gate] PASS"

# ── 3. Stop prior daemon (by module path, not generic pattern) ──────────────
pgrep -af "bot/verifier.py" | awk '{print $1}' | xargs -r kill 2>/dev/null || true
sleep 2

# ── 4. Run the bounded probe ────────────────────────────────────────────────
echo "--- run ${TIMEOUT_S}s probe ---"
export TIMEOUT_S
BOT_ENV_FILE="$BOT_ENV_FILE" LOG_LEVEL="$LOG_LEVEL" \
    python scripts/ops/run_with_timeout.py --timeout "$TIMEOUT_S" --log-level "$LOG_LEVEL" \
    2>&1 | tee "$LOGDIR/console_${STAMP}.log" || echo "[run] run_with_timeout exit=$? (expected if timeout)"

# ── 5. Collect artifacts ────────────────────────────────────────────────────
echo "--- collecting artifacts ---"
cp -a irmarket_run.log "$LOGDIR/" 2>/dev/null || true
cp -a irmarket_*.log "$LOGDIR/" 2>/dev/null || true

if [ -f irmarket_run.log ]; then
    python scripts/ops/analyze_run.py verdict irmarket_run.log > "$LOGDIR/verdict_${STAMP}.txt" 2>&1 || true
    echo "[artifacts] wrote $LOGDIR/verdict_${STAMP}.txt"
else
    echo "[artifacts] WARN: no irmarket_run.log — bot produced no log"
fi

echo "===== IRMarket testnet live end $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
echo "logs in $LOGDIR"
