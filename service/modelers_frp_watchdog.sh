#!/usr/bin/env bash

set -u
umask 077

state_dir="${MODELERS_FRP_STATE_DIR:-${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-frp}"
runtime_dir="${MODELERS_FRP_RUNTIME_DIR:-$HOME/.modelers-frp-runtime}"
check_interval="${MODELERS_FRP_CHECK_INTERVAL:-300}"
keepalive_every="${MODELERS_FRP_KEEPALIVE_EVERY:-6}"
curl_bin="${MODELERS_FRP_CURL_BIN:-/usr/bin/curl}"

max_log_size=5242880
sleep_pid=''

mode=run
case "${1:-}" in
  '') ;;
  --once) mode=once ;;
  --stop) mode=stop ;;
  *)
    printf 'Usage: %s [--once|--stop]\n' "$0" >&2
    exit 2
    ;;
esac
if [ "$#" -gt 1 ]; then
  printf 'Usage: %s [--once|--stop]\n' "$0" >&2
  exit 2
fi

mkdir -p "$state_dir" "$runtime_dir"
# Normalize volume paths before deriving identity-sensitive process paths. Some
# Modelers images expose NOTEBOOK_DIR with a trailing slash, while /proc uses
# canonical paths for the executable link.
state_dir="$(readlink -f "$state_dir" 2>/dev/null || printf '%s\n' "$state_dir")"
runtime_dir="$(readlink -f "$runtime_dir" 2>/dev/null || printf '%s\n' "$runtime_dir")"
chmod 700 "$state_dir" "$runtime_dir"
frpc_bin="$state_dir/bin/frpc"
persistent_config="$state_dir/frpc.toml"
public_url_file="$state_dir/modelers-public-url.txt"
runtime_config="$runtime_dir/frpc.toml"
frpc_pidfile="$runtime_dir/frpc.pid"
watchdog_pidfile="$runtime_dir/watchdog.pid"
watchdog_lock="$runtime_dir/watchdog.lock"
lifecycle_lock="$runtime_dir/watchdog.lifecycle.lock"
frpc_log="$state_dir/frpc.log"
watchdog_log="$state_dir/watchdog.log"
script_path="$(readlink -f "$0" 2>/dev/null || printf '%s\n' "$0")"

read_pid() {
  local pidfile="$1" pid
  [ -r "$pidfile" ] || return 1
  IFS= read -r pid < "$pidfile" || [ -n "$pid" ] || return 1
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$pid" -gt 1 ] 2>/dev/null || return 1
  printf '%s\n' "$pid"
}

process_has_arg() {
  local pid="$1" expected="$2"
  [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\0' '\n' < "/proc/$pid/cmdline" | grep -Fxq -- "$expected"
}

frpc_is_ours() {
  local pid="$1" exe
  [ -r "/proc/$pid/exe" ] || return 1
  exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
  case "$exe" in
    "$frpc_bin"|"$frpc_bin (deleted)") ;;
    *) return 1 ;;
  esac
  process_has_arg "$pid" "$runtime_config"
}

find_frpc_pids() {
  local proc_dir pid
  for proc_dir in /proc/[0-9]*; do
    [ -d "$proc_dir" ] || continue
    pid="${proc_dir#/proc/}"
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    [ "$pid" -gt 1 ] 2>/dev/null || continue
    [ "$pid" != "$$" ] || continue
    if frpc_is_ours "$pid"; then
      printf '%s\n' "$pid"
    fi
  done
}

find_frpc_pid() {
  local pid
  pid="$(find_frpc_pids | head -n 1)"
  if [ -n "$pid" ]; then
    printf '%s\n' "$pid"
    return 0
  fi
  return 1
}

watchdog_is_ours() {
  local pid="$1" exe arg0 arg1 cwd candidate
  [ -r "/proc/$pid/exe" ] || return 1
  [ -r "/proc/$pid/cmdline" ] || return 1
  exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
  case "$exe" in
    */bash) ;;
    *) return 1 ;;
  esac
  {
    IFS= read -r -d '' arg0 || return 1
    IFS= read -r -d '' arg1 || return 1
  } < "/proc/$pid/cmdline"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  case "$arg1" in
    /*) candidate="$(readlink -f "$arg1" 2>/dev/null || true)" ;;
    *) candidate="$(readlink -f "$cwd/$arg1" 2>/dev/null || true)" ;;
  esac
  [ -n "$candidate" ] && [ "$candidate" = "$script_path" ]
}

rotate_log() {
  local log="$1" size
  [ -f "$log" ] || return 0
  size="$(wc -c < "$log" 2>/dev/null)" || return 0
  case "$size" in
    ''|*[!0-9]*) return 0 ;;
  esac
  if [ "$size" -gt "$max_log_size" ]; then
    cp -f "$log" "$log.1" && : > "$log"
  fi
}

log_event() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$watchdog_log"
}

write_pid() {
  local pidfile="$1" pid="$2" tmp="$1.tmp.$$"
  if printf '%s\n' "$pid" > "$tmp" && chmod 600 "$tmp"; then
    mv -f "$tmp" "$pidfile"
  else
    rm -f "$tmp"
    return 1
  fi
}

remove_pidfile_if_matches() {
  local pidfile="$1" expected="$2" current
  current="$(read_pid "$pidfile" 2>/dev/null || true)"
  [ "$current" = "$expected" ] && rm -f "$pidfile"
}

stop_pid() {
  local kind="$1" pidfile="$2" pid check="$3" attempt
  pid="$(read_pid "$pidfile" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    rm -f "$pidfile"
    return 0
  fi
  if ! "$check" "$pid"; then
    remove_pidfile_if_matches "$pidfile" "$pid"
    log_event "action=stop target=$kind status=identity_mismatch"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  attempt=0
  while "$check" "$pid" && [ "$attempt" -lt 50 ]; do
    sleep 0.1
    attempt=$((attempt + 1))
  done
  if "$check" "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  remove_pidfile_if_matches "$pidfile" "$pid"
  log_event "action=stop target=$kind status=stopped"
}

stop_all() {
  local pid
  rotate_log "$watchdog_log"
  rotate_log "$frpc_log"
  stop_pid watchdog "$watchdog_pidfile" watchdog_is_ours
  # Recover from a lost pidfile, and stop any additional matching instance
  # without touching unrelated FRPC processes.
  while IFS= read -r pid; do
    kill "$pid" 2>/dev/null || true
    sleep 0.1
    if frpc_is_ours "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    log_event "action=stop target=frpc status=stopped pid=$pid"
  done < <(find_frpc_pids 2>/dev/null || true)
  rm -f "$frpc_pidfile"
}

normalize_positive_integer() {
  local value="$1"
  case "$value" in
    ''|*[!0-9]*) return 1 ;;
  esac
  while [ "${value#0}" != "$value" ]; do
    value="${value#0}"
  done
  [ -n "$value" ] && [ "$value" -gt 0 ] 2>/dev/null || return 1
  printf '%s\n' "$value"
}

if [ "$mode" != stop ]; then
  check_interval="$(normalize_positive_integer "$check_interval" 2>/dev/null || true)"
  keepalive_every="$(normalize_positive_integer "$keepalive_every" 2>/dev/null || true)"
  if [ -z "$check_interval" ] || [ -z "$keepalive_every" ]; then
    printf 'MODELERS_FRP_CHECK_INTERVAL and MODELERS_FRP_KEEPALIVE_EVERY must be positive integers\n' >&2
    exit 2
  fi
fi

exec 8> "$lifecycle_lock"
if ! flock 8; then
  printf 'failed to acquire modelers frp lifecycle lock\n' >&2
  exit 1
fi
if [ "$mode" = stop ]; then
  stop_all
  exit 0
fi

exec 9> "$watchdog_lock"
if ! flock -n 9; then
  printf 'modelers frp watchdog is already running\n' >&2
  exit 0
fi

if ! write_pid "$watchdog_pidfile" "$$"; then
  printf 'failed to write modelers frp watchdog pid\n' >&2
  exit 1
fi
flock -u 8
exec 8>&-
cleanup() {
  local pid
  pid="$(read_pid "$watchdog_pidfile" 2>/dev/null || true)"
  [ "$pid" = "$$" ] && rm -f "$watchdog_pidfile"
  rm -f "$runtime_config.tmp.$$"
}
shutdown() {
  local pid attempt
  if [ -n "$sleep_pid" ]; then
    kill "$sleep_pid" 2>/dev/null || true
    wait "$sleep_pid" 2>/dev/null || true
    sleep_pid=''
  fi
  pid="$(read_pid "$frpc_pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && frpc_is_ours "$pid"; then
    kill "$pid" 2>/dev/null || true
    attempt=0
    while frpc_is_ours "$pid" && [ "$attempt" -lt 50 ]; do
      sleep 0.1
      attempt=$((attempt + 1))
    done
    if frpc_is_ours "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    log_event "action=stop target=frpc status=watchdog_shutdown pid=$pid"
  fi
  remove_pidfile_if_matches "$frpc_pidfile" "$pid"
  exit 0
}
trap cleanup EXIT
trap shutdown HUP INT TERM

check_frpc() {
  local pid tmp new_pid verify_status
  pid="$(read_pid "$frpc_pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && frpc_is_ours "$pid"; then
    log_event "action=frpc_check status=healthy pid=$pid"
    return 0
  fi
  if [ -n "$pid" ]; then
    rm -f "$frpc_pidfile"
    log_event "action=frpc_check status=stale_pid"
  fi

  pid="$(find_frpc_pid 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    if write_pid "$frpc_pidfile" "$pid"; then
      log_event "action=frpc_check status=adopted pid=$pid"
    else
      log_event "action=frpc_check status=healthy pid=$pid"
    fi
    return 0
  fi

  if [ ! -x "$frpc_bin" ]; then
    log_event "action=frpc_start status=waiting reason=missing_binary"
    return 0
  fi
  if [ ! -f "$persistent_config" ]; then
    log_event "action=frpc_start status=waiting reason=missing_config"
    return 0
  fi
  if grep -Eq 'FRPS_HOST|FRPS_PORT|FRPS_TOKEN|REMOTE_PORT|STCP_SECRET' "$persistent_config"; then
    log_event "action=frpc_start status=waiting reason=placeholder_config"
    return 0
  fi

  tmp="$runtime_config.tmp.$$"
  rm -f "$tmp"
  if ! cp "$persistent_config" "$tmp" || ! chmod 600 "$tmp" || ! mv -f "$tmp" "$runtime_config"; then
    rm -f "$tmp"
    log_event "action=frpc_start status=failed reason=config_copy"
    return 0
  fi

  if [ ! -x /usr/bin/timeout ]; then
    log_event "action=frpc_verify status=failed reason=missing_timeout exit_code=127"
    return 0
  fi
  /usr/bin/timeout -k 5 15 "$frpc_bin" verify -c "$runtime_config" >/dev/null 2>&1 9>&-
  verify_status=$?
  if [ "$verify_status" -ne 0 ]; then
    log_event "action=frpc_verify status=failed exit_code=$verify_status"
    return 0
  fi
  log_event "action=frpc_verify status=ok exit_code=0"

  nohup "$frpc_bin" -c "$runtime_config" >> "$frpc_log" 2>&1 < /dev/null 9>&- &
  new_pid=$!
  if write_pid "$frpc_pidfile" "$new_pid"; then
    log_event "action=frpc_start status=started pid=$new_pid"
  else
    kill "$new_pid" 2>/dev/null || true
    log_event "action=frpc_start status=failed reason=pidfile"
  fi
}

run_public_keepalive() {
  local public_url='' http_code curl_status
  if [ ! -r "$public_url_file" ]; then
    log_event "action=keepalive_public status=waiting reason=missing_url"
    return 0
  fi
  IFS= read -r public_url < "$public_url_file" || true
  public_url="${public_url%$'\r'}"
  case "$public_url" in
    https://*) ;;
    *)
      log_event "action=keepalive_public status=waiting reason=invalid_url"
      return 0
      ;;
  esac
  if [ ! -x "$curl_bin" ]; then
    log_event "action=keepalive_public status=failed reason=missing_curl exit_code=127 http_code=000"
    return 0
  fi

  http_code="$("$curl_bin" -L -sS -o /dev/null -w '%{http_code}' --max-time 20 "$public_url" 2>/dev/null 9>&-)"
  curl_status=$?
  case "$http_code" in
    [0-9][0-9][0-9]) ;;
    *) http_code=000 ;;
  esac
  if [ "$curl_status" -ne 0 ]; then
    log_event "action=keepalive_public status=failed exit_code=$curl_status http_code=$http_code"
  else
    case "$http_code" in
      2[0-9][0-9]|3[0-9][0-9])
        log_event "action=keepalive_public status=ok exit_code=0 http_code=$http_code"
        ;;
      *)
        log_event "action=keepalive_public status=failed reason=http_status exit_code=0 http_code=$http_code"
        ;;
    esac
  fi
}

run_local_jupyter_keepalive() {
  local arg token="${JUPYTER_TOKEN:-}" base_path="${GRADIO_ROOT_PATH:-}" http_code curl_status
  if { [ -z "$token" ] || [ -z "$base_path" ]; } && [ -r /proc/1/cmdline ]; then
    while IFS= read -r arg; do
      case "$arg" in
        --ServerApp.token=*) [ -n "$token" ] || token="${arg#*=}" ;;
        --ServerApp.base_url=*) [ -n "$base_path" ] || base_path="${arg#*=}" ;;
      esac
    done < <(tr '\0' '\n' < /proc/1/cmdline)
  fi
  case "$token" in
    ''|*[!A-Za-z0-9._~-]*)
      log_event "action=keepalive_local status=waiting reason=invalid_token"
      return 0
      ;;
  esac
  case "$base_path" in
    /*) ;;
    *)
      log_event "action=keepalive_local status=waiting reason=invalid_base_path"
      return 0
      ;;
  esac
  if [ ! -x "$curl_bin" ]; then
    log_event "action=keepalive_local status=failed reason=missing_curl exit_code=127 http_code=000"
    return 0
  fi

  base_path="${base_path%/}"
  http_code="$({ printf 'Authorization: token %s\n' "$token" | "$curl_bin" -H @- -sS -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:7860${base_path}/api/status"; } 2>/dev/null 9>&-)"
  curl_status=$?
  case "$http_code" in
    [0-9][0-9][0-9]) ;;
    *) http_code=000 ;;
  esac
  if [ "$curl_status" -eq 0 ] && [ "$http_code" -ge 200 ] && [ "$http_code" -lt 400 ]; then
    log_event "action=keepalive_local status=ok exit_code=0 http_code=$http_code"
  else
    log_event "action=keepalive_local status=failed exit_code=$curl_status http_code=$http_code"
  fi
}

run_keepalive() {
  run_public_keepalive
  run_local_jupyter_keepalive
}

run_once() {
  rotate_log "$watchdog_log"
  rotate_log "$frpc_log"
  check_frpc
}

if [ "$mode" = once ]; then
  run_once
  run_keepalive
  exit 0
fi

remaining="$keepalive_every"
while :; do
  run_once
  remaining=$((remaining - 1))
  if [ "$remaining" -eq 0 ]; then
    run_keepalive
    remaining="$keepalive_every"
  fi
  sleep "$check_interval" 9>&- &
  sleep_pid=$!
  wait "$sleep_pid" 2>/dev/null || true
  sleep_pid=''
done
