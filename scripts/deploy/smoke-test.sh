#!/usr/bin/env bash
set -euo pipefail

product_url="${1:?product URL is required}"
evidence_directory="${2:?evidence directory is required}"

if [[ ! "${product_url}" =~ ^https://[a-z0-9.-]+$ ]]; then
  echo "Product URL must be an HTTPS origin without a path." >&2
  exit 1
fi

mkdir -p "${evidence_directory}"
host="${product_url#https://}"

for attempt in $(seq 1 20); do
  if curl \
    --fail \
    --silent \
    --show-error \
    --connect-timeout 5 \
    --max-time 20 \
    --dump-header "${evidence_directory}/root-headers.txt" \
    --output "${evidence_directory}/root-body.html" \
    "${product_url}/"; then
    break
  fi
  if [[ "${attempt}" == '20' ]]; then
    echo "Product root did not become healthy." >&2
    exit 1
  fi
  sleep 15
done

grep -Eiq '^content-security-policy:' "${evidence_directory}/root-headers.txt"
grep -Eiq '^strict-transport-security:' "${evidence_directory}/root-headers.txt"
grep -Eiq '<div id="root"></div>' "${evidence_directory}/root-body.html"

redirect_status="$(curl \
  --silent \
  --show-error \
  --connect-timeout 5 \
  --max-time 20 \
  --output /dev/null \
  --write-out '%{http_code}' \
  "http://${host}/")"
if [[ "${redirect_status}" != '301' && "${redirect_status}" != '302' ]]; then
  echo "HTTP did not redirect to HTTPS; received ${redirect_status}." >&2
  exit 1
fi

deep_link_status="$(curl \
  --silent \
  --show-error \
  --connect-timeout 5 \
  --max-time 20 \
  --output "${evidence_directory}/deep-link-body.html" \
  --write-out '%{http_code}' \
  "${product_url}/organisations/00000000-0000-0000-0000-000000000000/demo")"
if [[ "${deep_link_status}" != '200' ]]; then
  echo "Deep link returned ${deep_link_status} instead of 200." >&2
  exit 1
fi

api_status="$(curl \
  --silent \
  --show-error \
  --connect-timeout 5 \
  --max-time 20 \
  --dump-header "${evidence_directory}/api-headers.txt" \
  --output "${evidence_directory}/api-body.json" \
  --write-out '%{http_code}' \
  "${product_url}/api/v1/me")"
if [[ "${api_status}" != '401' ]]; then
  echo "Unauthenticated API request returned ${api_status} instead of 401." >&2
  exit 1
fi
jq -e 'type == "object"' "${evidence_directory}/api-body.json" >/dev/null

echo "Public deployment smoke checks passed."
