#!/usr/bin/env bash
set -euo pipefail

manifest_path="${1:-}"
signature_path="${2:-}"
signing_key_arn="${PROMOTION_SIGNING_KEY_ARN:-}"

if [[ -z "${manifest_path}" || -z "${signature_path}" ]]; then
  echo "Usage: verify-promotion-signature.sh <manifest.json> <signature.json>" >&2
  exit 64
fi
if [[ ! -s "${manifest_path}" || ! -s "${signature_path}" ]]; then
  echo "The promotion manifest or signature is missing." >&2
  exit 1
fi
if [[ ! "${signing_key_arn}" =~ ^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "PROMOTION_SIGNING_KEY_ARN must be an exact KMS key ARN." >&2
  exit 1
fi

manifest_digest="sha256:$(sha256sum "${manifest_path}" | awk '{print $1}')"
jq -e \
  --arg key_arn "${signing_key_arn}" \
  --arg manifest_digest "${manifest_digest}" \
  '
    type == "object"
    and keys == [
      "keyArn",
      "manifestDigest",
      "schemaVersion",
      "signature",
      "signingAlgorithm"
    ]
    and .schemaVersion == "1.0"
    and .keyArn == $key_arn
    and .signingAlgorithm == "ECDSA_SHA_256"
    and .manifestDigest == $manifest_digest
    and (.signature | type == "string" and test("^[A-Za-z0-9+/]+={0,2}$"))
  ' "${signature_path}" >/dev/null

umask 077
digest_path="$(mktemp)"
signature_binary_path="$(mktemp)"
trap 'rm -f "${digest_path}" "${signature_binary_path}"' EXIT

openssl dgst -sha256 -binary -out "${digest_path}" "${manifest_path}"
node -e '
  const fs = require("node:fs");
  const envelope = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[2], Buffer.from(envelope.signature, "base64"), {
    mode: 0o600,
  });
' "${signature_path}" "${signature_binary_path}"
if [[ ! -s "${signature_binary_path}" ]]; then
  echo "The promotion signature is empty." >&2
  exit 1
fi

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

signature_valid="$(
  aws kms verify \
    --key-id "${signing_key_arn}" \
    --message "fileb://${digest_path}" \
    --message-type DIGEST \
    --signature "fileb://${signature_binary_path}" \
    --signing-algorithm ECDSA_SHA_256 \
    --query SignatureValid \
    --output text
)"
if [[ "${signature_valid}" != "True" ]]; then
  echo "The KMS promotion signature is invalid." >&2
  exit 1
fi
