variable "aws_region" {
  description = "Recorded development AWS region."
  type        = string
}

variable "owner" {
  description = "Resource owner tag."
  type        = string
}

variable "state_bucket_name" {
  description = "Globally unique Terraform state bucket name."
  type        = string
}

variable "github_repository" {
  description = "Exact GitHub repository in owner/name form."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must use owner/name form."
  }
}

variable "github_repository_owner_id" {
  description = "Immutable numeric GitHub owner ID used in the Actions OIDC subject."
  type        = string

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.github_repository_owner_id))
    error_message = "github_repository_owner_id must be a positive numeric GitHub owner ID."
  }
}

variable "github_repository_id" {
  description = "Immutable numeric GitHub repository ID used in the Actions OIDC subject."
  type        = string

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.github_repository_id))
    error_message = "github_repository_id must be a positive numeric GitHub repository ID."
  }
}

variable "github_deployment_environment" {
  description = "Exact protected GitHub environment allowed to deploy."
  type        = string
  default     = "development"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+$", var.github_deployment_environment))
    error_message = "github_deployment_environment contains unsupported characters."
  }
}
