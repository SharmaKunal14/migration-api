provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Application        = "migration-api"
      Environment        = "development"
      Owner              = var.owner
      DataClassification = "internal"
      ManagedBy          = "terraform"
      Stage              = "1"
    }
  }
}

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "terraform_state" {
  description             = "Migration API development Terraform state"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "terraform_state" {
  name          = "alias/migration-api-development-terraform-state"
  target_key_id = aws_kms_key.terraform_state.key_id
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = var.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket                  = aws_s3_bucket.terraform_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.terraform_state.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.terraform_state.arn,
          "${aws_s3_bucket.terraform_state.arn}/*"
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      }
    ]
  })
}

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  github_repository_parts = split("/", var.github_repository)
  github_oidc_subject = format(
    "repo:%s@%s/%s@%s:environment:%s",
    local.github_repository_parts[0],
    var.github_repository_owner_id,
    local.github_repository_parts[1],
    var.github_repository_id,
    var.github_deployment_environment
  )
  github_ci_oidc_subject = format(
    "repo:%s@%s/%s@%s:ref:refs/heads/main",
    local.github_repository_parts[0],
    var.github_repository_owner_id,
    local.github_repository_parts[1],
    var.github_repository_id
  )
}

data "aws_iam_policy_document" "github_deploy_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_oidc_subject]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "migration-api-development-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_deploy_trust.json
}

data "aws_iam_policy_document" "github_ci_artifacts_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_ci_oidc_subject]
    }
  }
}

resource "aws_iam_role" "github_ci_artifacts" {
  name               = "migration-api-development-github-ci-artifacts"
  assume_role_policy = data.aws_iam_policy_document.github_ci_artifacts_trust.json
}

resource "aws_iam_service_linked_role" "network_firewall" {
  aws_service_name = "network-firewall.amazonaws.com"
  description      = "Allows AWS Network Firewall to manage development firewall resources."
}

# Stage 1 application resources are name-scoped. Several create APIs do not support
# resource-level permissions before a resource exists; those actions require "*".
data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid = "TerraformState"
    actions = [
      "s3:GetBucketLocation",
      "s3:GetBucketVersioning",
      "s3:ListBucket"
    ]
    resources = [aws_s3_bucket.terraform_state.arn]
  }

  statement {
    sid = "TerraformStateObjects"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject"
    ]
    resources = ["${aws_s3_bucket.terraform_state.arn}/development/*"]
  }

  statement {
    sid = "TerraformStateKms"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey"
    ]
    resources = [aws_kms_key.terraform_state.arn]
  }

  statement {
    sid = "NamedRoleManagement"
    actions = [
      "iam:AttachRolePolicy",
      "iam:CreatePolicy",
      "iam:CreateRole",
      "iam:DeletePolicy",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListPolicyVersions",
      "iam:ListRolePolicies",
      "iam:PassRole",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy"
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/migration-api-development-*",
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/migration-api-development-*"
    ]
  }

  # CloudWatch ListTagsForResource does not support resource-level permissions.
  statement {
    sid       = "DevelopmentAlarmTags"
    actions   = ["cloudwatch:ListTagsForResource"]
    resources = ["*"]
  }

  # KMS ListAliases does not support resource-level permissions.
  statement {
    sid       = "KmsAliasDiscovery"
    actions   = ["kms:ListAliases"]
    resources = ["*"]
  }

  statement {
    sid = "DevelopmentKmsData"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey"
    ]
    resources = ["arn:aws:kms:${var.aws_region}:${data.aws_caller_identity.current.account_id}:key/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Application"
      values   = ["migration-api"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Environment"
      values   = ["development"]
    }
  }

  statement {
    sid = "StageTwoWebhookQueues"
    actions = [
      "sqs:CreateQueue",
      "sqs:DeleteQueue",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ListQueueTags",
      "sqs:SetQueueAttributes",
      "sqs:TagQueue",
      "sqs:UntagQueue"
    ]
    resources = [
      "arn:aws:sqs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:migration-api-development-github-webhooks*"
    ]
  }

  statement {
    sid = "MigratorSuccessMarker"
    actions = [
      "ssm:AddTagsToResource",
      "ssm:DeleteParameter",
      "ssm:GetParameter",
      "ssm:ListTagsForResource",
      "ssm:PutParameter",
      "ssm:RemoveTagsFromResource"
    ]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/migration-api/development/deployment/last-successful-migrator-content-digest"
    ]
  }

  statement {
    sid = "StageOneInfrastructure"
    actions = [
      "acm:DescribeCertificate",
      "acm:ListTagsForCertificate",
      "apigateway:*",
      "cloudfront:*",
      "cloudwatch:DeleteAlarms",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:PutMetricAlarm",
      "ec2:*",
      "ecr:*",
      "ecs:*",
      "events:*",
      "firehose:*",
      "kms:CreateAlias",
      "kms:CreateGrant",
      "kms:CreateKey",
      "kms:DeleteAlias",
      "kms:DescribeKey",
      "kms:DisableKey",
      "kms:EnableKey",
      "kms:EnableKeyRotation",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListResourceTags",
      "kms:PutKeyPolicy",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "lambda:*",
      "logs:*",
      "network-firewall:*",
      "s3:*",
      "scheduler:*",
      "states:*",
      "wafv2:*"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "migration-api-development-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

data "aws_iam_policy_document" "github_ci_artifacts" {
  # ECR authorization tokens are registry-scoped and do not support resource ARNs.
  statement {
    sid       = "EcrAuthorization"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PublishAndInspectDevelopmentImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImageScanFindings",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:ListImages",
      "ecr:PutImage",
      "ecr:UploadLayerPart"
    ]
    resources = [
      for repository_name in [
        "agent",
        "database-migrator",
        "source-fetcher",
        "vendor-fetcher",
        "change-intelligence-agent",
        "impact-analysis-agent",
        "migration-agent"
      ] :
      "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/migration-api-development-${repository_name}"
    ]
  }
}

resource "aws_iam_role_policy" "github_ci_artifacts" {
  name   = "migration-api-development-ci-artifacts"
  role   = aws_iam_role.github_ci_artifacts.id
  policy = data.aws_iam_policy_document.github_ci_artifacts.json
}

output "state_bucket" {
  value = aws_s3_bucket.terraform_state.bucket
}

output "state_kms_key_arn" {
  value = aws_kms_key.terraform_state.arn
}

output "github_deploy_role_arn" {
  value = aws_iam_role.github_deploy.arn
}

output "github_oidc_subject" {
  description = "Exact immutable GitHub Actions OIDC subject trusted by the deployment role."
  value       = local.github_oidc_subject
}

output "github_ci_artifacts_role_arn" {
  value = aws_iam_role.github_ci_artifacts.arn
}

output "github_ci_oidc_subject" {
  description = "Exact immutable main-branch OIDC subject trusted by the CI artifact role."
  value       = local.github_ci_oidc_subject
}
