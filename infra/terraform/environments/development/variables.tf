variable "aws_region" {
  description = "Recorded development AWS region. No default is intentional."
  type        = string
}

variable "owner" {
  description = "Resource owner tag."
  type        = string
}

variable "product_domain" {
  description = "Dedicated development hostname managed manually in GoDaddy."
  type        = string
}

variable "acm_certificate_arn" {
  description = "Validated us-east-1 ACM certificate for product_domain."
  type        = string
}

variable "supabase_url" {
  description = "Development Supabase project URL; not a secret."
  type        = string
}

variable "supabase_jwt_issuer" {
  description = "Exact Supabase JWT issuer."
  type        = string
}

variable "supabase_jwt_audience" {
  description = "Exact Supabase JWT audience."
  type        = string
}

variable "supabase_jwks_url" {
  description = "Exact Supabase JWKS URL."
  type        = string
}

variable "database_secret_arn" {
  description = "Existing Secrets Manager ARN for the least-privilege runtime DB role."
  type        = string
  sensitive   = false
}

variable "database_secret_kms_key_arn" {
  description = "KMS key encrypting the runtime database secret."
  type        = string
}

variable "database_migration_secret_arn" {
  description = "Existing Secrets Manager ARN for the schema-only migration role."
  type        = string
  sensitive   = false
}

variable "database_migration_secret_kms_key_arn" {
  description = "KMS key encrypting the migration database secret."
  type        = string
}

variable "github_webhook_secret_arn" {
  description = "Existing Secrets Manager ARN containing only the GitHub webhook secret."
  type        = string
  sensitive   = false
}

variable "github_webhook_secret_kms_key_arn" {
  description = "KMS key encrypting the GitHub webhook secret."
  type        = string
}

variable "github_app_secret_arn" {
  description = "Existing Secrets Manager ARN containing the GitHub App ID and private key."
  type        = string
  sensitive   = false
}

variable "github_app_secret_kms_key_arn" {
  description = "KMS key encrypting the GitHub App secret."
  type        = string
}

variable "openai_identity_provider_id" {
  description = "Development OpenAI WIF provider ID; not a secret."
  type        = string
}

variable "openai_service_account_id" {
  description = "Development OpenAI service account ID; not a secret."
  type        = string
}

variable "openai_model" {
  description = "Recorded Stage 1 model alias or snapshot."
  type        = string
  default     = "gpt-5.6-sol"
}

variable "openai_project_alias" {
  description = "Non-secret project alias recorded with each run."
  type        = string
  default     = "development-agent"
}

variable "web_build_directory" {
  description = "Absolute or environment-relative path to built web assets."
  type        = string
  default     = "../../../../dist/web"
}

variable "service_build_directory" {
  description = "Path to bundled Lambda service JavaScript."
  type        = string
  default     = "../../../../dist/services"
}

variable "agent_image_digest" {
  description = "Immutable sha256 digest already pushed to the Stage 1 ECR repository."
  type        = string

  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.agent_image_digest))
    error_message = "agent_image_digest must be an immutable sha256 digest."
  }
}

variable "migrator_image_digest" {
  description = "Immutable sha256 digest of the reviewed database migrator image."
  type        = string

  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.migrator_image_digest))
    error_message = "migrator_image_digest must be an immutable sha256 digest."
  }
}
