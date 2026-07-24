#!/usr/bin/env bash
set -euo pipefail

repository_name="${1:?repository name is required}"
image_digest="${2:?image digest is required}"
evidence_file="${3:?evidence file is required}"

if [[ ! "${repository_name}" =~ ^migration-api-development-[a-z0-9-]+$ ]]; then
  echo "Unexpected ECR repository name." >&2
  exit 1
fi
if [[ ! "${image_digest}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "Image digest is invalid." >&2
  exit 1
fi

mkdir -p "$(dirname "${evidence_file}")"

for attempt in $(seq 1 40); do
  if aws ecr describe-image-scan-findings \
    --repository-name "${repository_name}" \
    --image-id "imageDigest=${image_digest}" \
    --output json >"${evidence_file}" 2>/dev/null; then
    scan_status="$(jq -r '.imageScanStatus.status // "UNKNOWN"' "${evidence_file}")"
    case "${scan_status}" in
      COMPLETE)
        critical_count="$(jq -r '.imageScanFindings.findingSeverityCounts.CRITICAL // 0' "${evidence_file}")"
        high_count="$(jq -r '.imageScanFindings.findingSeverityCounts.HIGH // 0' "${evidence_file}")"
        if (( critical_count > 0 || high_count > 0 )); then
          echo "${repository_name} has ${critical_count} critical and ${high_count} high findings." >&2
          exit 1
        fi
        echo "${repository_name} scan completed without high or critical findings."
        exit 0
        ;;
      FAILED | FINDINGS_UNAVAILABLE | LIMIT_EXCEEDED | SCAN_ELIGIBILITY_EXPIRED | UNSUPPORTED_IMAGE)
        echo "${repository_name} scan ended with status ${scan_status}." >&2
        exit 1
        ;;
      *)
        echo "Waiting for ${repository_name} image scan (${attempt}/40, status ${scan_status})."
        ;;
    esac
  else
    echo "Waiting for ${repository_name} image scan to start (${attempt}/40)."
  fi
  sleep 10
done

echo "Timed out waiting for ${repository_name} image scan." >&2
exit 1
