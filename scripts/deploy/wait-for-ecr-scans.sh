#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 || $# % 3 != 0 )); then
  echo "Expected one or more repository, digest, and evidence-file triples." >&2
  exit 1
fi

declare -a scan_pids=()
declare -a scan_repositories=()

while (( $# > 0 )); do
  repository_name="${1}"
  image_digest="${2}"
  evidence_file="${3}"
  shift 3

  bash scripts/deploy/wait-for-ecr-scan.sh \
    "${repository_name}" \
    "${image_digest}" \
    "${evidence_file}" &
  scan_pids+=("$!")
  scan_repositories+=("${repository_name}")
done

failed=0
for index in "${!scan_pids[@]}"; do
  if ! wait "${scan_pids[${index}]}"; then
    echo "Image scan gate failed for ${scan_repositories[${index}]}." >&2
    failed=1
  fi
done

exit "${failed}"
