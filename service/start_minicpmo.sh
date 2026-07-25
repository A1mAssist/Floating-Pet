#!/usr/bin/env bash
set -eo pipefail

source /usr/local/Ascend/ascend-toolkit/set_env.sh
for env_script in /usr/local/Ascend/cann-*/share/info/ascendnpu-ir/bin/set_env.sh; do
  if [[ -r "$env_script" ]]; then
    source "$env_script"
    break
  fi
done
source /usr/local/Ascend/nnal/atb/set_env.sh

for driver_lib in /usr/local/Ascend/driver/lib64/common /usr/local/Ascend/driver/lib64/driver; do
  if [[ -d "$driver_lib" ]]; then
    export LD_LIBRARY_PATH="$driver_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi
done
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${LD_PRELOAD:-}" ]]; then
  for jemalloc in /usr/lib/aarch64-linux-gnu/libjemalloc.so.2 /usr/lib64/libjemalloc.so.2; do
    if [[ -r "$jemalloc" ]]; then
      export LD_PRELOAD="$jemalloc"
      break
    fi
  done
fi
export PYTHONPATH="$ROOT/compat${PYTHONPATH:+:$PYTHONPATH}"
export PYTORCH_NPU_ALLOC_CONF=expandable_segments:True
if [[ -z "${MINICPM_MODEL_DIR:-}" ]]; then
  for model_candidate in \
    "${HOME:-}/volume/notebook/models/MiniCPMO45" \
    /workspace/user_data/models/MiniCPMO45; do
    if [[ -d "$model_candidate" ]]; then
      MINICPM_MODEL_DIR="$model_candidate"
      break
    fi
  done
fi
export MINICPM_MODEL_DIR="${MINICPM_MODEL_DIR:-/workspace/user_data/models/MiniCPMO45}"
export MINICPM_SERVED_MODEL_NAME="${MINICPM_SERVED_MODEL_NAME:-cpmo}"
export MINICPM_MODE="${MINICPM_MODE:-chat}"
if [[ -n "${MINICPM_PYTHON:-}" ]]; then
  PYTHON_BIN="$MINICPM_PYTHON"
else
  PYTHON_BIN=""
  for python_candidate in \
    /workspace/minicpmo45-venv/bin/python \
    "${HOME:-}/volume/notebook/minicpmo45-venv/bin/python" \
    /usr/local/python3.11.13/bin/python3; do
    if [[ -x "$python_candidate" ]]; then
      PYTHON_BIN="$python_candidate"
      break
    fi
  done
fi

if [[ -z "$PYTHON_BIN" ]]; then
  printf 'Set MINICPM_PYTHON to a Python executable with the service dependencies\n' >&2
  exit 2
fi

case "$MINICPM_MODE" in
  chat|duplex) ;;
  *) printf 'MINICPM_MODE must be chat or duplex\n' >&2; exit 2 ;;
esac

exec "$PYTHON_BIN" -m uvicorn minicpmo_server:create_app --factory \
  --app-dir "$ROOT" --host 127.0.0.1 --port "${MINICPM_PORT:-8000}"
