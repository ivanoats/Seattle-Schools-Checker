#!/bin/sh
# Installs the Source runner on the Ubuntu instance. Run as root from a
# Session Manager shell: sh install.sh <git-ref>
set -eu

ref="${1:?usage: install.sh <git-ref>}"
repo=https://github.com/ivanoats/Seattle-Schools-Checker.git

# Keep the instance up while installing, even if the service is enabled.
mkdir -p /etc/source-runner
touch /etc/source-runner/stay-up

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git unzip

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location https://deb.nodesource.com/setup_22.x | sh -
  apt-get install -y --no-install-recommends nodejs
fi
if ! command -v google-chrome >/dev/null; then
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location --output /root/google-chrome.deb \
    https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y --no-install-recommends /root/google-chrome.deb
  rm /root/google-chrome.deb
fi
if ! test -x /usr/local/bin/aws; then
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location --output /root/awscli.zip \
    https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
  unzip -q -o /root/awscli.zip -d /root
  /root/aws/install --update
  rm -rf /root/awscli.zip /root/aws
fi

id source-runner >/dev/null 2>&1 || useradd --system --home-dir /var/lib/source-runner --shell /usr/sbin/nologin source-runner

rm -rf /opt/source-runner.new
git clone --quiet "$repo" /opt/source-runner.new
git -C /opt/source-runner.new checkout --quiet --detach "$ref"
(cd /opt/source-runner.new && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
chmod 755 /opt/source-runner.new/deploy/aws/run-once.sh
rm -rf /opt/source-runner.old
if test -d /opt/source-runner; then mv /opt/source-runner /opt/source-runner.old; fi
mv /opt/source-runner.new /opt/source-runner

install -m 644 /opt/source-runner/deploy/aws/source-runner.service /etc/systemd/system/source-runner.service
systemctl daemon-reload
systemctl enable source-runner.service

echo "Installed $(git -C /opt/source-runner rev-parse --short HEAD)."
echo "Test with: systemctl start source-runner.service; journalctl -u source-runner.service -n 5"
echo "Then remove /etc/source-runner/stay-up so the instance powers off after each check."
