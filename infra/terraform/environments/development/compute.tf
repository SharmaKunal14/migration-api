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

resource "aws_cloudwatch_log_group" "agent" {
  name              = "/migration-api/development/agent"
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
      APP_ENVIRONMENT     = "development"
      DATABASE_SECRET_ARN = var.database_secret_arn
      STATE_MACHINE_ARN   = aws_sfn_state_machine.agent.arn
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
    sid       = "WorkflowControl"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.workflow_control.arn]
  }

  statement {
    sid       = "RunAgentTask"
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.agent.arn]

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
    sid       = "PassExactAgentRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.agent_execution.arn, aws_iam_role.agent_task.arn]
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

data "aws_iam_policy_document" "outbox_workflow" {
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.agent.arn]
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
