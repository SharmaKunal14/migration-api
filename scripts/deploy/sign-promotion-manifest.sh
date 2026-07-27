#!/usr/bin/env bash
set -euo pipefail

manifest_path="${1:-}"
signature_path="${2:-}"
signing_key_arn="${PROMOTION_SIGNING_KEY_ARN:-}"

if [[ -z "${manifest_path}" || -z "${signature_path}" ]]; then
  echo "Usage: sign-promotion-manifest.sh <manifest.json> <signature.json>" >&2
  exit 64
fi
if [[ ! -s "${manifest_path}" ]]; then
  echo "The promotion manifest does not exist or is empty." >&2
  exit 1
fi
if [[ ! "${signing_key_arn}" =~ ^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "PROMOTION_SIGNING_KEY_ARN must be an exact KMS key ARN." >&2
  exit 1
fi

umask 077
digest_path="$(mktemp)"
trap 'rm -f "${digest_path}"' EXIT

key_metadata="$(
  aws kms get-public-key \
    --key-id "${signing_key_arn}" \
    --query '{KeyId:KeyId,KeySpec:KeySpec,KeyUsage:KeyUsage,SigningAlgorithms:SigningAlgorithms}' \
    --output json
)"
jq -e \
  --arg key_arn "${signing_key_arn}" \
  '
    .KeyId == $key_arn
    and .KeySpec == "ECC_NIST_P256"
    and .KeyUsage == "SIGN_VERIFY"
    and (.SigningAlgorithms | index("ECDSA_SHA_256") != null)
  ' <<<"${key_metadata}" >/dev/null

openssl dgst -sha256 -binary -out "${digest_path}" "${manifest_path}"
sign_response="$(
  aws kms sign \
    --key-id "${signing_key_arn}" \
    --message "fileb://${digest_path}" \
    --message-type DIGEST \
    --signing-algorithm ECDSA_SHA_256 \
    --query '{KeyId:KeyId,SigningAlgorithm:SigningAlgorithm,Signature:Signature}' \
    --output json
)"

manifest_digest="sha256:$(sha256sum "${manifest_path}" | awk '{print $1}')"
jq -e \
  --arg key_arn "${signing_key_arn}" \
  '
    .KeyId == $key_arn
    and .SigningAlgorithm == "ECDSA_SHA_256"
    and (.Signature | type == "string" and length > 0)
  ' <<<"${sign_response}" >/dev/null

jq -n \
  --arg key_arn "${signing_key_arn}" \
  --arg manifest_digest "${manifest_digest}" \
  --arg signature "$(jq -r '.Signature' <<<"${sign_response}")" \
  '{
    schemaVersion: "1.0",
    keyArn: $key_arn,
    signingAlgorithm: "ECDSA_SHA_256",
    manifestDigest: $manifest_digest,
    signature: $signature
  }' >"${signature_path}"
