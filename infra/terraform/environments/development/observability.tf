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

