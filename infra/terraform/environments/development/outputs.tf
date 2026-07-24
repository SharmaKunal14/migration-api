output "product_url" {
  value = "https://${var.product_domain}"
}

output "api_endpoint" {
  value = aws_apigatewayv2_api.control.api_endpoint
}

output "artifact_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "artifact_kms_key_arn" {
  value = aws_kms_key.artifacts.arn
}

output "agent_ecr_repository_url" {
  value = aws_ecr_repository.agent.repository_url
}

output "migrator_ecr_repository_url" {
  value = aws_ecr_repository.migrator.repository_url
}

output "migrator_task_definition_arn" {
  value = aws_ecs_task_definition.migrator.arn
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
