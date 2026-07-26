data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "ecs_task_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "migration-api-development-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "outbox" {
  name               = "migration-api-development-outbox"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "workflow_control" {
  name               = "migration-api-development-workflow-control"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "github_webhook" {
  name               = "migration-api-development-github-webhook"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "github_token_broker" {
  name               = "migration-api-development-github-token-broker"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "github_reconciler" {
  name               = "migration-api-development-github-reconciler"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "repository_scan_control" {
  name               = "migration-api-development-repository-scan-control"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role" "agent_execution" {
  name               = "migration-api-development-agent-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
}

resource "aws_iam_role" "agent_task" {
  name               = "migration-api-development-agent-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
}

resource "aws_iam_role" "source_fetcher_execution" {
  name               = "migration-api-development-source-fetcher-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
}

resource "aws_iam_role" "source_fetcher_task" {
  name               = "migration-api-development-source-fetcher-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
}

resource "aws_iam_role" "vendor_fetcher_execution" {
  name               = "migration-api-development-vendor-fetcher-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
}

resource "aws_iam_role" "vendor_fetcher_task" {
  name               = "migration-api-development-vendor-fetcher-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
}

resource "aws_iam_role" "migrator_execution" {
  name               = "migration-api-development-migrator-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
}

resource "aws_iam_role" "migrator_task" {
  name               = "migration-api-development-migrator-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
}

locals {
  lambda_roles = {
    api                     = aws_iam_role.api.id
    outbox                  = aws_iam_role.outbox.id
    workflow_control        = aws_iam_role.workflow_control.id
    github_token_broker     = aws_iam_role.github_token_broker.id
    github_reconciler       = aws_iam_role.github_reconciler.id
    repository_scan_control = aws_iam_role.repository_scan_control.id
  }
}

data "aws_iam_policy_document" "lambda_vpc" {
  statement {
    sid = "VpcNetworkInterfaces"
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lambda_vpc" {
  for_each = local.lambda_roles
  name     = "vpc-network-interfaces"
  role     = each.value
  policy   = data.aws_iam_policy_document.lambda_vpc.json
}

data "aws_iam_policy_document" "database_secret" {
  statement {
    sid       = "ReadRuntimeDatabaseSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.database_secret_arn]
  }

  statement {
    sid       = "DecryptRuntimeDatabaseSecret"
    actions   = ["kms:Decrypt"]
    resources = [var.database_secret_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "api_database" {
  name   = "runtime-database"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.database_secret.json
}

resource "aws_iam_role_policy" "outbox_database" {
  name   = "runtime-database"
  role   = aws_iam_role.outbox.id
  policy = data.aws_iam_policy_document.database_secret.json
}

resource "aws_iam_role_policy" "workflow_database" {
  name   = "runtime-database"
  role   = aws_iam_role.workflow_control.id
  policy = data.aws_iam_policy_document.database_secret.json
}

resource "aws_iam_role_policy" "github_reconciler_database" {
  name   = "runtime-database"
  role   = aws_iam_role.github_reconciler.id
  policy = data.aws_iam_policy_document.database_secret.json
}

resource "aws_iam_role_policy" "repository_scan_control_database" {
  name   = "runtime-database"
  role   = aws_iam_role.repository_scan_control.id
  policy = data.aws_iam_policy_document.database_secret.json
}

data "aws_iam_policy_document" "api_artifacts" {
  statement {
    sid       = "ReadValidatedRunResult"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/env/development/org/*/run/*/result/final.json"]
  }

  statement {
    sid       = "DecryptRunResult"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.artifacts.arn]
  }
}

resource "aws_iam_role_policy" "api_artifacts" {
  name   = "read-run-results"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_artifacts.json
}

data "aws_iam_policy_document" "workflow_artifacts" {
  statement {
    sid       = "ReadAgentResult"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/env/development/org/*/run/*/result/final.json"]
  }

  statement {
    sid       = "DecryptAgentResult"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.artifacts.arn]
  }
}

resource "aws_iam_role_policy" "workflow_artifacts" {
  name   = "read-agent-results"
  role   = aws_iam_role.workflow_control.id
  policy = data.aws_iam_policy_document.workflow_artifacts.json
}

data "aws_iam_policy_document" "agent_execution" {
  statement {
    sid = "PullAgentImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer"
    ]
    resources = [data.aws_ecr_repository.agent.arn]
  }

  # ECR authorization tokens do not support resource-level permissions.
  statement {
    sid       = "EcrAuthorization"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "WriteAgentLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.agent.arn}:*"]
  }
}

resource "aws_iam_role_policy" "agent_execution" {
  name   = "agent-image-and-logs"
  role   = aws_iam_role.agent_execution.id
  policy = data.aws_iam_policy_document.agent_execution.json
}

data "aws_iam_policy_document" "agent_task" {
  statement {
    sid       = "ReadSyntheticEvidence"
    actions   = ["s3:GetObject"]
    resources = [aws_s3_object.synthetic_evidence.arn]
  }

  statement {
    sid       = "WriteRunResult"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/env/development/org/*/run/*/result/final.json"]
  }

  statement {
    sid = "ArtifactEncryption"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey"
    ]
    resources = [aws_kms_key.artifacts.arn]
  }

  # AWS STS requires Resource="*" for GetWebIdentityToken. Conditions bind the
  # token to OpenAI and cap its lifetime at five minutes.
  statement {
    sid       = "OpenAiWorkloadIdentity"
    actions   = ["sts:GetWebIdentityToken"]
    resources = ["*"]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "sts:IdentityTokenAudience"
      values   = ["https://api.openai.com/v1"]
    }

    condition {
      test     = "NumericLessThanEquals"
      variable = "sts:DurationSeconds"
      values   = ["300"]
    }
  }
}

resource "aws_iam_role_policy" "agent_task" {
  name   = "bounded-agent-runtime"
  role   = aws_iam_role.agent_task.id
  policy = data.aws_iam_policy_document.agent_task.json
}

data "aws_iam_policy_document" "source_fetcher_execution" {
  statement {
    sid = "PullSourceFetcherImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer"
    ]
    resources = [data.aws_ecr_repository.source_fetcher.arn]
  }

  # ECR authorization tokens do not support resource-level permissions.
  statement {
    sid       = "EcrAuthorization"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "WriteSourceFetcherLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.source_fetcher.arn}:*"]
  }
}

resource "aws_iam_role_policy" "source_fetcher_execution" {
  name   = "source-fetcher-image-and-logs"
  role   = aws_iam_role.source_fetcher_execution.id
  policy = data.aws_iam_policy_document.source_fetcher_execution.json
}

data "aws_iam_policy_document" "source_fetcher_task" {
  statement {
    sid       = "IssueExactRepositoryToken"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.github_token_broker.arn]
  }

  statement {
    sid       = "WriteRepositoryScanArtifacts"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/env/development/org/*/repository/*/scan/*"]
  }

  statement {
    sid       = "EncryptRepositoryScanArtifacts"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.artifacts.arn]
  }
}

resource "aws_iam_role_policy" "source_fetcher_task" {
  name   = "bounded-source-acquisition"
  role   = aws_iam_role.source_fetcher_task.id
  policy = data.aws_iam_policy_document.source_fetcher_task.json
}

data "aws_iam_policy_document" "vendor_fetcher_execution" {
  statement {
    sid = "PullVendorFetcherImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer"
    ]
    resources = [data.aws_ecr_repository.vendor_fetcher.arn]
  }

  # ECR authorization tokens do not support resource-level permissions.
  statement {
    sid       = "EcrAuthorization"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "WriteVendorFetcherLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.vendor_fetcher.arn}:*"]
  }
}

resource "aws_iam_role_policy" "vendor_fetcher_execution" {
  name   = "vendor-fetcher-image-and-logs"
  role   = aws_iam_role.vendor_fetcher_execution.id
  policy = data.aws_iam_policy_document.vendor_fetcher_execution.json
}

data "aws_iam_policy_document" "vendor_fetcher_task" {
  statement {
    sid       = "ReadRuntimeDatabaseSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.database_secret_arn]
  }

  statement {
    sid       = "DecryptRuntimeDatabaseSecret"
    actions   = ["kms:Decrypt"]
    resources = [var.database_secret_kms_key_arn]
  }

  statement {
    sid       = "WriteVendorEvidence"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/env/development/vendor/*"]
  }

  statement {
    sid       = "EncryptVendorEvidence"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.artifacts.arn]
  }
}

resource "aws_iam_role_policy" "vendor_fetcher_task" {
  name   = "bounded-vendor-ingestion"
  role   = aws_iam_role.vendor_fetcher_task.id
  policy = data.aws_iam_policy_document.vendor_fetcher_task.json
}

data "aws_iam_policy_document" "repository_scan_control_artifacts" {
  statement {
    sid       = "ReadRepositoryScanEvidence"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/env/development/org/*/repository/*/scan/*"]
  }

  statement {
    sid       = "DecryptRepositoryScanEvidence"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.artifacts.arn]
  }
}

resource "aws_iam_role_policy" "repository_scan_control_artifacts" {
  name   = "read-repository-scan-evidence"
  role   = aws_iam_role.repository_scan_control.id
  policy = data.aws_iam_policy_document.repository_scan_control_artifacts.json
}

data "aws_iam_policy_document" "migrator_execution" {
  statement {
    sid = "PullMigratorImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer"
    ]
    resources = [data.aws_ecr_repository.migrator.arn]
  }

  statement {
    sid       = "EcrAuthorization"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "WriteMigratorLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.migrator.arn}:*"]
  }
}

resource "aws_iam_role_policy" "migrator_execution" {
  name   = "migrator-image-and-logs"
  role   = aws_iam_role.migrator_execution.id
  policy = data.aws_iam_policy_document.migrator_execution.json
}

data "aws_iam_policy_document" "migrator_task" {
  statement {
    sid       = "ReadMigrationDatabaseSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.database_migration_secret_arn]
  }

  statement {
    sid       = "DecryptMigrationDatabaseSecret"
    actions   = ["kms:Decrypt"]
    resources = [var.database_migration_secret_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "migrator_task" {
  name   = "schema-migration-credential"
  role   = aws_iam_role.migrator_task.id
  policy = data.aws_iam_policy_document.migrator_task.json
}
