#!/usr/bin/env bash
# Run Clay against a throwaway HOME so testing never touches the real
# ~/.clay, ~/.clayrc, or ~/.clay-dev directories of the developer machine.
#
# Why all this? Clay persists state in three places:
#   1. ~/.clay/...        (CLAY_HOME — daemon config, sessions, sockets)
#   2. ~/.clayrc          (recent-projects list — hard-coded to os.homedir())
#   3. ~/.clay/certs/     (mkcert HTTPS certs)
#
# CLAY_HOME redirects (1) and (3), but ~/.clayrc only follows HOME. So we
# redirect both. ~/.codex/auth.json is symlinked into the fake HOME so the
# Codex backend can still find your real login.
#
# Default port is 2637 (avoids prod 2633 and dev 2635). Override with PORT=...
# Default test HOME is /tmp/clay-codex-test. Override with TESTHOME=...
#
# Usage:
#   scripts/dev-isolated.sh                # start daemon foreground-ish, tail logs
#   scripts/dev-isolated.sh --shutdown     # stop the isolated daemon
#   scripts/dev-isolated.sh --clean        # shutdown + remove temp HOME
#   PORT=9000 scripts/dev-isolated.sh ...  # custom port
set -euo pipefail

REAL_HOME="${REAL_HOME:-$HOME}"
TESTHOME="${TESTHOME:-/tmp/clay-codex-test}"
PORT="${PORT:-2637}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO_ROOT/bin/cli.js"

mode="start"
extra_args=()
for arg in "$@"; do
  case "$arg" in
    --shutdown) mode="shutdown" ;;
    --clean)    mode="clean" ;;
    --status)   mode="status" ;;
    *)          extra_args+=("$arg") ;;
  esac
done

ensure_testhome() {
  mkdir -p "$TESTHOME/.clay"
  # Symlink Codex auth so the backend can find ~/.codex/auth.json without
  # forcing the user to re-login under the fake HOME. If REAL_HOME has no
  # .codex dir yet, leave it absent — checkCodexAuth() will surface the
  # right "not logged in" hint to the UI.
  if [[ ! -e "$TESTHOME/.codex" && -e "$REAL_HOME/.codex" ]]; then
    ln -s "$REAL_HOME/.codex" "$TESTHOME/.codex"
  fi
}

run_cli() {
  HOME="$TESTHOME" CLAY_HOME="$TESTHOME/.clay" \
    node "$CLI" "$@"
}

case "$mode" in
  start)
    ensure_testhome
    echo "[isolated] HOME=$TESTHOME CLAY_HOME=$TESTHOME/.clay PORT=$PORT"
    echo "[isolated] daemon log: $TESTHOME/.clay/daemon.log"
    # --headless: daemon detaches; CLI exits after spawn.
    # -y         : skip interactive prompts.
    # We then tail the log so you can see daemon output until Ctrl-C.
    run_cli --port "$PORT" --no-https --no-update --debug --headless -y "${extra_args[@]}" || {
      echo "[isolated] daemon failed to start" >&2
      exit 1
    }
    LOG_FILE="$TESTHOME/.clay/daemon.log"
    # Wait briefly for the file to appear so tail doesn't error.
    for _ in 1 2 3 4 5; do
      [[ -f "$LOG_FILE" ]] && break
      sleep 0.2
    done
    echo "[isolated] open: http://localhost:$PORT/"
    echo "[isolated] tailing log (Ctrl-C to stop tailing; daemon keeps running)"
    exec tail -F "$LOG_FILE"
    ;;
  shutdown)
    if [[ ! -d "$TESTHOME/.clay" ]]; then
      echo "[isolated] nothing to shut down ($TESTHOME absent)"
      exit 0
    fi
    run_cli --shutdown || true
    ;;
  clean)
    if [[ -d "$TESTHOME/.clay" ]]; then
      run_cli --shutdown || true
    fi
    # Resolve symlinks before rm so we never recurse into real ~/.codex.
    if [[ -L "$TESTHOME/.codex" ]]; then rm -f "$TESTHOME/.codex"; fi
    rm -rf "$TESTHOME"
    echo "[isolated] removed $TESTHOME"
    ;;
  status)
    if [[ ! -d "$TESTHOME/.clay" ]]; then
      echo "[isolated] no isolated env at $TESTHOME"; exit 0
    fi
    run_cli --list || true
    ;;
esac
