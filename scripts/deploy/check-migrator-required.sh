#!/usr/bin/env bash
set -euo pipefail

desired_digest="${1:?desired migrator content digest is required}"
evidence_directory="${2:?evidence directory is required}"
parameter_name="${MIGRATOR_SUCCESS_PARAMETER_NAME:-/migration-api/development/deployment/last-successful-migrator-content-digest}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

if [[ ! "${desired_digest}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "The desired migrator content digest is invalid." >&2
  exit 1
fi
mkdir -p "${evidence_directory}"
error_file="${evidence_directory}/migrator-marker-error.txt"

if current_digest="$(aws ssm get-parameter \
  --name "${parameter_name}" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text 2>"${error_file}")"; then
  if [[ ! "${current_digest}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "The persisted migrator success marker is malformed." >&2
    exit 1
  fi
elif grep -q 'ParameterNotFound' "${error_file}"; then
  current_digest="missing"
else
  echo "Unable to read the migrator success marker." >&2
  sed -E 's/(user-|idp_|sb_)[A-Za-z0-9_-]+/[REDACTED]/g' "${error_file}" >&2
  exit 1
fi
rm -f "${error_file}"

required=true
if [[ "${current_digest}" == "${desired_digest}" ]]; then
  required=false
fi
jq -cn \
  --arg parameterName "${parameter_name}" \
  --arg currentDigest "${current_digest}" \
  --arg desiredDigest "${desired_digest}" \
  --argjson required "${required}" \
  '{parameterName:$parameterName,currentDigest:$currentDigest,desiredDigest:$desiredDigest,required:$required}' \
  >"${evidence_directory}/migrator-decision.json"
echo "required=${required}" >>"${GITHUB_OUTPUT}"
