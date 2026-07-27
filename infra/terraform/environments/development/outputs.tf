output "product_url" {
  value = "https://${var.product_domain}"
}

output "cloudfront_cname_target" {
  description = "Create a GoDaddy CNAME for product_domain pointing to this hostname."
  value       = aws_cloudfront_distribution.web.domain_name
}

output "api_endpoint" {
  value = aws_apigatewayv2_api.control.api_endpoint
}

output "github_webhook_url" {
  description = "Dedicated raw-body GitHub App webhook endpoint."
  value       = "${aws_apigatewayv2_api.control.api_endpoint}/v1/github/webhooks"
}

output "github_setup_url" {
  description = "GitHub App setup callback URL."
  value       = "https://${var.product_domain}/github/setup/callback"
}

output "github_token_broker_function_name" {
  description = "Function name for IAM-authorized trusted callers."
  value       = aws_lambda_function.github_token_broker.function_name
}

output "github_reconciler_function_name" {
  description = "SQS-driven GitHub installation reconciliation function."
  value       = aws_lambda_function.github_reconciler.function_name
}

output "artifact_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "artifact_kms_key_arn" {
  value = aws_kms_key.artifacts.arn
}

output "agent_ecr_repository_url" {
  value = data.aws_ecr_repository.agent.repository_url
}

output "migrator_ecr_repository_url" {
  value = data.aws_ecr_repository.migrator.repository_url
}

output "source_fetcher_ecr_repository_url" {
  value = data.aws_ecr_repository.source_fetcher.repository_url
}

output "source_fetcher_task_definition_arn" {
  value = aws_ecs_task_definition.source_fetcher.arn
}

output "repository_scan_state_machine_arn" {
  value = aws_sfn_state_machine.repository_scan.arn
}

output "vendor_fetcher_ecr_repository_url" {
  value = data.aws_ecr_repository.vendor_fetcher.repository_url
}

output "vendor_fetcher_task_definition_arn" {
  value = aws_ecs_task_definition.vendor_fetcher.arn
}

output "vendor_ingestion_state_machine_arn" {
  value = aws_sfn_state_machine.vendor_ingestion.arn
}

output "change_intelligence_agent_ecr_repository_url" {
  value = data.aws_ecr_repository.change_intelligence_agent.repository_url
}

output "change_intelligence_task_definition_arn" {
  value = aws_ecs_task_definition.change_intelligence_agent.arn
}

output "change_intelligence_state_machine_arn" {
  value = aws_sfn_state_machine.change_intelligence.arn
}

output "impact_analysis_agent_ecr_repository_url" {
  value = data.aws_ecr_repository.impact_analysis_agent.repository_url
}

output "migration_agent_ecr_repository_url" {
  value = data.aws_ecr_repository.migration_agent.repository_url
}

output "migration_agent_task_definition_arn" {
  value = aws_ecs_task_definition.migration_agent.arn
}

output "impact_analysis_task_definition_arn" {
  value = aws_ecs_task_definition.impact_analysis_agent.arn
}

output "impact_analysis_state_machine_arn" {
  value = aws_sfn_state_machine.impact_analysis.arn
}

output "migration_state_machine_arn" {
  value = aws_sfn_state_machine.migration.arn
}

output "migrator_task_definition_arn" {
  value = aws_ecs_task_definition.migrator.arn
}

output "migrator_success_parameter_name" {
  value = aws_ssm_parameter.migrator_success_digest.name
}

output "migrator_success_parameter_kms_key_arn" {
  value = aws_kms_key.artifacts.arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.agent.name
}

output "control_subnet_ids" {
  value = [for subnet in aws_subnet.control : subnet.id]
}

output "control_security_group_id" {
  value = aws_security_group.control.id
}

output "agent_task_role_arn" {
  value = aws_iam_role.agent_task.arn
}

output "state_machine_arn" {
  value = aws_sfn_state_machine.agent.arn
}

output "control_nat_egress_cidrs" {
  description = "Allowlist these fixed addresses in Supabase PostgreSQL network restrictions."
  value       = [for address in aws_eip.nat : "${address.public_ip}/32"]
}
