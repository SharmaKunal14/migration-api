resource "aws_apigatewayv2_api" "control" {
  name          = "migration-api-development-control"
  protocol_type = "HTTP"

  disable_execute_api_endpoint = false
}

# Transitional resource: keep the legacy RSA-only authorizer until a deployment
# has detached both routes. Remove it in the next reviewed deployment after the
# live routes report authorizationType NONE and no AuthorizerId.
resource "aws_apigatewayv2_authorizer" "supabase" {
  api_id           = aws_apigatewayv2_api.control.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "supabase-jwt"

  jwt_configuration {
    audience = [var.supabase_jwt_audience]
    issuer   = var.supabase_jwt_issuer
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.control.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 15000
}

resource "aws_apigatewayv2_route" "me" {
  # API Gateway JWT authorizers accept only RSA signatures. The Lambda verifies
  # Supabase ES256 tokens before dispatching any route operation.
  api_id             = aws_apigatewayv2_api.control.id
  route_key          = "ANY /v1/me"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "v1" {
  api_id             = aws_apigatewayv2_api.control.id
  route_key          = "ANY /v1/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "NONE"
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/migration-api/development/api-access"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_apigatewayv2_stage" "development" {
  api_id      = aws_apigatewayv2_api.control.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    detailed_metrics_enabled = true
    throttling_burst_limit   = 20
    throttling_rate_limit    = 10
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.control.execution_arn}/*/*"
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "migration-api-development-web"
  description                       = "CloudFront-only access to private web assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "migration-api-development-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JAVASCRIPT
    function handler(event) {
      var request = event.request;
      if (request.uri.indexOf('/api/') === 0 || request.uri.indexOf('.') !== -1) {
        return request;
      }
      request.uri = '/index.html';
      return request;
    }
  JAVASCRIPT
}

resource "aws_cloudfront_function" "api_rewrite" {
  name    = "migration-api-development-api-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JAVASCRIPT
    function handler(event) {
      var request = event.request;
      if (request.uri.indexOf('/api/') === 0) {
        request.uri = request.uri.substring(4);
      }
      return request;
    }
  JAVASCRIPT
}

resource "aws_cloudfront_cache_policy" "web_html" {
  name        = "migration-api-development-web-html"
  default_ttl = 0
  max_ttl     = 60
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

data "aws_cloudfront_cache_policy" "api_disabled" {
  name = "Managed-CachingDisabled"
}

resource "aws_cloudfront_origin_request_policy" "api" {
  name = "migration-api-development-api"

  cookies_config {
    cookie_behavior = "none"
  }
  headers_config {
    header_behavior = "whitelist"
    headers {
      items = ["Authorization", "Idempotency-Key", "Content-Type", "Accept"]
    }
  }
  query_strings_config {
    query_string_behavior = "all"
  }
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "migration-api-development-security"

  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'none'; base-uri 'none'; connect-src 'self' ${var.supabase_url}; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'"
      override                = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
      override = true
    }
  }
}

resource "aws_wafv2_web_acl" "edge" {
  provider = aws.us_east_1
  name     = "migration-api-development-edge"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-common"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "migration-api-development-common"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "migration-api-development-known-bad"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "rate-limit"
    priority = 30
    action {
      block {}
    }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 500
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "migration-api-development-rate"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "migration-api-development-edge"
    sampled_requests_enabled   = false
  }
}

resource "aws_cloudwatch_log_group" "waf" {
  provider          = aws.us_east_1
  name              = "aws-waf-logs-migration-api-development"
  retention_in_days = 30
}

resource "aws_wafv2_web_acl_logging_configuration" "edge" {
  provider                = aws.us_east_1
  resource_arn            = aws_wafv2_web_acl.edge.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Migration API development Stage 1"
  default_root_object = "index.html"
  aliases             = [var.product_domain]
  web_acl_id          = aws_wafv2_web_acl.edge.arn
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "web"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    domain_name = trimprefix(aws_apigatewayv2_api.control.api_endpoint, "https://")
    origin_id   = "api"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.web_html.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.api_disabled.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.api.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.api_rewrite.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }
}

data "aws_iam_policy_document" "web_bucket" {
  statement {
    sid       = "CloudFrontReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.web.arn, "${aws_s3_bucket.web.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web_bucket.json
}

locals {
  web_files = fileset(var.web_build_directory, "**")
  content_types = {
    ".css"  = "text/css"
    ".html" = "text/html"
    ".js"   = "application/javascript"
    ".json" = "application/json"
    ".svg"  = "image/svg+xml"
  }
}

resource "aws_s3_object" "web" {
  for_each = local.web_files

  bucket        = aws_s3_bucket.web.id
  key           = each.value
  source        = "${var.web_build_directory}/${each.value}"
  source_hash   = filebase64sha256("${var.web_build_directory}/${each.value}")
  content_type  = lookup(local.content_types, regex("\\.[^.]+$", each.value), "application/octet-stream")
  cache_control = each.value == "index.html" ? "no-cache, no-store, must-revalidate" : "public, max-age=31536000, immutable"
}
