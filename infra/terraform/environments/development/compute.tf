resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/migration-api-development-api"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "outbox" {
  name              = "/aws/lambda/migration-api-development-outbox"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "workflow_control" {
  name              = "/aws/lambda/migration-api-development-workflow-control"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "github_webhook" {
  name              = "/aws/lambda/migration-api-development-github-webhook"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "github_token_broker" {
  name              = "/aws/lambda/migration-api-development-github-token-broker"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "github_reconciler" {
  name              = "/aws/lambda/migration-api-development-github-reconciler"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "repository_scan_control" {
  name              = "/aws/lambda/migration-api-development-repository-scan-control"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "agent" {
  name              = "/migration-api/development/agent"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "source_fetcher" {
  name              = "/migration-api/development/source-fetcher"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "vendor_fetcher" {
  name              = "/migration-api/development/vendor-fetcher"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "vendor_intelligence_control" {
  name              = "/aws/lambda/migration-api-development-vendor-intelligence-control"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "change_intelligence_agent" {
  name              = "/migration-api/development/change-intelligence-agent"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "impact_analysis_control" {
  name              = "/aws/lambda/migration-api-development-impact-analysis-control"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "impact_analysis_agent" {
  name              = "/migration-api/development/impact-analysis-agent"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "migration_agent" {
  name              = "/migration-api/development/migration-agent"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "verifier" {
  name              = "/migration-api/development/verifier"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "migrator" {
  name              = "/migration-api/development/database-migrator"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_cloudwatch_log_group" "workflow" {
  name              = "/migration-api/development/workflow"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

locals {
  lambda_log_groups = {
    api = {
      role = aws_iam_role.api.id
      arn  = aws_cloudwatch_log_group.api.arn
    }
    outbox = {
      role = aws_iam_role.outbox.id
      arn  = aws_cloudwatch_log_group.outbox.arn
    }
    workflow_control = {
      role = aws_iam_role.workflow_control.id
      arn  = aws_cloudwatch_log_group.workflow_control.arn
    }
    github_webhook = {
      role = aws_iam_role.github_webhook.id
      arn  = aws_cloudwatch_log_group.github_webhook.arn
    }
    github_token_broker = {
      role = aws_iam_role.github_token_broker.id
      arn  = aws_cloudwatch_log_group.github_token_broker.arn
    }
    github_reconciler = {
      role = aws_iam_role.github_reconciler.id
      arn  = aws_cloudwatch_log_group.github_reconciler.arn
    }
    repository_scan_control = {
      role = aws_iam_role.repository_scan_control.id
      arn  = aws_cloudwatch_log_group.repository_scan_control.arn
    }
    vendor_intelligence_control = {
      role = aws_iam_role.vendor_intelligence_control.id
      arn  = aws_cloudwatch_log_group.vendor_intelligence_control.arn
    }
    impact_analysis_control = {
      role = aws_iam_role.impact_analysis_control.id
      arn  = aws_cloudwatch_log_group.impact_analysis_control.arn
    }
  }
}

data "aws_iam_policy_document" "lambda_logs" {
  for_each = local.lambda_log_groups

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${each.value.arn}:*"]
  }
}

resource "aws_iam_role_policy" "lambda_logs" {
  for_each = local.lambda_log_groups
  name     = "structured-logs"
  role     = each.value.role
  policy   = data.aws_iam_policy_document.lambda_logs[each.key].json
}

data "archive_file" "api" {
  type        = "zip"
  output_path = "${path.module}/.terraform/api.zip"

  source {
    content  = file("${var.service_build_directory}/api.js")
    filename = "index.mjs"
  }
}

data "archive_file" "outbox" {
  type        = "zip"
  output_path = "${path.module}/.terraform/outbox.zip"

  source {
    content  = file("${var.service_build_directory}/outbox-dispatcher.js")
    filename = "index.mjs"
  }
}

data "archive_file" "workflow_control" {
  type        = "zip"
  output_path = "${path.module}/.terraform/workflow-control.zip"

  source {
    content  = file("${var.service_build_directory}/workflow-control.js")
    filename = "index.mjs"
  }
}

data "archive_file" "github_webhook" {
  type        = "zip"
  output_path = "${path.module}/.terraform/github-webhook.zip"

  source {
    content  = file("${var.service_build_directory}/github-webhook.js")
    filename = "index.mjs"
  }
}

data "archive_file" "github_token_broker" {
  type        = "zip"
  output_path = "${path.module}/.terraform/github-token-broker.zip"

  source {
    content  = file("${var.service_build_directory}/github-token-broker.js")
    filename = "index.mjs"
  }
}

data "archive_file" "github_reconciler" {
  type        = "zip"
  output_path = "${path.module}/.terraform/github-reconciler.zip"

  source {
    content  = file("${var.service_build_directory}/github-reconciler.js")
    filename = "index.mjs"
  }
}

data "archive_file" "repository_scan_control" {
  type        = "zip"
  output_path = "${path.module}/.terraform/repository-scan-control.zip"

  source {
    content  = file("${var.service_build_directory}/repository-scan-control.js")
    filename = "index.mjs"
  }
}

data "archive_file" "vendor_intelligence_control" {
  type        = "zip"
  output_path = "${path.module}/.terraform/vendor-intelligence-control.zip"

  source {
    content  = file("${var.service_build_directory}/vendor-intelligence-control.js")
    filename = "index.mjs"
  }
}

data "archive_file" "impact_analysis_control" {
  type        = "zip"
  output_path = "${path.module}/.terraform/impact-analysis-control.zip"

  source {
    content  = file("${var.service_build_directory}/impact-analysis-control.js")
    filename = "index.mjs"
  }
}

resource "aws_lambda_function" "api" {
  function_name                  = "migration-api-development-api"
  role                           = aws_iam_role.api.arn
  handler                        = "index.handler"
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.api.output_path
  source_code_hash               = data.archive_file.api.output_base64sha256
  memory_size                    = 512
  timeout                        = 15
  reserved_concurrent_executions = 10

  environment {
    variables = {
      APP_ENVIRONMENT                   = "development"
      ARTIFACT_BUCKET                   = aws_s3_bucket.artifacts.bucket
      ARTIFACT_KMS_KEY_ARN              = aws_kms_key.artifacts.arn
      DATABASE_SECRET_ARN               = var.database_secret_arn
      GITHUB_APP_SLUG                   = var.github_app_slug
      GITHUB_TOKEN_BROKER_FUNCTION_NAME = aws_lambda_function.github_token_broker.function_name
      OPENAI_MODEL                      = var.openai_model
      SUPABASE_JWT_AUDIENCE             = var.supabase_jwt_audience
      SUPABASE_JWT_ISSUER               = var.supabase_jwt_issuer
      SUPABASE_JWKS_URL                 = var.supabase_jwks_url
      NODE_OPTIONS                      = "--enable-source-maps"
    }
  }

  vpc_config {
    security_group_ids = [aws_security_group.control.id]
    subnet_ids         = [for subnet in aws_subnet.control : subnet.id]
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

resource "aws_lambda_function" "github_webhook" {
  function_name                  = "migration-api-development-github-webhook"
  role                           = aws_iam_role.github_webhook.arn
  handler                        = "index.handler"
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.github_webhook.output_path
  source_code_hash               = data.archive_file.github_webhook.output_base64sha256
  memory_size                    = 256
  timeout                        = 10
  reserved_concurrent_executions = 10

  environment {
    variables = {
      APP_ENVIRONMENT           = "development"
      GITHUB_WEBHOOK_QUEUE_URL  = aws_sqs_queue.github_webhooks.url
      GITHUB_WEBHOOK_SECRET_ARN = var.github_webhook_secret_arn
      NODE_OPTIONS              = "--enable-source-maps"
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.github_webhook]
}

resource "aws_lambda_function" "github_token_broker" {
  function_name                  = "migration-api-development-github-token-broker"
  role                           = aws_iam_role.github_token_broker.arn
  handler                        = "index.handler"
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.github_token_broker.output_path
  source_code_hash               = data.archive_file.github_token_broker.output_base64sha256
  memory_size                    = 256
  timeout                        = 15
  reserved_concurrent_executions = 10

  environment {
    variables = {
      APP_ENVIRONMENT       = "development"
      DATABASE_SECRET_ARN   = var.database_secret_arn
      GITHUB_APP_SECRET_ARN = var.github_app_secret_arn
      NODE_OPTIONS          = "--enable-source-maps"
    }
  }

  vpc_config {
    security_group_ids = [aws_security_group.control.id]
    subnet_ids         = [for subnet in aws_subnet.control : subnet.id]
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.github_token_broker]
}

resource "aws_lambda_function" "github_reconciler" {
  function_name                  = "migration-api-development-github-reconciler"
  role                           = aws_iam_role.github_reconciler.arn
  handler                        = "index.handler"
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.github_reconciler.output_path
  source_code_hash               = data.archive_file.github_reconciler.output_base64sha256
  memory_size                    = 256
  timeout                        = 60
  reserved_concurrent_executions = 2

  environment {
    variables = {
      APP_ENVIRONMENT                   = "development"
      DATABASE_SECRET_ARN               = var.database_secret_arn
      GITHUB_TOKEN_BROKER_FUNCTION_NAME = aws_lambda_function.github_token_broker.function_name
      NODE_OPTIONS                      = "--enable-source-maps"
    }
  }

  vpc_config {
    security_group_ids = [aws_security_group.control.id]
    subnet_ids         = [for subnet in aws_subnet.control : subnet.id]
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.github_reconciler,
    aws_iam_role_policy.github_reconciler_database,
    aws_iam_role_policy.lambda_vpc["github_reconciler"]
  ]
}

resource "aws_lambda_event_source_mapping" "github_reconciler" {
  event_source_arn                   = aws_sqs_queue.github_webhooks.arn
  function_name                      = aws_lambda_function.github_reconciler.arn
  batch_size                         = 5
  maximum_batching_window_in_seconds = 1
  function_response_types            = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }

  depends_on = [aws_iam_role_policy.github_reconciler_runtime]
}

resource "aws_lambda_function" "repository_scan_control" {
  function_name                  = "migration-api-development-repository-scan-control"
  role                           = aws_iam_role.repository_scan_control.arn
  handler                        = "index.handler"
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.repository_scan_control.output_path
  source_code_hash               = data.archive_file.repository_scan_control.output_base64sha256
  memory_size                    = 512
  timeout                        = 30
  reserved_concurrent_executions = 5

  environment {
    variables = {
      APP_ENVIRONMENT     = "development"
      ARTIFACT_BUCKET     = aws_s3_bucket.artifacts.bucket
      DATABASE_SECRET_ARN = var.database_secret_arn
      NODE_OPTIONS        = "--enable-source-maps"
    }
  }

  vpc_config {
    security_group_ids = [aws_security_group.control.id]
    subnet_ids         = [for subnet in aws_subnet.control : subnet.id]
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.repository_scan_control,
    aws_iam_role_policy.repository_scan_control_database,
    aws_iam_role_policy.repository_scan_control_artifacts,
    aws_iam_role_policy.lambda_vpc["repository_scan_control"]
  ]
}

resource "aws_lambda_function" "vendor_intelligence_control" {
  function_name                  = "migration-api-development-vendor-intelligence-control"
  role                           = aws_iam_role.vendor_intelligence_control.arn
  handler                        = "index.handler"
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.vendor_intelligence_control.output_path
  source_code_hash               = data.archive_file.vendor_intelligence_control.output_base64sha256
  memory_size                    = 512
  timeout                        = 30
  reserved_concurrent_executions = 2

  environment {
    variables = {
      APP_ENVIRONMENT     = "development"
      ARTIFACT_BUCKET     = aws_s3_bucket.artifacts.bucket
      DATABASE_SECRET_ARN = var.database_secret_arn
      OPENAI_MODEL        = var.openai_model
      NODE_OPTIONS        = "--enable-source-maps"
    }
  }

  vpc_config {
    security_group_ids = [aws_security_group.control.id]
    subnet_ids         = [for subnet in aws_subnet.control : subnet.id]
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.vendor_intelligence_control,
    aws_iam_role_policy.vendor_intelligence_control_database,
    aws_iam_role_policy.vendor_intelligence_control_artifacts,
    aws_iam_role_policy.lambda_vpc["vendor_intelligence_control"]
  ]
}

resource "aws_lambda_function" "impact_analysis_control" {
  function_name                  = "migration-api-development-impact-analysis-control"
  role                           = aws_iam_role.impact_analysis_control.arn
  handler                        = "index.handler"
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.impact_analysis_control.output_path
  source_code_hash               = data.archive_file.impact_analysis_control.output_base64sha256
  memory_size                    = 512
  timeout                        = 30
  reserved_concurrent_executions = 2

  environment {
    variables = {
      APP_ENVIRONMENT      = "development"
      ARTIFACT_BUCKET      = aws_s3_bucket.artifacts.bucket
      ARTIFACT_KMS_KEY_ARN = aws_kms_key.artifacts.arn
      DATABASE_SECRET_ARN  = var.database_secret_arn
      OPENAI_MODEL         = var.openai_model
      NODE_OPTIONS         = "--enable-source-maps"
    }
  }

  vpc_config {
    security_group_ids = [aws_security_group.control.id]
    subnet_ids         = [for subnet in aws_subnet.control : subnet.id]
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.impact_analysis_control,
    aws_iam_role_policy.impact_analysis_control_database,
    aws_iam_role_policy.impact_analysis_control_artifacts,
    aws_iam_role_policy.lambda_vpc["impact_analysis_control"]
  ]
}

resource "aws_lambda_function" "outbox" {
  function_name                  = "migration-api-development-outbox"
  role                           = aws_iam_role.outbox.arn
  handler                        = "index.handler"
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.outbox.output_path
  source_code_hash               = data.archive_file.outbox.output_base64sha256
  memory_size                    = 256
  timeout                        = 30
  reserved_concurrent_executions = 1

  environment {
    variables = {
      APP_ENVIRONMENT                   = "development"
      DATABASE_SECRET_ARN               = var.database_secret_arn
      MIGRATION_STATE_MACHINE_ARN       = aws_sfn_state_machine.migration.arn
      STATE_MACHINE_ARN                 = aws_sfn_state_machine.agent.arn
      REPOSITORY_SCAN_STATE_MACHINE_ARN = aws_sfn_state_machine.repository_scan.arn
      NODE_OPTIONS                      = "--enable-source-maps"
    }
  }

  vpc_config {
    security_group_ids = [aws_security_group.control.id]
    subnet_ids         = [for subnet in aws_subnet.control : subnet.id]
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.outbox]
}

resource "aws_lambda_function" "workflow_control" {
  function_name                  = "migration-api-development-workflow-control"
  role                           = aws_iam_role.workflow_control.arn
  handler                        = "index.handler"
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.workflow_control.output_path
  source_code_hash               = data.archive_file.workflow_control.output_base64sha256
  memory_size                    = 512
  timeout                        = 30
  reserved_concurrent_executions = 5

  environment {
    variables = {
      APP_ENVIRONMENT       = "development"
      ARTIFACT_BUCKET       = aws_s3_bucket.artifacts.bucket
      ARTIFACT_KMS_KEY_ARN  = aws_kms_key.artifacts.arn
      DATABASE_SECRET_ARN   = var.database_secret_arn
      VERIFIER_REGISTRY_URL = var.verifier_registry_url
      NODE_OPTIONS          = "--enable-source-maps"
    }
  }

  vpc_config {
    security_group_ids = [aws_security_group.control.id]
    subnet_ids         = [for subnet in aws_subnet.control : subnet.id]
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.workflow_control]
}

resource "aws_ecs_cluster" "agent" {
  name = "migration-api-development-agent"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_task_definition" "agent" {
  family                   = "migration-api-development-agent"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.agent_execution.arn
  task_role_arn            = aws_iam_role.agent_task.arn

  ephemeral_storage {
    size_in_gib = 21
  }

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name                   = "agent"
      image                  = "${data.aws_ecr_repository.agent.repository_url}@${var.agent_image_digest}"
      essential              = true
      readonlyRootFilesystem = true
      user                   = "1000:1000"
      stopTimeout            = 30
      linuxParameters = {
        initProcessEnabled = true
        capabilities = {
          drop = ["ALL"]
        }
      }
      environment = [
        { name = "APP_ENVIRONMENT", value = "development" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_STS_REGIONAL_ENDPOINTS", value = "regional" },
        { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket },
        { name = "ARTIFACT_KMS_KEY_ARN", value = aws_kms_key.artifacts.arn },
        { name = "OPENAI_IDENTITY_PROVIDER_ID", value = var.openai_identity_provider_id },
        { name = "OPENAI_SERVICE_ACCOUNT_ID", value = var.openai_service_account_id },
        { name = "OPENAI_WIF_AUDIENCE", value = "https://api.openai.com/v1" },
        { name = "OPENAI_MODEL", value = var.openai_model },
        { name = "OPENAI_PROJECT_ALIAS", value = var.openai_project_alias }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.agent.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "agent"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "source_fetcher" {
  family                   = "migration-api-development-source-fetcher"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.source_fetcher_execution.arn
  task_role_arn            = aws_iam_role.source_fetcher_task.arn

  ephemeral_storage {
    size_in_gib = 21
  }

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "workspace"
  }

  container_definitions = jsonencode([
    {
      name                   = "source-fetcher"
      image                  = "${data.aws_ecr_repository.source_fetcher.repository_url}@${var.source_fetcher_image_digest}"
      essential              = true
      readonlyRootFilesystem = true
      user                   = "1000:1000"
      stopTimeout            = 30
      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { drop = ["ALL"] }
      }
      mountPoints = [
        {
          sourceVolume  = "workspace"
          containerPath = "/workspace"
          readOnly      = false
        }
      ]
      environment = [
        { name = "ACQUISITION_MODE", value = "repository_scan" },
        { name = "APP_ENVIRONMENT", value = "development" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_STS_REGIONAL_ENDPOINTS", value = "regional" },
        { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket },
        { name = "ARTIFACT_KMS_KEY_ARN", value = aws_kms_key.artifacts.arn },
        { name = "GITHUB_TOKEN_BROKER_FUNCTION_NAME", value = aws_lambda_function.github_token_broker.function_name },
        { name = "WORKSPACE_DIRECTORY", value = "/workspace" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.source_fetcher.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "source-fetcher"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "vendor_fetcher" {
  family                   = "migration-api-development-vendor-fetcher"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.vendor_fetcher_execution.arn
  task_role_arn            = aws_iam_role.vendor_fetcher_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name                   = "vendor-fetcher"
      image                  = "${data.aws_ecr_repository.vendor_fetcher.repository_url}@${var.vendor_fetcher_image_digest}"
      essential              = true
      readonlyRootFilesystem = true
      user                   = "1000:1000"
      stopTimeout            = 30
      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { drop = ["ALL"] }
      }
      environment = [
        { name = "APP_ENVIRONMENT", value = "development" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_STS_REGIONAL_ENDPOINTS", value = "regional" },
        { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket },
        { name = "ARTIFACT_KMS_KEY_ARN", value = aws_kms_key.artifacts.arn },
        { name = "DATABASE_SECRET_ARN", value = var.database_secret_arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.vendor_fetcher.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "vendor-fetcher"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "change_intelligence_agent" {
  family                   = "migration-api-development-change-intelligence-agent"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.change_intelligence_execution.arn
  task_role_arn            = aws_iam_role.change_intelligence_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name                   = "change-intelligence-agent"
      image                  = "${data.aws_ecr_repository.change_intelligence_agent.repository_url}@${var.change_intelligence_agent_image_digest}"
      essential              = true
      readonlyRootFilesystem = true
      user                   = "10001:10001"
      stopTimeout            = 30
      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { drop = ["ALL"] }
      }
      environment = [
        { name = "APP_ENVIRONMENT", value = "development" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_STS_REGIONAL_ENDPOINTS", value = "regional" },
        { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket },
        { name = "ARTIFACT_KMS_KEY_ARN", value = aws_kms_key.artifacts.arn },
        { name = "OPENAI_IDENTITY_PROVIDER_ID", value = var.change_intelligence_openai_identity_provider_id },
        { name = "OPENAI_SERVICE_ACCOUNT_ID", value = var.change_intelligence_openai_service_account_id },
        { name = "OPENAI_WIF_AUDIENCE", value = "https://api.openai.com/v1" },
        { name = "OPENAI_MODEL", value = var.openai_model },
        { name = "OPENAI_PROJECT_ALIAS", value = "development-change-intelligence" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.change_intelligence_agent.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "change-intelligence"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "impact_analysis_agent" {
  family                   = "migration-api-development-impact-analysis-agent"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.impact_analysis_execution.arn
  task_role_arn            = aws_iam_role.impact_analysis_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name                   = "impact-analysis-agent"
      image                  = "${data.aws_ecr_repository.impact_analysis_agent.repository_url}@${var.impact_analysis_agent_image_digest}"
      essential              = true
      readonlyRootFilesystem = true
      user                   = "10001:10001"
      stopTimeout            = 30
      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { drop = ["ALL"] }
      }
      environment = [
        { name = "APP_ENVIRONMENT", value = "development" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_STS_REGIONAL_ENDPOINTS", value = "regional" },
        { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket },
        { name = "ARTIFACT_KMS_KEY_ARN", value = aws_kms_key.artifacts.arn },
        { name = "OPENAI_IDENTITY_PROVIDER_ID", value = var.impact_analysis_openai_identity_provider_id },
        { name = "OPENAI_SERVICE_ACCOUNT_ID", value = var.impact_analysis_openai_service_account_id },
        { name = "OPENAI_WIF_AUDIENCE", value = "https://api.openai.com/v1" },
        { name = "OPENAI_MODEL", value = var.openai_model },
        { name = "OPENAI_PROJECT_ALIAS", value = "development-impact-analysis" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.impact_analysis_agent.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "impact-analysis"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "migration_agent" {
  family                   = "migration-api-development-migration-agent"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.migration_agent_execution.arn
  task_role_arn            = aws_iam_role.migration_agent_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name                   = "migration-agent"
      image                  = "${data.aws_ecr_repository.migration_agent.repository_url}@${var.migration_agent_image_digest}"
      essential              = true
      readonlyRootFilesystem = true
      user                   = "10001:10001"
      stopTimeout            = 30
      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { drop = ["ALL"] }
      }
      environment = [
        { name = "APP_ENVIRONMENT", value = "development" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_STS_REGIONAL_ENDPOINTS", value = "regional" },
        { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket },
        { name = "ARTIFACT_KMS_KEY_ARN", value = aws_kms_key.artifacts.arn },
        { name = "OPENAI_IDENTITY_PROVIDER_ID", value = var.migration_agent_openai_identity_provider_id },
        { name = "OPENAI_SERVICE_ACCOUNT_ID", value = var.migration_agent_openai_service_account_id },
        { name = "OPENAI_WIF_AUDIENCE", value = "https://api.openai.com/v1" },
        { name = "OPENAI_MODEL", value = var.openai_model },
        { name = "OPENAI_PROJECT_ALIAS", value = "development-migration-agent" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.migration_agent.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "migration-agent"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "verifier" {
  family                   = "migration-api-development-verifier"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.verifier_execution.arn

  ephemeral_storage {
    size_in_gib = 21
  }

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "workspace"
  }

  container_definitions = jsonencode([
    {
      name                   = "verifier"
      image                  = "${data.aws_ecr_repository.verifier.repository_url}@${var.verifier_image_digest}"
      essential              = true
      readonlyRootFilesystem = true
      privileged             = false
      user                   = "10001:10001"
      stopTimeout            = 30
      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { drop = ["ALL"] }
      }
      mountPoints = [
        {
          sourceVolume  = "workspace"
          containerPath = "/workspace"
          readOnly      = false
        }
      ]
      ulimits = [
        {
          name      = "nproc"
          softLimit = 256
          hardLimit = 256
        },
        {
          name      = "nofile"
          softLimit = 1024
          hardLimit = 1024
        }
      ]
      environment = [
        { name = "APP_ENVIRONMENT", value = "development" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.verifier.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "verifier"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "migrator" {
  family                   = "migration-api-development-database-migrator"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.migrator_execution.arn
  task_role_arn            = aws_iam_role.migrator_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name                   = "database-migrator"
      image                  = "${data.aws_ecr_repository.migrator.repository_url}@${var.migrator_image_digest}"
      essential              = true
      readonlyRootFilesystem = true
      user                   = "1000:1000"
      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { drop = ["ALL"] }
      }
      environment = [
        { name = "APP_ENVIRONMENT", value = "development" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "DATABASE_MIGRATION_SECRET_ARN", value = var.database_migration_secret_arn },
        { name = "MIGRATIONS_DIRECTORY", value = "/app/migrations" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.migrator.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "migration"
        }
      }
    }
  ])
}

data "aws_iam_policy_document" "step_functions_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "step_functions" {
  name               = "migration-api-development-step-functions"
  assume_role_policy = data.aws_iam_policy_document.step_functions_trust.json
}

data "aws_iam_policy_document" "step_functions" {
  statement {
    sid     = "WorkflowControl"
    actions = ["lambda:InvokeFunction"]
    resources = [
      aws_lambda_function.workflow_control.arn,
      aws_lambda_function.repository_scan_control.arn,
      aws_lambda_function.vendor_intelligence_control.arn,
      aws_lambda_function.impact_analysis_control.arn
    ]
  }

  statement {
    sid     = "RunAgentTask"
    actions = ["ecs:RunTask"]
    resources = [
      aws_ecs_task_definition.agent.arn,
      aws_ecs_task_definition.source_fetcher.arn,
      aws_ecs_task_definition.vendor_fetcher.arn,
      aws_ecs_task_definition.change_intelligence_agent.arn,
      aws_ecs_task_definition.impact_analysis_agent.arn,
      aws_ecs_task_definition.migration_agent.arn,
      aws_ecs_task_definition.verifier.arn
    ]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.agent.arn]
    }
  }

  statement {
    sid       = "StopAndDescribeAgentTask"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.agent.name}/*"]
  }

  statement {
    sid     = "PassExactAgentRoles"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.agent_execution.arn,
      aws_iam_role.agent_task.arn,
      aws_iam_role.source_fetcher_execution.arn,
      aws_iam_role.source_fetcher_task.arn,
      aws_iam_role.vendor_fetcher_execution.arn,
      aws_iam_role.vendor_fetcher_task.arn,
      aws_iam_role.change_intelligence_execution.arn,
      aws_iam_role.change_intelligence_task.arn,
      aws_iam_role.impact_analysis_execution.arn,
      aws_iam_role.impact_analysis_task.arn,
      aws_iam_role.migration_agent_execution.arn,
      aws_iam_role.migration_agent_task.arn,
      aws_iam_role.verifier_execution.arn
    ]
  }

  # Step Functions .sync uses service-managed EventBridge rules whose ARNs are
  # not exposed before execution; AWS requires wildcard resource scope.
  statement {
    sid = "EcsSyncEvents"
    actions = [
      "events:DescribeRule",
      "events:PutRule",
      "events:PutTargets"
    ]
    resources = ["*"]
  }

  statement {
    sid       = "WorkflowLogs"
    actions   = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "step_functions" {
  name   = "stage-one-agent-workflow"
  role   = aws_iam_role.step_functions.id
  policy = data.aws_iam_policy_document.step_functions.json
}

resource "aws_sfn_state_machine" "agent" {
  name     = "migration-api-development-agent"
  role_arn = aws_iam_role.step_functions.arn
  type     = "STANDARD"

  logging_configuration {
    include_execution_data = false
    level                  = "ERROR"
    log_destination        = "${aws_cloudwatch_log_group.workflow.arn}:*"
  }

  tracing_configuration {
    enabled = true
  }

  definition = jsonencode({
    Comment = "Stage 1 bounded synthetic Change Intelligence Agent"
    StartAt = "MarkStarted"
    States = {
      MarkStarted = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "mark_started"
            "workflow.$" = "$"
          }
        }
        ResultPath = null
        Retry = [
          {
            ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
            IntervalSeconds = 2
            BackoffRate     = 2
            MaxAttempts     = 3
          }
        ]
        Catch = [{ ErrorEquals = ["States.ALL"], Next = "MarkInfrastructureFailure", ResultPath = null }]
        Next  = "RunAgent"
      }
      RunAgent = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 600
        Parameters = {
          Cluster        = aws_ecs_cluster.agent.arn
          TaskDefinition = aws_ecs_task_definition.agent.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.agent.id]
              Subnets        = [for subnet in aws_subnet.agent : subnet.id]
            }
          }
          Overrides = {
            ContainerOverrides = [
              {
                Name = "agent"
                Environment = [
                  { Name = "ORGANISATION_ID", "Value.$" = "$.organisationId" },
                  { Name = "AGENT_RUN_ID", "Value.$" = "$.agentRunId" }
                ]
              }
            ]
          }
        }
        ResultPath = null
        Catch      = [{ ErrorEquals = ["States.ALL"], Next = "MarkInfrastructureFailure", ResultPath = null }]
        Next       = "IngestResult"
      }
      IngestResult = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "ingest_result"
            "workflow.$" = "$"
          }
        }
        ResultPath = null
        Retry = [
          {
            ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
            IntervalSeconds = 2
            BackoffRate     = 2
            MaxAttempts     = 3
          }
        ]
        Catch = [{ ErrorEquals = ["States.ALL"], Next = "MarkInfrastructureFailure", ResultPath = null }]
        End   = true
      }
      MarkInfrastructureFailure = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation     = "mark_failed"
            "workflow.$"  = "$"
            terminalCode  = "infrastructure_failed"
            safeErrorCode = "WORKFLOW_TASK_FAILED"
          }
        }
        ResultPath = null
        End        = true
      }
    }
  })
}

resource "aws_sfn_state_machine" "repository_scan" {
  name     = "migration-api-development-repository-scan"
  role_arn = aws_iam_role.step_functions.arn
  type     = "STANDARD"

  logging_configuration {
    include_execution_data = false
    level                  = "ERROR"
    log_destination        = "${aws_cloudwatch_log_group.workflow.arn}:*"
  }

  tracing_configuration {
    enabled = true
  }

  definition = jsonencode({
    Comment = "Stage 2C exact-commit repository acquisition and npm inventory"
    StartAt = "MarkStarted"
    States = {
      MarkStarted = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.repository_scan_control.arn
          Payload = {
            operation    = "mark_started"
            "workflow.$" = "$"
          }
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{ ErrorEquals = ["States.ALL"], Next = "MarkInfrastructureFailure", ResultPath = null }]
        Next  = "AcquireSnapshot"
      }
      AcquireSnapshot = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 600
        Parameters = {
          Cluster        = aws_ecs_cluster.agent.arn
          TaskDefinition = aws_ecs_task_definition.source_fetcher.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.source_fetcher.id]
              Subnets        = [for subnet in aws_subnet.source_fetcher : subnet.id]
            }
          }
          Overrides = {
            ContainerOverrides = [{
              Name = "source-fetcher"
              Environment = [
                { Name = "ORGANISATION_ID", "Value.$" = "$.organisationId" },
                { Name = "REPOSITORY_ID", "Value.$" = "$.repositoryId" },
                { Name = "REPOSITORY_SCAN_ID", "Value.$" = "$.repositoryScanId" }
              ]
            }]
          }
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["ECS.AmazonECSException", "ECS.ThrottlingException"]
          IntervalSeconds = 5
          BackoffRate     = 2
          MaxAttempts     = 2
        }]
        Catch = [{ ErrorEquals = ["States.ALL"], Next = "MarkInfrastructureFailure", ResultPath = null }]
        Next  = "IngestResult"
      }
      IngestResult = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.repository_scan_control.arn
          Payload = {
            operation    = "ingest_result"
            "workflow.$" = "$"
          }
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{ ErrorEquals = ["States.ALL"], Next = "MarkInfrastructureFailure", ResultPath = null }]
        End   = true
      }
      MarkInfrastructureFailure = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.repository_scan_control.arn
          Payload = {
            operation     = "mark_failed"
            "workflow.$"  = "$"
            safeErrorCode = "REPOSITORY_SCAN_INFRASTRUCTURE_FAILED"
          }
        }
        ResultPath = null
        End        = true
      }
    }
  })
}

resource "aws_sfn_state_machine" "vendor_ingestion" {
  name     = "migration-api-development-vendor-ingestion"
  role_arn = aws_iam_role.step_functions.arn
  type     = "STANDARD"

  logging_configuration {
    include_execution_data = false
    level                  = "ERROR"
    log_destination        = "${aws_cloudwatch_log_group.workflow.arn}:*"
  }

  tracing_configuration {
    enabled = true
  }

  definition = jsonencode({
    Comment = "Stage 3B bounded and idempotent trusted-vendor evidence ingestion"
    StartAt = "FetchVendorEvidence"
    States = {
      FetchVendorEvidence = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 300
        Parameters = {
          Cluster        = aws_ecs_cluster.agent.arn
          TaskDefinition = aws_ecs_task_definition.vendor_fetcher.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.vendor_fetcher.id]
              Subnets        = [for subnet in aws_subnet.control : subnet.id]
            }
          }
          Overrides = {
            ContainerOverrides = [{
              Name = "vendor-fetcher"
              Environment = [
                { Name = "VENDOR_RELEASE_ID", "Value.$" = "$.vendorReleaseId" },
                { Name = "CORRELATION_ID", "Value.$" = "$.correlationId" }
              ]
            }]
          }
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["ECS.AmazonECSException", "ECS.ThrottlingException"]
          IntervalSeconds = 5
          BackoffRate     = 2
          MaxAttempts     = 2
        }]
        End = true
      }
    }
  })
}

resource "aws_sfn_state_machine" "change_intelligence" {
  name     = "migration-api-development-change-intelligence"
  role_arn = aws_iam_role.step_functions.arn
  type     = "STANDARD"

  logging_configuration {
    include_execution_data = false
    level                  = "ERROR"
    log_destination        = "${aws_cloudwatch_log_group.workflow.arn}:*"
  }

  tracing_configuration {
    enabled = true
  }

  definition = jsonencode({
    Comment = "Stage 3C bounded draft migration-specification generation"
    StartAt = "PrepareChangeIntelligence"
    States = {
      PrepareChangeIntelligence = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.vendor_intelligence_control.arn
          Payload = {
            operation    = "prepare"
            "workflow.$" = "$"
          }
        }
        OutputPath = "$.Payload"
        Next       = "AlreadySucceeded"
      }
      AlreadySucceeded = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.alreadySucceeded"
          BooleanEquals = true
          Next          = "Complete"
        }]
        Default = "GenerateDraftSpecification"
      }
      GenerateDraftSpecification = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 600
        Parameters = {
          Cluster        = aws_ecs_cluster.agent.arn
          TaskDefinition = aws_ecs_task_definition.change_intelligence_agent.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.agent.id]
              Subnets        = [for subnet in aws_subnet.agent : subnet.id]
            }
          }
          Overrides = {
            ContainerOverrides = [{
              Name = "change-intelligence-agent"
              Environment = [
                { Name = "VENDOR_RELEASE_ID", "Value.$" = "$.vendorReleaseId" },
                { Name = "CHANGE_INTELLIGENCE_RUN_ID", "Value.$" = "$.changeIntelligenceRunId" },
                { Name = "EVIDENCE_OBJECT_KEY", "Value.$" = "$.evidenceObjectKey" },
                { Name = "EVIDENCE_DIGEST", "Value.$" = "$.evidenceDigest" },
                { Name = "SPECIFICATION_REVISION", "Value.$" = "States.Format('{}', $.specificationRevision)" },
                { Name = "RESULT_OBJECT_KEY", "Value.$" = "$.resultObjectKey" }
              ]
            }]
          }
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["ECS.AmazonECSException", "ECS.ThrottlingException"]
          IntervalSeconds = 5
          BackoffRate     = 2
          MaxAttempts     = 2
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = null
          Next        = "MarkInfrastructureFailure"
        }]
        Next = "FinalizeChangeIntelligence"
      }
      FinalizeChangeIntelligence = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.vendor_intelligence_control.arn
          Payload = {
            operation    = "finalize"
            "workflow.$" = "$"
          }
        }
        OutputPath = "$.Payload"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = null
          Next        = "MarkInfrastructureFailure"
        }]
        Next = "EvaluateChangeIntelligenceOutcome"
      }
      EvaluateChangeIntelligenceOutcome = {
        Type = "Choice"
        Choices = [{
          Variable     = "$.status"
          StringEquals = "succeeded"
          Next         = "Complete"
        }]
        Default = "ChangeIntelligenceFailed"
      }
      MarkInfrastructureFailure = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.vendor_intelligence_control.arn
          Payload = {
            operation     = "mark_failed"
            "workflow.$"  = "$"
            safeErrorCode = "CHANGE_INTELLIGENCE_INFRASTRUCTURE_FAILED"
          }
        }
        OutputPath = "$.Payload"
        Next       = "ChangeIntelligenceInfrastructureFailed"
      }
      ChangeIntelligenceFailed = {
        Type  = "Fail"
        Error = "ChangeIntelligenceFailed"
        Cause = "The bounded agent did not produce an acceptable draft."
      }
      ChangeIntelligenceInfrastructureFailed = {
        Type  = "Fail"
        Error = "ChangeIntelligenceInfrastructureFailed"
        Cause = "The Stage 3C workflow encountered an infrastructure failure."
      }
      Complete = {
        Type = "Succeed"
      }
    }
  })
}

resource "aws_sfn_state_machine" "impact_analysis" {
  name     = "migration-api-development-impact-analysis"
  role_arn = aws_iam_role.step_functions.arn
  type     = "STANDARD"

  logging_configuration {
    include_execution_data = false
    level                  = "ERROR"
    log_destination        = "${aws_cloudwatch_log_group.workflow.arn}:*"
  }

  tracing_configuration {
    enabled = true
  }

  definition = jsonencode({
    Comment = "Stage 3E bounded read-only repository impact analysis"
    StartAt = "PrepareImpactAnalysis"
    States = {
      PrepareImpactAnalysis = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.impact_analysis_control.arn
          Payload = {
            operation    = "prepare"
            "workflow.$" = "$"
          }
        }
        OutputPath = "$.Payload"
        Next       = "AlreadySucceeded"
      }
      AlreadySucceeded = {
        Type = "Choice"
        Choices = [{
          Variable      = "$.alreadySucceeded"
          BooleanEquals = true
          Next          = "Complete"
        }]
        Default = "AnalyseRepository"
      }
      AnalyseRepository = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 600
        Parameters = {
          Cluster        = aws_ecs_cluster.agent.arn
          TaskDefinition = aws_ecs_task_definition.impact_analysis_agent.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.agent.id]
              Subnets        = [for subnet in aws_subnet.agent : subnet.id]
            }
          }
          Overrides = {
            ContainerOverrides = [{
              Name = "impact-analysis-agent"
              Environment = [
                { Name = "CANDIDATE_ID", "Value.$" = "$.candidateId" },
                { Name = "IMPACT_ANALYSIS_RUN_ID", "Value.$" = "$.impactAnalysisRunId" },
                { Name = "INPUT_OBJECT_KEY", "Value.$" = "$.inputObjectKey" },
                { Name = "INPUT_DIGEST", "Value.$" = "$.inputDigest" },
                { Name = "RESULT_OBJECT_KEY", "Value.$" = "$.resultObjectKey" }
              ]
            }]
          }
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["ECS.AmazonECSException", "ECS.ThrottlingException"]
          IntervalSeconds = 5
          BackoffRate     = 2
          MaxAttempts     = 2
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = null
          Next        = "MarkInfrastructureFailure"
        }]
        Next = "FinalizeImpactAnalysis"
      }
      FinalizeImpactAnalysis = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.impact_analysis_control.arn
          Payload = {
            operation    = "finalize"
            "workflow.$" = "$"
          }
        }
        OutputPath = "$.Payload"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = null
          Next        = "MarkInfrastructureFailure"
        }]
        Next = "EvaluateOutcome"
      }
      EvaluateOutcome = {
        Type = "Choice"
        Choices = [{
          Variable     = "$.status"
          StringEquals = "succeeded"
          Next         = "Complete"
        }]
        Default = "ImpactAnalysisFailed"
      }
      MarkInfrastructureFailure = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.impact_analysis_control.arn
          Payload = {
            operation     = "mark_failed"
            "workflow.$"  = "$"
            safeErrorCode = "IMPACT_ANALYSIS_INFRASTRUCTURE_FAILED"
          }
        }
        OutputPath = "$.Payload"
        Next       = "ImpactAnalysisInfrastructureFailed"
      }
      ImpactAnalysisFailed = {
        Type  = "Fail"
        Error = "ImpactAnalysisFailed"
        Cause = "The bounded agent did not produce an acceptable impact report."
      }
      ImpactAnalysisInfrastructureFailed = {
        Type  = "Fail"
        Error = "ImpactAnalysisInfrastructureFailed"
        Cause = "The Stage 3E workflow encountered an infrastructure failure."
      }
      Complete = {
        Type = "Succeed"
      }
    }
  })
}

resource "aws_sfn_state_machine" "migration" {
  name     = "migration-api-development-migration"
  role_arn = aws_iam_role.step_functions.arn
  type     = "STANDARD"

  logging_configuration {
    include_execution_data = false
    level                  = "ERROR"
    log_destination        = "${aws_cloudwatch_log_group.workflow.arn}:*"
  }

  tracing_configuration {
    enabled = true
  }

  definition = jsonencode({
    Comment = "Stage 5B exact-source acquisition with fail-closed future boundaries"
    StartAt = "PrepareControlState"
    States = {
      PrepareControlState = {
        Type = "Pass"
        Parameters = {
          repairAttempts = 0
          "workflow.$"   = "$"
        }
        Next = "ValidateApproval"
      }
      ValidateApproval = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "validate_migration_approval"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = "$.validation"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluateApproval"
      }
      EvaluateApproval = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.validation.Payload.status"
            StringEquals = "running"
            Next         = "EnterAcquisition"
          },
          {
            Variable     = "$.validation.Payload.status"
            StringEquals = "stale"
            Next         = "StaleApproval"
          },
          {
            Variable     = "$.validation.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      EnterAcquisition = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "enter_migration_acquisition"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = "$.acquisition"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluateAcquisitionEntry"
      }
      EvaluateAcquisitionEntry = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.acquisition.Payload.status"
            StringEquals = "running"
            Next         = "AcquireExactSnapshot"
          },
          {
            Variable     = "$.acquisition.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      AcquireExactSnapshot = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 600
        Parameters = {
          Cluster        = aws_ecs_cluster.agent.arn
          TaskDefinition = aws_ecs_task_definition.source_fetcher.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.source_fetcher.id]
              Subnets        = [for subnet in aws_subnet.source_fetcher : subnet.id]
            }
          }
          Overrides = {
            ContainerOverrides = [{
              Name = "source-fetcher"
              Environment = [
                { Name = "ACQUISITION_MODE", Value = "migration" },
                { Name = "APPROVAL_ID", "Value.$" = "$.workflow.approvalId" },
                { Name = "MIGRATION_RUN_ID", "Value.$" = "$.workflow.migrationRunId" },
                { Name = "ORGANISATION_ID", "Value.$" = "$.workflow.organisationId" },
                { Name = "REPOSITORY_ID", "Value.$" = "$.workflow.repositoryId" }
              ]
            }]
          }
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["ECS.AmazonECSException", "ECS.ThrottlingException"]
          IntervalSeconds = 5
          BackoffRate     = 2
          MaxAttempts     = 2
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "IngestMigrationAcquisition"
      }
      IngestMigrationAcquisition = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "ingest_migration_acquisition"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = "$.boundary"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluateAcquisition"
      }
      EvaluateAcquisition = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "completed"
            Next         = "PrepareMigrationAgent"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "stale"
            Next         = "StaleApproval"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "failed"
            Next         = "SafeBoundaryReached"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      PrepareMigrationAgent = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "prepare_migration_agent"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = "$.agent"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluateMigrationAgentPreparation"
      }
      EvaluateMigrationAgentPreparation = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.agent.Payload.status"
            StringEquals = "ready"
            Next         = "RunMigrationAgent"
          },
          {
            Variable     = "$.agent.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          },
          {
            Variable     = "$.agent.Payload.status"
            StringEquals = "stale"
            Next         = "StaleApproval"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      RunMigrationAgent = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 900
        Parameters = {
          Cluster        = aws_ecs_cluster.agent.arn
          TaskDefinition = aws_ecs_task_definition.migration_agent.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.agent.id]
              Subnets        = [for subnet in aws_subnet.agent : subnet.id]
            }
          }
          Overrides = {
            ContainerOverrides = [{
              Name = "migration-agent"
              Environment = [
                { Name = "ORGANISATION_ID", "Value.$" = "$.agent.Payload.organisationId" },
                { Name = "REPOSITORY_ID", "Value.$" = "$.agent.Payload.repositoryId" },
                { Name = "MIGRATION_RUN_ID", "Value.$" = "$.agent.Payload.migrationRunId" },
                { Name = "INPUT_OBJECT_KEY", "Value.$" = "$.agent.Payload.inputObjectKey" },
                { Name = "INPUT_DIGEST", "Value.$" = "$.agent.Payload.inputDigest" },
                { Name = "RESULT_OBJECT_KEY", "Value.$" = "$.agent.Payload.resultObjectKey" }
              ]
            }]
          }
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["ECS.AmazonECSException", "ECS.ThrottlingException"]
          IntervalSeconds = 5
          BackoffRate     = 2
          MaxAttempts     = 2
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "IngestMigrationPlan"
      }
      IngestMigrationPlan = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "ingest_migration_plan"
            "workflow.$" = "$.workflow"
            "prepared.$" = "$.agent.Payload"
          }
        }
        ResultPath = "$.boundary"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluatePlanning"
      }
      EvaluatePlanning = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "failed"
            Next         = "SafeBoundaryReached"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "stale"
            Next         = "StaleApproval"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "completed"
            Next         = "ValidatePatch"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      ValidatePatch = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "ingest_migration_patch"
            "workflow.$" = "$.workflow"
            "prepared.$" = "$.agent.Payload"
          }
        }
        ResultPath = "$.boundary"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluatePatch"
      }
      EvaluatePatch = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "failed"
            Next         = "SafeBoundaryReached"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "stale"
            Next         = "StaleApproval"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "completed"
            Next         = "RunVerifier"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      RunVerifier = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "prepare_migration_verification"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = "$.boundary"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluateVerificationPreparation"
      }
      EvaluateVerificationPreparation = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "ready"
            Next         = "RunVerifierTask"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "stale"
            Next         = "StaleApproval"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      RunVerifierTask = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 1200
        Parameters = {
          Cluster        = aws_ecs_cluster.agent.arn
          TaskDefinition = aws_ecs_task_definition.verifier.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [aws_security_group.verifier.id]
              Subnets        = [for subnet in aws_subnet.verifier : subnet.id]
            }
          }
          Overrides = {
            ContainerOverrides = [{
              Name = "verifier"
              Environment = [{
                Name      = "VERIFICATION_WORK_ITEM_REFERENCE"
                "Value.$" = "States.JsonToString($.boundary.Payload.dispatch)"
              }]
            }]
          }
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["ECS.AmazonECSException", "ECS.ThrottlingException"]
          IntervalSeconds = 5
          BackoffRate     = 2
          MaxAttempts     = 2
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "IngestVerification"
      }
      IngestVerification = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "ingest_migration_verification"
            "workflow.$" = "$.workflow"
            "prepared.$" = "$.boundary.Payload"
          }
        }
        ResultPath = "$.boundary"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluateVerification"
      }
      EvaluateVerification = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "failed"
            Next         = "SafeBoundaryReached"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "repair_required"
            Next         = "CheckRepairBudget"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "completed"
            Next         = "PublishDraftPR"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      CheckRepairBudget = {
        Type = "Choice"
        Choices = [{
          Variable        = "$.repairAttempts"
          NumericLessThan = 2
          Next            = "IncrementRepairAttempt"
        }]
        Default = "RepairBudgetExhausted"
      }
      IncrementRepairAttempt = {
        Type = "Pass"
        Parameters = {
          "repairAttempts.$" = "States.MathAdd($.repairAttempts, 1)"
          "workflow.$"       = "$.workflow"
        }
        Next = "RunRepairAgent"
      }
      RunRepairAgent = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "evaluate_migration_stage_capability"
            stage        = "repairing"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = "$.boundary"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluateRepair"
      }
      EvaluateRepair = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "unavailable"
            Next         = "StopAtUnavailableBoundary"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "completed"
            Next         = "RunVerifier"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      RepairBudgetExhausted = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "mark_migration_repair_budget_exhausted"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "SafeBoundaryReached"
      }
      PublishDraftPR = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "evaluate_migration_stage_capability"
            stage        = "publishing"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = "$.boundary"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluatePublication"
      }
      EvaluatePublication = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "unavailable"
            Next         = "StopAtUnavailableBoundary"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "completed"
            Next         = "ReconcilePublication"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      ReconcilePublication = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "evaluate_migration_stage_capability"
            stage        = "publishing"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = "$.boundary"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluateReconciliation"
      }
      EvaluateReconciliation = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "unavailable"
            Next         = "StopAtUnavailableBoundary"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "completed"
            Next         = "RecordSuccess"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      RecordSuccess = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "evaluate_migration_stage_capability"
            stage        = "publishing"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = "$.boundary"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "EvaluateCompletion"
      }
      EvaluateCompletion = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "unavailable"
            Next         = "StopAtUnavailableBoundary"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "cancelled"
            Next         = "Cancelled"
          },
          {
            Variable     = "$.boundary.Payload.status"
            StringEquals = "completed"
            Next         = "Complete"
          }
        ]
        Default = "MarkInfrastructureFailure"
      }
      StopAtUnavailableBoundary = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "mark_migration_stage_unavailable"
            "stage.$"    = "$.boundary.Payload.stage"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MarkInfrastructureFailure"
          ResultPath  = null
        }]
        Next = "SafeBoundaryReached"
      }
      MarkInfrastructureFailure = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.workflow_control.arn
          Payload = {
            operation    = "mark_migration_infrastructure_failed"
            "workflow.$" = "$.workflow"
          }
        }
        ResultPath = "$.infrastructure"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"]
          IntervalSeconds = 2
          BackoffRate     = 2
          MaxAttempts     = 3
        }]
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "MigrationInfrastructureFailed"
          ResultPath  = null
        }]
        Next = "EvaluateInfrastructureFailure"
      }
      EvaluateInfrastructureFailure = {
        Type = "Choice"
        Choices = [{
          Variable     = "$.infrastructure.Payload.status"
          StringEquals = "cancelled"
          Next         = "Cancelled"
        }]
        Default = "MigrationInfrastructureFailed"
      }
      StaleApproval = {
        Type = "Succeed"
      }
      Cancelled = {
        Type = "Succeed"
      }
      SafeBoundaryReached = {
        Type = "Succeed"
      }
      Complete = {
        Type = "Succeed"
      }
      MigrationInfrastructureFailed = {
        Type  = "Fail"
        Error = "MigrationInfrastructureFailed"
        Cause = "The durable migration workflow encountered an infrastructure failure."
      }
    }
  })
}

data "aws_iam_policy_document" "outbox_workflow" {
  statement {
    actions = ["states:StartExecution"]
    resources = [
      aws_sfn_state_machine.agent.arn,
      aws_sfn_state_machine.repository_scan.arn,
      aws_sfn_state_machine.migration.arn
    ]
  }
}

resource "aws_iam_role_policy" "outbox_workflow" {
  name   = "start-agent-workflow"
  role   = aws_iam_role.outbox.id
  policy = data.aws_iam_policy_document.outbox_workflow.json
}

data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "migration-api-development-outbox-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.outbox.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "invoke-outbox"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "outbox" {
  name                         = "migration-api-development-outbox"
  schedule_expression          = "rate(1 minute)"
  schedule_expression_timezone = "UTC"
  state                        = "ENABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.outbox.arn
    role_arn = aws_iam_role.scheduler.arn

    retry_policy {
      maximum_event_age_in_seconds = 120
      maximum_retry_attempts       = 2
    }
  }
}
