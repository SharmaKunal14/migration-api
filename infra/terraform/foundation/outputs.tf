output "agent_ecr_repository_url" {
  value = aws_ecr_repository.agent.repository_url
}

output "migrator_ecr_repository_url" {
  value = aws_ecr_repository.migrator.repository_url
}

output "container_images_kms_key_arn" {
  value = aws_kms_key.container_images.arn
}

output "source_fetcher_ecr_repository_url" {
  value = aws_ecr_repository.source_fetcher.repository_url
}

output "vendor_fetcher_ecr_repository_url" {
  value = aws_ecr_repository.vendor_fetcher.repository_url
}

output "change_intelligence_agent_ecr_repository_url" {
  value = aws_ecr_repository.change_intelligence_agent.repository_url
}

output "impact_analysis_agent_ecr_repository_url" {
  value = aws_ecr_repository.impact_analysis_agent.repository_url
}
