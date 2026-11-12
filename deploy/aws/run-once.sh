#!/bin/sh
# Runs one Source check. Settings come from Parameter Store at start and
# are held in memory or on the service's private tmpfs only.
set -eu

region="${AWS_REGION:-us-west-2}"
prefix="${SOURCE_PARAMETER_PREFIX:-/seattle-source-checker}"
runtime="${RUNTIME_DIRECTORY:?run this from the systemd unit}"

setting() {
  /usr/local/bin/aws ssm get-parameter --region "$region" --with-decryption \
    --name "$prefix/$1" --query Parameter.Value --output text
}

umask 077
setting children-json > "$runtime/children.json"
SOURCE_CHILD_CONFIG="$runtime/children.json"
SOURCE_USERNAME="$(setting source-username)"
SOURCE_PASSWORD="$(setting source-password)"
SOURCE_INGEST_URL="$(setting ingest-url)"
SOURCE_INGEST_TOKEN="$(setting ingest-token)"
export SOURCE_CHILD_CONFIG SOURCE_USERNAME SOURCE_PASSWORD SOURCE_INGEST_URL SOURCE_INGEST_TOKEN

cd /opt/source-runner
exec /usr/bin/node scripts/source-runner/run.js
