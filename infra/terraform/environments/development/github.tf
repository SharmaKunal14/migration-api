resource "aws_sqs_queue" "github_webhooks_dlq" {
  name                      = "migration-api-development-github-webhooks-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "github_webhooks" {
  name                       = "migration-api-development-github-webhooks"
  visibility_timeout_seconds = 360
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.github_webhooks_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "github_webhooks" {
  queue_url = aws_sqs_queue.github_webhooks_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.github_webhooks.arn]
  })
}

data "aws_iam_policy_document" "github_webhook_runtime" {
  statement {
    sid       = "ReadExactWebhookSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.github_webhook_secret_arn]
  }

  statement {
    sid       = "DecryptWebhookSecret"
    actions   = ["kms:Decrypt"]
    resources = [var.github_webhook_secret_kms_key_arn]
  }

  statement {
    sid       = "EnqueueVerifiedWebhook"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.github_webhooks.arn]
  }
}

resource "aws_iam_role_policy" "github_webhook_runtime" {
  name   = "verify-and-enqueue"
  role   = aws_iam_role.github_webhook.id
  policy = data.aws_iam_policy_document.github_webhook_runtime.json
}

data "aws_iam_policy_document" "github_token_broker_runtime" {
  statement {
    sid       = "ReadExactGitHubAppSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.github_app_secret_arn]
  }

  statement {
    sid       = "DecryptGitHubAppSecret"
    actions   = ["kms:Decrypt"]
    resources = [var.github_app_secret_kms_key_arn]
  }

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

resource "aws_iam_role_policy" "github_token_broker_runtime" {
  name   = "validate-and-mint-narrow-token"
  role   = aws_iam_role.github_token_broker.id
  policy = data.aws_iam_policy_document.github_token_broker_runtime.json
}

data "aws_iam_policy_document" "api_github_token_broker" {
  statement {
    sid       = "VerifyGitHubInstallation"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.github_token_broker.arn]
  }
}

resource "aws_iam_role_policy" "api_github_token_broker" {
  name   = "verify-github-installation"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_github_token_broker.json
}

data "aws_iam_policy_document" "github_reconciler_runtime" {
  statement {
    sid = "ConsumeVerifiedWebhooks"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage"
    ]
    resources = [aws_sqs_queue.github_webhooks.arn]
  }

  statement {
    sid       = "RetrieveInstallationInventory"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.github_token_broker.arn]
  }
}

resource "aws_iam_role_policy" "github_reconciler_runtime" {
  name   = "consume-and-reconcile-github-webhooks"
  role   = aws_iam_role.github_reconciler.id
  policy = data.aws_iam_policy_document.github_reconciler_runtime.json
}
