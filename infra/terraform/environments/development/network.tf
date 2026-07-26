resource "aws_vpc" "main" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${local.name_prefix}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name_prefix}-igw" }
}

resource "aws_subnet" "public" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, each.value)
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name_prefix}-public-${each.value + 1}" }
}

resource "aws_subnet" "firewall" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, 16 + each.value)
  tags              = { Name = "${local.name_prefix}-firewall-${each.value + 1}" }
}

resource "aws_subnet" "control" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, 32 + each.value)
  tags              = { Name = "${local.name_prefix}-control-${each.value + 1}" }
}

resource "aws_subnet" "agent" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, 48 + each.value)
  tags              = { Name = "${local.name_prefix}-agent-${each.value + 1}" }
}

resource "aws_subnet" "source_fetcher" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, 64 + each.value)
  tags              = { Name = "${local.name_prefix}-source-fetcher-${each.value + 1}" }
}

resource "aws_eip" "nat" {
  for_each = aws_subnet.public
  domain   = "vpc"

  depends_on = [aws_internet_gateway.main]
  tags       = { Name = "${local.name_prefix}-nat-${each.value.availability_zone}" }
}

resource "aws_nat_gateway" "main" {
  for_each = aws_subnet.public

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = each.value.id
  tags          = { Name = "${local.name_prefix}-nat-${each.key}" }
}

resource "aws_route_table" "public" {
  for_each = aws_subnet.public
  vpc_id   = aws_vpc.main.id
  tags     = { Name = "${local.name_prefix}-public-${each.key}" }
}

resource "aws_route" "public_default" {
  for_each               = aws_route_table.public
  route_table_id         = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public[each.key].id
}

resource "aws_route_table" "firewall" {
  for_each = aws_subnet.firewall
  vpc_id   = aws_vpc.main.id
  tags     = { Name = "${local.name_prefix}-firewall-${each.key}" }
}

resource "aws_route" "firewall_default" {
  for_each               = aws_route_table.firewall
  route_table_id         = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[each.key].id
}

resource "aws_route_table_association" "firewall" {
  for_each       = aws_subnet.firewall
  subnet_id      = each.value.id
  route_table_id = aws_route_table.firewall[each.key].id
}

resource "aws_route_table" "control" {
  for_each = aws_subnet.control
  vpc_id   = aws_vpc.main.id
  tags     = { Name = "${local.name_prefix}-control-${each.key}" }
}

resource "aws_route" "control_default" {
  for_each               = aws_route_table.control
  route_table_id         = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[each.key].id
}

resource "aws_route_table_association" "control" {
  for_each       = aws_subnet.control
  subnet_id      = each.value.id
  route_table_id = aws_route_table.control[each.key].id
}

resource "aws_networkfirewall_rule_group" "openai_egress" {
  capacity = 100
  name     = "${local.name_prefix}-openai-egress"
  type     = "STATEFUL"

  rule_group {
    stateful_rule_options {
      rule_order = "STRICT_ORDER"
    }

    rules_source {
      rules_string = <<-RULES
        pass tls [${join(",", [for subnet in aws_subnet.agent : subnet.cidr_block])}] any -> $EXTERNAL_NET 443 (flow:to_server,established; tls.sni; content:"api.openai.com"; nocase; startswith; endswith; sid:1; rev:1;)
        pass tls [${join(",", [for subnet in aws_subnet.agent : subnet.cidr_block])}] any -> $EXTERNAL_NET 443 (flow:to_server,established; tls.sni; content:"auth.openai.com"; nocase; startswith; endswith; sid:2; rev:1;)
        pass tls [${join(",", [for subnet in aws_subnet.source_fetcher : subnet.cidr_block])}] any -> $EXTERNAL_NET 443 (flow:to_server,established; tls.sni; content:"api.github.com"; nocase; startswith; endswith; sid:3; rev:1;)
        pass tls [${join(",", [for subnet in aws_subnet.source_fetcher : subnet.cidr_block])}] any -> $EXTERNAL_NET 443 (flow:to_server,established; tls.sni; content:"codeload.github.com"; nocase; startswith; endswith; sid:4; rev:1;)
      RULES
    }
  }

  tags = { Name = "${local.name_prefix}-openai-egress" }
}

resource "aws_networkfirewall_firewall_policy" "agent" {
  name = "${local.name_prefix}-agent"

  firewall_policy {
    stateless_default_actions          = ["aws:forward_to_sfe"]
    stateless_fragment_default_actions = ["aws:forward_to_sfe"]
    stateful_default_actions           = ["aws:drop_established", "aws:alert_established"]

    stateful_engine_options {
      rule_order = "STRICT_ORDER"
    }

    stateful_rule_group_reference {
      priority     = 1
      resource_arn = aws_networkfirewall_rule_group.openai_egress.arn
    }
  }
}

resource "aws_networkfirewall_firewall" "agent" {
  name                = "${local.name_prefix}-agent"
  firewall_policy_arn = aws_networkfirewall_firewall_policy.agent.arn
  vpc_id              = aws_vpc.main.id

  dynamic "subnet_mapping" {
    for_each = aws_subnet.firewall
    content {
      subnet_id = subnet_mapping.value.id
    }
  }

  tags = { Name = "${local.name_prefix}-agent" }
}

locals {
  firewall_endpoints = {
    for state in aws_networkfirewall_firewall.agent.firewall_status[0].sync_states :
    state.availability_zone => state.attachment[0].endpoint_id
  }
}

resource "aws_route" "public_agent_return" {
  for_each               = aws_route_table.public
  route_table_id         = each.value.id
  destination_cidr_block = aws_subnet.agent[each.key].cidr_block
  vpc_endpoint_id        = local.firewall_endpoints[each.key]
}

resource "aws_route" "public_source_fetcher_return" {
  for_each               = aws_route_table.public
  route_table_id         = each.value.id
  destination_cidr_block = aws_subnet.source_fetcher[each.key].cidr_block
  vpc_endpoint_id        = local.firewall_endpoints[each.key]
}

resource "aws_route_table" "agent" {
  for_each = aws_subnet.agent
  vpc_id   = aws_vpc.main.id
  tags     = { Name = "${local.name_prefix}-agent-${each.key}" }
}

resource "aws_route" "agent_default" {
  for_each               = aws_route_table.agent
  route_table_id         = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  vpc_endpoint_id        = local.firewall_endpoints[each.key]
}

resource "aws_route_table_association" "agent" {
  for_each       = aws_subnet.agent
  subnet_id      = each.value.id
  route_table_id = aws_route_table.agent[each.key].id
}

resource "aws_route_table" "source_fetcher" {
  for_each = aws_subnet.source_fetcher
  vpc_id   = aws_vpc.main.id
  tags     = { Name = "${local.name_prefix}-source-fetcher-${each.key}" }
}

resource "aws_route" "source_fetcher_default" {
  for_each               = aws_route_table.source_fetcher
  route_table_id         = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  vpc_endpoint_id        = local.firewall_endpoints[each.key]
}

resource "aws_route_table_association" "source_fetcher" {
  for_each       = aws_subnet.source_fetcher
  subnet_id      = each.value.id
  route_table_id = aws_route_table.source_fetcher[each.key].id
}

resource "aws_cloudwatch_log_group" "network_firewall" {
  name              = "/migration-api/development/network-firewall"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_networkfirewall_logging_configuration" "agent" {
  firewall_arn = aws_networkfirewall_firewall.agent.arn

  logging_configuration {
    log_destination_config {
      log_destination = {
        logGroup = aws_cloudwatch_log_group.network_firewall.name
      }
      log_destination_type = "CloudWatchLogs"
      log_type             = "ALERT"
    }
  }
}

resource "aws_security_group" "vpc_endpoints" {
  name        = "${local.name_prefix}-endpoints"
  description = "TLS access to private AWS service endpoints"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "TLS from application workload subnets"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = concat(
      [for subnet in aws_subnet.control : subnet.cidr_block],
      [for subnet in aws_subnet.agent : subnet.cidr_block],
      [for subnet in aws_subnet.source_fetcher : subnet.cidr_block]
    )
  }

  egress {
    description = "Endpoint response traffic within VPC"
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = [aws_vpc.main.cidr_block]
  }
}

resource "aws_security_group" "control" {
  name        = "${local.name_prefix}-control"
  description = "Control Lambda egress"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "TLS to Supabase and AWS endpoints"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "PostgreSQL direct connection"
    protocol    = "tcp"
    from_port   = 5432
    to_port     = 5432
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "PostgreSQL transaction pooler"
    protocol    = "tcp"
    from_port   = 6543
    to_port     = 6543
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "agent" {
  name        = "${local.name_prefix}-agent"
  description = "Agent egress through private endpoints and inspected route"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "TLS only; Network Firewall restricts public destination"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "source_fetcher" {
  name        = "${local.name_prefix}-source-fetcher"
  description = "Source-fetcher TLS egress through inspected routes"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "TLS only; Network Firewall restricts GitHub and AWS destinations"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "vendor_fetcher" {
  name        = "${local.name_prefix}-vendor-fetcher"
  description = "Vendor-fetcher allowlisted HTTPS and database egress"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "TLS only; fetcher enforces exact vendor hosts and pinned public DNS"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "PostgreSQL runtime database connection"
    protocol    = "tcp"
    from_port   = 5432
    to_port     = 5432
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "PostgreSQL transaction pooler"
    protocol    = "tcp"
    from_port   = 6543
    to_port     = 6543
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids = concat(
    [for route_table in aws_route_table.control : route_table.id],
    [for route_table in aws_route_table.agent : route_table.id],
    [for route_table in aws_route_table.source_fetcher : route_table.id]
  )
}

locals {
  interface_endpoints = toset([
    "ecr.api",
    "ecr.dkr",
    "logs",
    "kms",
    "lambda",
    "secretsmanager",
    "sts"
  ])
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoints

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for subnet in aws_subnet.control : subnet.id]
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
}
