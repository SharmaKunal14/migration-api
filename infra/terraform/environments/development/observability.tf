resource "aws_cloudwatch_log_metric_filter" "outbox_failure" {
  name           = "migration-api-development-outbox-failure"
  log_group_name = aws_cloudwatch_log_group.outbox.name
  pattern        = "{ $.safeErrorCode = \"OUTBOX_DELIVERY_FAILED\" }"

  metric_transformation {
    name      = "OutboxDeliveryFailed"
    namespace = "MigrationApi/Development"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "wif_failure" {
  name           = "migration-api-development-wif-failure"
  log_group_name = aws_cloudwatch_log_group.agent.name
  pattern        = "{ $.safeErrorCode = \"MODEL_AUTHENTICATION_FAILED\" }"

  metric_transformation {
    name      = "OpenAiWifFailure"
    namespace = "MigrationApi/Development"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "github_reconciliation_failure" {
  name           = "migration-api-development-github-reconciliation-failure"
  log_group_name = aws_cloudwatch_log_group.github_reconciler.name
  pattern        = "{ $.event = \"github_reconciliation_failed\" }"

  metric_transformation {
    name      = "GitHubReconciliationFailed"
    namespace = "MigrationApi/Development"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "migration-api-development-api-errors"
  alarm_description   = "Control API returned Lambda errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "workflow_failures" {
  alarm_name          = "migration-api-development-workflow-failures"
  alarm_description   = "Standard Workflow reached an unhandled failed execution."
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = aws_sfn_state_machine.agent.arn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "outbox_failure" {
  alarm_name          = "migration-api-development-outbox-delivery-failure"
  alarm_description   = "An outbox event exhausted its delivery attempts."
  namespace           = "MigrationApi/Development"
  metric_name         = "OutboxDeliveryFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "wif_failure" {
  alarm_name          = "migration-api-development-openai-wif-failure"
  alarm_description   = "The agent could not authenticate to OpenAI through WIF."
  namespace           = "MigrationApi/Development"
  metric_name         = "OpenAiWifFailure"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "github_webhook_errors" {
  alarm_name          = "migration-api-development-github-webhook-errors"
  alarm_description   = "GitHub webhook ingress returned an unhandled Lambda error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.github_webhook.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "github_webhook_dlq" {
  alarm_name          = "migration-api-development-github-webhook-dlq"
  alarm_description   = "A verified GitHub webhook exhausted reconciliation retries."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.github_webhooks_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "github_webhook_backlog_age" {
  alarm_name          = "migration-api-development-github-webhook-backlog-age"
  alarm_description   = "Verified GitHub webhooks have waited more than ten minutes for reconciliation."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.github_webhooks.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 600
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "github_token_broker_errors" {
  alarm_name          = "migration-api-development-github-token-broker-errors"
  alarm_description   = "The isolated GitHub token broker returned an unhandled Lambda error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.github_token_broker.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "github_reconciler_errors" {
  alarm_name          = "migration-api-development-github-reconciler-errors"
  alarm_description   = "GitHub reconciler returned an unhandled Lambda error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.github_reconciler.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "github_reconciliation_failure" {
  alarm_name          = "migration-api-development-github-reconciliation-failure"
  alarm_description   = "A verified GitHub webhook reconciliation attempt failed."
  namespace           = "MigrationApi/Development"
  metric_name         = "GitHubReconciliationFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "repository_scan_control_errors" {
  alarm_name          = "migration-api-development-repository-scan-control-errors"
  alarm_description   = "Repository scan control returned an unhandled Lambda error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.repository_scan_control.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "repository_scan_workflow_failures" {
  alarm_name          = "migration-api-development-repository-scan-workflow-failures"
  alarm_description   = "Repository scan workflow reached an unhandled failed execution."
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = aws_sfn_state_machine.repository_scan.arn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}
