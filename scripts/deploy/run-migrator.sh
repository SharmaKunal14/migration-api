#!/usr/bin/env bash
set -euo pipefail

terraform_directory="${1:?Terraform directory is required}"
evidence_directory="${2:?evidence directory is required}"

mkdir -p "${evidence_directory}"

cluster_name="$(terraform -chdir="${terraform_directory}" output -raw ecs_cluster_name)"
task_definition="$(terraform -chdir="${terraform_directory}" output -raw migrator_task_definition_arn)"
control_subnets="$(terraform -chdir="${terraform_directory}" output -json control_subnet_ids)"
control_security_group="$(terraform -chdir="${terraform_directory}" output -raw control_security_group_id)"

network_configuration="$(jq -cn \
  --argjson subnets "${control_subnets}" \
  --arg security_group "${control_security_group}" \
  '{awsvpcConfiguration:{subnets:$subnets,securityGroups:[$security_group],assignPublicIp:"DISABLED"}}')"

aws ecs run-task \
  --cluster "${cluster_name}" \
  --launch-type FARGATE \
  --task-definition "${task_definition}" \
  --network-configuration "${network_configuration}" \
  --count 1 \
  --output json >"${evidence_directory}/migration-run-task.json"

failure_count="$(jq -r '.failures | length' "${evidence_directory}/migration-run-task.json")"
task_arn="$(jq -r '.tasks[0].taskArn // empty' "${evidence_directory}/migration-run-task.json")"
if (( failure_count > 0 )) || [[ -z "${task_arn}" ]]; then
  echo "ECS rejected the database migration task." >&2
  exit 1
fi

echo "Waiting for database migration task ${task_arn}."
aws ecs wait tasks-stopped --cluster "${cluster_name}" --tasks "${task_arn}"
aws ecs describe-tasks \
  --cluster "${cluster_name}" \
  --tasks "${task_arn}" \
  --output json >"${evidence_directory}/migration-task-result.json"

exit_code="$(jq -r '.tasks[0].containers[] | select(.name == "database-migrator") | .exitCode // empty' \
  "${evidence_directory}/migration-task-result.json")"
if [[ "${exit_code}" != '0' ]]; then
  stopped_reason="$(jq -r '.tasks[0].stoppedReason // "unknown"' \
    "${evidence_directory}/migration-task-result.json")"
  echo "Database migration failed with exit code ${exit_code:-missing}: ${stopped_reason}" >&2
  task_id="${task_arn##*/}"
  log_stream_name="migration/database-migrator/${task_id}"
  echo "Database migrator logs (${log_stream_name}):" >&2
  if ! aws logs get-log-events \
    --log-group-name /migration-api/development/database-migrator \
    --log-stream-name "${log_stream_name}" \
    --limit 100 \
    --output json |
    jq -r '.events[].message' >&2; then
    echo "Unable to retrieve the task-specific database migrator logs." >&2
  fi
  exit 1
fi

echo "Database migration completed successfully."
