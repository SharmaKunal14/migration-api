resource "aws_cloudwatch_log_group" "package_release_poller" {
  name              = "/aws/lambda/migration-api-development-package-release-poller"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_iam_role" "package_release_poller" {
  name               = "migration-api-development-package-release-poller"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "package_release_poller_logs" {
  statement {
    sid       = "WriteStructuredLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.package_release_poller.arn}:*"]
  }
}

resource "aws_iam_role_policy" "package_release_poller_logs" {
  name   = "structured-logs"
  role   = aws_iam_role.package_release_poller.id
  policy = data.aws_iam_policy_document.package_release_poller_logs.json
}

resource "aws_iam_role_policy" "package_release_poller_database" {
  name   = "runtime-database"
  role   = aws_iam_role.package_release_poller.id
  policy = data.aws_iam_policy_document.database_secret.json
}

data "aws_iam_policy_document" "package_release_poller_vpc" {
  statement {
    sid = "VpcNetworkInterfaces"
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces"
    ]
    # Lambda VPC attachment requires these EC2 actions with Resource="*".
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "package_release_poller_vpc" {
  name   = "vpc-network-interfaces"
  role   = aws_iam_role.package_release_poller.id
  policy = data.aws_iam_policy_document.package_release_poller_vpc.json
}

data "aws_iam_policy_document" "package_release_poller_tracing" {
  statement {
    sid = "WriteXrayTelemetry"
    actions = [
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments"
    ]
    # X-Ray write APIs do not support resource-level permissions.
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "package_release_poller_tracing" {
  name   = "xray-telemetry"
  role   = aws_iam_role.package_release_poller.id
  policy = data.aws_iam_policy_document.package_release_poller_tracing.json
}

data "aws_iam_policy_document" "package_release_poller_artifacts" {
  statement {
    sid       = "WriteNpmReleaseEvidence"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/env/development/package-release/npm/*"]
  }

  statement {
    sid = "EncryptNpmReleaseEvidence"
    actions = [
      "kms:Encrypt",
      "kms:GenerateDataKey"
    ]
    resources = [aws_kms_key.artifacts.arn]
  }
}

resource "aws_iam_role_policy" "package_release_poller_artifacts" {
  name   = "write-npm-release-evidence"
  role   = aws_iam_role.package_release_poller.id
  policy = data.aws_iam_policy_document.package_release_poller_artifacts.json
}

data "archive_file" "package_release_poller" {
  type        = "zip"
  output_path = "${path.module}/.terraform/package-release-poller.zip"

  source {
    content  = file("${var.service_build_directory}/package-release-poller.js")
    filename = "index.mjs"
  }
}

resource "aws_lambda_function" "package_release_poller" {
  function_name                  = "migration-api-development-package-release-poller"
  role                           = aws_iam_role.package_release_poller.arn
  handler                        = "index.handler"
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.package_release_poller.output_path
  source_code_hash               = data.archive_file.package_release_poller.output_base64sha256
  memory_size                    = 512
  timeout                        = 90
  reserved_concurrent_executions = 1

  environment {
    variables = {
      APP_ENVIRONMENT      = "development"
      ARTIFACT_BUCKET      = aws_s3_bucket.artifacts.bucket
      ARTIFACT_KMS_KEY_ARN = aws_kms_key.artifacts.arn
      DATABASE_SECRET_ARN  = var.database_secret_arn
      NPM_REGISTRY_ORIGIN  = "https://registry.npmjs.org"
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
    aws_cloudwatch_log_group.package_release_poller,
    aws_iam_role_policy.package_release_poller_logs,
    aws_iam_role_policy.package_release_poller_database,
    aws_iam_role_policy.package_release_poller_vpc,
    aws_iam_role_policy.package_release_poller_tracing,
    aws_iam_role_policy.package_release_poller_artifacts
  ]
}

resource "aws_sqs_queue" "package_release_poller_dlq" {
  name                      = "migration-api-development-package-release-poller-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_iam_role" "package_release_poller_scheduler" {
  name               = "migration-api-development-package-release-poller-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust.json
}

data "aws_iam_policy_document" "package_release_poller_scheduler" {
  statement {
    sid       = "InvokeReleasePoller"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.package_release_poller.arn]
  }

  statement {
    sid       = "SendFailedInvocationToDlq"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.package_release_poller_dlq.arn]
  }
}

resource "aws_iam_role_policy" "package_release_poller_scheduler" {
  name   = "invoke-package-release-poller"
  role   = aws_iam_role.package_release_poller_scheduler.id
  policy = data.aws_iam_policy_document.package_release_poller_scheduler.json
}

resource "aws_scheduler_schedule" "package_release_poller" {
  name                         = "migration-api-development-package-release-poller"
  schedule_expression          = "rate(15 minutes)"
  schedule_expression_timezone = "UTC"
  state                        = "ENABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.package_release_poller.arn
    role_arn = aws_iam_role.package_release_poller_scheduler.arn
    input    = jsonencode({ operation = "poll_due" })

    dead_letter_config {
      arn = aws_sqs_queue.package_release_poller_dlq.arn
    }

    retry_policy {
      maximum_event_age_in_seconds = 900
      maximum_retry_attempts       = 2
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "package_release_poll_exhausted" {
  name           = "migration-api-development-package-release-poll-exhausted"
  log_group_name = aws_cloudwatch_log_group.package_release_poller.name
  pattern        = "{ $.event = \"npm_package_release_poll_exhausted\" }"

  metric_transformation {
    name      = "PackageReleasePollExhausted"
    namespace = "MigrationApi/Development"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "package_release_poller_errors" {
  alarm_name          = "migration-api-development-package-release-poller-errors"
  alarm_description   = "Package release poller returned an unhandled Lambda error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.package_release_poller.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "package_release_poll_exhausted" {
  alarm_name          = "migration-api-development-package-release-poll-exhausted"
  alarm_description   = "A trusted npm source exhausted bounded release-poll retries."
  namespace           = "MigrationApi/Development"
  metric_name         = "PackageReleasePollExhausted"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "package_release_poller_dlq" {
  alarm_name          = "migration-api-development-package-release-poller-dlq"
  alarm_description   = "A scheduled release-poller invocation exhausted infrastructure retries."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.package_release_poller_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}
