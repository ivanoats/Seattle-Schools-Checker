#!/bin/sh
# Stores the Source parent username and password in Parameter Store.
# Run it yourself in a terminal. The password is not echoed, is not put
# in a command argument, and is removed from disk when the script ends.
set -eu

region="${AWS_REGION:-us-west-2}"
prefix="${SOURCE_PARAMETER_PREFIX:-/seattle-source-checker}"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

printf 'Source parent username: '
IFS= read -r username
printf 'Source password (hidden): '
stty -echo
IFS= read -r password || true
stty echo
printf '\n'
if [ -z "$username" ] || [ -z "$password" ]; then
  echo 'Both values are required. Nothing was stored.' >&2
  exit 1
fi

printf '%s' "$username" > "$work/username"
printf '%s' "$password" > "$work/password"
password=''
aws ssm put-parameter --region "$region" --name "$prefix/source-username" --type SecureString \
  --overwrite --value "file://$work/username" --query Version --output text >/dev/null
aws ssm put-parameter --region "$region" --name "$prefix/source-password" --type SecureString \
  --overwrite --value "file://$work/password" --query Version --output text >/dev/null
echo 'Stored the Source username and password.'
