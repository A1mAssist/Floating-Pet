#!/usr/bin/env bash

bootstrap_ssh() (
  set -eu
  umask 077

  state_dir="${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-ssh"
  runtime_dir="$HOME/.modelers-ssh-runtime"
  ssh_dir="$HOME/.ssh"
  auth_keys="$ssh_dir/modelers_authorized_keys"
  user_name="$(id -un)"
  mkdir -p "$state_dir" "$runtime_dir" "$ssh_dir"
  chmod 700 "$state_dir" "$runtime_dir" "$ssh_dir"

  printf '%s\n' 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDKQVGwYUFdRoLg2m69bhG4VwHxaqxQJh220ONLVYFH7gNpO432JA8F54CIxx/RDpAX4vg4DQ9cZDfTb2MALUfatLSo8IdTt3eyJgbyt+Dyl921ANeJff/S+r5WWxH1PnjpNv23rHUPVxe9NFR8mZawdvV8736Zd9IlC8PS/LyTydEw5+ctBVXMQ+8DYJ8/QFilLFjpzUddYAvFLMyv6gHEm837i6Zxf3gEjZWVrOd6vfX2SHDYLLu3dKCze/7hNPcrubwUtzA91MyaXOGJJSjTaoqIzGAaC8Gr8Xue6UJNVersWiI6JCDFHhiKZybt4OP5MgMHyw9n5SlSPUcXRzaR hidevlab-vscode-plugin' > "$auth_keys"
  chmod 600 "$auth_keys"

  persistent_host_key="$state_dir/ssh_host_ed25519_key"
  runtime_host_key="$runtime_dir/ssh_host_ed25519_key"
  runtime_host_key_pub="$runtime_host_key.pub"
  if [ ! -s "$persistent_host_key" ]; then
    rm -f "$persistent_host_key" "$persistent_host_key.pub"
    /usr/bin/ssh-keygen -q -t ed25519 -N '' -f "$persistent_host_key"
  fi
  # The volume can impose a mode that sshd rejects. Keep the private key there
  # only as durable state, then give sshd a tightly-permissioned runtime copy.
  rm -f "$runtime_host_key.tmp.$$" "$runtime_host_key_pub.tmp.$$"
  cp "$persistent_host_key" "$runtime_host_key.tmp.$$"
  chmod 600 "$runtime_host_key.tmp.$$"
  mv -f "$runtime_host_key.tmp.$$" "$runtime_host_key"
  /usr/bin/ssh-keygen -q -y -f "$runtime_host_key" > "$runtime_host_key_pub.tmp.$$"
  chmod 600 "$runtime_host_key_pub.tmp.$$"
  mv -f "$runtime_host_key_pub.tmp.$$" "$runtime_host_key_pub"
  rm -f "$persistent_host_key.pub"
  /usr/bin/ssh-keygen -lf "$runtime_host_key_pub"

  config="$runtime_dir/sshd_config"
  cat > "$config" <<EOF
Port 2222
ListenAddress 127.0.0.1
HostKey $runtime_host_key
PidFile $runtime_dir/sshd.pid
AuthorizedKeysFile $auth_keys
AllowUsers $user_name
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
PermitRootLogin no
PermitEmptyPasswords no
PermitUserEnvironment no
AllowTcpForwarding yes
AllowAgentForwarding no
AllowStreamLocalForwarding no
GatewayPorts no
X11Forwarding no
ClientAliveInterval 60
ClientAliveCountMax 3
Subsystem sftp internal-sftp
EOF

  /usr/sbin/sshd -t -f "$config" 2>> "$state_dir/sshd.log"
  sshd_pid="$(cat "$runtime_dir/sshd.pid" 2>/dev/null || true)"
  if [ -z "$sshd_pid" ] || [ ! -e "/proc/$sshd_pid/exe" ] || [ "$(readlink "/proc/$sshd_pid/exe")" != /usr/sbin/sshd ]; then
    rm -f "$runtime_dir/sshd.pid"
    /usr/sbin/sshd -f "$config" -E "$state_dir/sshd.log"
  fi
)

set +e
bootstrap_ssh
bootstrap_status=$?
if [ "$bootstrap_status" -ne 0 ]; then
  printf 'SSH bootstrap failed; see %s/.modelers-ssh logs\n' "${NOTEBOOK_DIR:-$HOME/volume/notebook}" >&2
fi

frp_state_dir="${NOTEBOOK_DIR:-$HOME/volume/notebook}/.modelers-frp"
if [ -x "$frp_state_dir/watchdog.sh" ]; then
  nohup "$frp_state_dir/watchdog.sh" > "$frp_state_dir/watchdog.out" 2>&1 < /dev/null &
fi

exec jupyter-lab \
  --ip 0.0.0.0 \
  --port 7860 \
  --no-browser \
  --allow-root \
  --ServerApp.allow_origin='*' \
  --ServerApp.base_url="$GRADIO_ROOT_PATH" \
  --ServerApp.token="$JUPYTER_TOKEN" \
  --ServerApp.tornado_settings="{'headers': {'Content-Security-Policy': 'frame-ancestors *'}}" \
  --ServerApp.cookie_options="{'SameSite': 'None', 'Secure': True}" \
  --ServerApp.disable_check_xsrf=True \
  --LabApp.news_url=None \
  --LabApp.check_for_updates_class="jupyterlab.NeverCheckForUpdate" \
  --notebook-dir="$NOTEBOOK_DIR"
