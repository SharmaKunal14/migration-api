#!/usr/bin/env bash
set -euo pipefail

evidence_directory="${1:?evidence directory is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${ECR_REGISTRY:?ECR_REGISTRY is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_SERVER_URL:?GITHUB_SERVER_URL is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

mkdir -p "${evidence_directory}"
images_ndjson="${evidence_directory}/promotion-images.ndjson"
images_json="${evidence_directory}/promotion-images.json"
: >"${images_ndjson}"

image_definitions=(
  "agent|migration-api-development-agent|workers/agent/Dockerfile|dist/workers/agent/main.js|agent_image_digest|agent_scan_digest"
  "migrator|migration-api-development-database-migrator|workers/database-migrator/Dockerfile|dist/workers/database-migrator/main.js|migrator_image_digest|migrator_scan_digest"
  "sourceFetcher|migration-api-development-source-fetcher|workers/source-fetcher/Dockerfile|dist/workers/source-fetcher/main.js|source_fetcher_image_digest|source_fetcher_scan_digest"
  "vendorFetcher|migration-api-development-vendor-fetcher|workers/vendor-fetcher/Dockerfile|dist/workers/vendor-fetcher/main.js|vendor_fetcher_image_digest|vendor_fetcher_scan_digest"
  "changeIntelligenceAgent|migration-api-development-change-intelligence-agent|workers/change-intelligence-agent/Dockerfile|dist/workers/change-intelligence-agent/main.js|change_intelligence_agent_image_digest|change_intelligence_agent_scan_digest"
  "impactAnalysisAgent|migration-api-development-impact-analysis-agent|workers/impact-analysis-agent/Dockerfile|dist/workers/impact-analysis-agent/main.js|impact_analysis_agent_image_digest|impact_analysis_agent_scan_digest"
  "migrationAgent|migration-api-development-migration-agent|workers/migration-agent/Dockerfile|dist/workers/migration-agent/main.js|migration_agent_image_digest|migration_agent_scan_digest"
)

resolve_arm64_digest() {
  local image_reference="${1:?image reference is required}"
  docker buildx imagetools inspect --raw "${image_reference}" |
    jq -er '
      [
        .manifests[]
        | select(.platform.os == "linux" and .platform.architecture == "arm64")
        | .digest
      ]
      | if length == 1 then .[0]
        else error("expected exactly one linux/arm64 image manifest")
        end
    '
}

for definition in "${image_definitions[@]}"; do
  IFS='|' read -r key repository dockerfile bundle output_name scan_output_name <<<"${definition}"
  test -s "${bundle}"
  image_name="${ECR_REGISTRY}/${repository}"
  image_tag="${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  image_reference="${image_name}:${image_tag}"

  docker buildx build \
    --file "${dockerfile}" \
    --platform linux/arm64 \
    --provenance=mode=max \
    --sbom=true \
    --label "org.opencontainers.image.revision=${GITHUB_SHA}" \
    --label "org.opencontainers.image.source=${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}" \
    --tag "${image_reference}" \
    --push \
    .

  digest="$(aws ecr describe-images \
    --repository-name "${repository}" \
    --image-ids "imageTag=${image_tag}" \
    --query 'imageDetails[0].imageDigest' \
    --output text)"
  if [[ ! "${digest}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "${repository} produced an invalid immutable digest." >&2
    exit 1
  fi
  scan_digest="$(resolve_arm64_digest "${image_name}@${digest}")"
  if [[ ! "${scan_digest}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "${repository} produced an invalid ARM64 scan digest." >&2
    exit 1
  fi

  jq -cn \
    --arg key "${key}" \
    --arg repository "${repository}" \
    --arg subjectName "${image_name}" \
    --arg digest "${digest}" \
    --arg scanDigest "${scan_digest}" \
    '{key:$key,repository:$repository,subjectName:$subjectName,digest:$digest,scanDigest:$scanDigest}' \
    >>"${images_ndjson}"
  {
    echo "${output_name}=${digest}"
    echo "${scan_output_name}=${scan_digest}"
  } >>"${GITHUB_OUTPUT}"
done

jq -s '.' "${images_ndjson}" >"${images_json}"

migrator_content_digest="$(
  {
    sha256sum workers/database-migrator/Dockerfile
    sha256sum dist/workers/database-migrator/main.js
    find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print0 |
      sort -z |
      xargs -0 sha256sum
  } |
    LC_ALL=C sort |
    sha256sum |
    cut -d' ' -f1
)"
if [[ ! "${migrator_content_digest}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "The migrator content digest is invalid." >&2
  exit 1
fi
echo "migrator_content_digest=sha256:${migrator_content_digest}" >>"${GITHUB_OUTPUT}"
