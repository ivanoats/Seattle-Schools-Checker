#!/bin/sh
# Only the machine's scoped discovery token comes from Parameter Store.
# Only report content is claimed over HTTPS and held in memory; no parent login is used.
set -eu
umask 077
region="${AWS_REGION:-us-west-2}"
prefix="${SOURCE_PARAMETER_PREFIX:-/seattle-source-checker}"
setting() {
  setting_name="$1"
  /usr/local/bin/aws ssm get-parameter --region "$region" --with-decryption \
    --name "$prefix/$setting_name" --query Parameter.Value --output text
}
DISCOVERY_APP_ORIGIN="$(setting discovery-app-origin)"
SOURCE_DISCOVERY_TOKEN="$(setting source-discovery-token)"
export DISCOVERY_APP_ORIGIN SOURCE_DISCOVERY_TOKEN
cd /opt/source-runner
exec /usr/bin/node scripts/mail-runner/run.js
