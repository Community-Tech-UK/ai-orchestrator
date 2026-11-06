#!/usr/bin/env bash
# Prepares a clean Ubuntu 24.04 machine to run this project's full test suite for
# scripts/run-tests-quiet.js. Run it once, as root, on a fresh image. It works on a
# WSL distro, and the same script sets up a virtual machine or rented server later.
#
#   sudo bash setup-linux.sh "<ssh public key allowed to connect>"
#
# Node is not installed here: remote-run.sh fetches the version in .nvmrc per run.
# The test user has no admin rights and no GitHub login. It does need internet
# access, for npm packages and Electron.
set -euo pipefail

PUBLIC_KEY="${1:?usage: setup-linux.sh '<ssh public key>'}"
CHECKS_USER=checks
SSH_PORT=2222

if [ "$(id -u)" -ne 0 ]; then
  echo "setup-linux.sh must run as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q software-properties-common ca-certificates curl gnupg
# Ubuntu 24.04 ships git 2.43, whose `git config --unset` behaviour the push guard's
# tests have failed on. The git-core archive tracks the current release.
add-apt-repository -y ppa:git-core/ppa
apt-get update -q
apt-get install -y -q \
  git ripgrep sqlite3 build-essential python3 python-is-python3 xz-utils unzip zip \
  procps lsof psmisc util-linux dbus dbus-user-session systemd-container openssh-server \
  libnss3 libnspr4 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
  libdrm2 libgbm1 libgtk-3-0t64 libpango-1.0-0 libxcomposite1 libxdamage1 libxrandr2 \
  libxkbcommon0 libxss1 libxtst6 libsecret-1-0 xvfb

if ! id "$CHECKS_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$CHECKS_USER"
fi
# A cloud image can add new users to sudo through a default group list.
gpasswd -d "$CHECKS_USER" sudo >/dev/null 2>&1 || true
# Keeps the user's systemd running with nobody logged in, which remote-run.sh needs
# for the cgroup that lets it kill a whole run.
loginctl enable-linger "$CHECKS_USER" 2>/dev/null \
  || { mkdir -p /var/lib/systemd/linger && touch "/var/lib/systemd/linger/$CHECKS_USER"; }

home_dir="$(getent passwd "$CHECKS_USER" | cut -d: -f6)"
install -d -m 700 -o "$CHECKS_USER" -g "$CHECKS_USER" "$home_dir/.ssh"
printf '%s\n' "$PUBLIC_KEY" > "$home_dir/.ssh/authorized_keys"
chown "$CHECKS_USER:$CHECKS_USER" "$home_dir/.ssh/authorized_keys"
chmod 600 "$home_dir/.ssh/authorized_keys"

cat > /etc/ssh/sshd_config.d/10-harness-checks.conf <<CONF
Port $SSH_PORT
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers $CHECKS_USER
# Notice a dead connection from this end too, so a lost run is cleaned up.
ClientAliveInterval 15
ClientAliveCountMax 4
CONF
ssh-keygen -A
# Ubuntu 24.04 starts sshd from a socket unit that ignores Port in sshd_config. These work with
# or without systemd running, because a fresh WSL image only starts it after the restart below.
systemctl mask ssh.socket
systemctl enable ssh.service

if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  # systemd is needed for the run cgroup. Windows drives and programs stay reachable,
  # but Windows folders stay off the path so a test can't pick up a Windows program.
  cat > /etc/wsl.conf <<CONF
[boot]
systemd=true

[interop]
appendWindowsPath=false

[user]
default=$CHECKS_USER
CONF
fi

echo "setup-linux: done. git $(git --version | cut -d' ' -f3). Host key:"
cat /etc/ssh/ssh_host_ed25519_key.pub
