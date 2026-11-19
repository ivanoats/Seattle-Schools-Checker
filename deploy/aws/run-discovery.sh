#!/bin/sh
# Only the machine's scoped discovery token comes from Parameter Store.
# Parent passwords are claimed over HTTPS and held in the Node worker's memory.
set -eu
umask 077
region="${AWS_REGION:-us-west-2}"
prefix="${SOURCE_PARAMETER_PREFIX:-/seattle-source-checker}"
setting() {
  /usr/local/bin/aws ssm get-parameter --region "$region" --with-decryption \
    --name "$prefix/$1" --query Parameter.Value --output text
}
DISCOVERY_APP_ORIGIN="$(setting discovery-app-origin)"
SOURCE_DISCOVERY_TOKEN="$(setting source-discovery-token)"
export DISCOVERY_APP_ORIGIN SOURCE_DISCOVERY_TOKEN
cd /opt/source-runner
exec /usr/bin/node scripts/source-runner/hosted.js
