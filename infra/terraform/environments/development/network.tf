resource "aws_vpc" "main" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${local.name_prefix}-vpc" }
}

data "aws_route_table" "development_nat" {
  route_table_id = var.development_nat_route_table_id
}

data "aws_network_interface" "development_nat" {
  id = var.development_nat_network_interface_id
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

resource "aws_subnet" "verifier" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, 80 + each.value)
  tags              = { Name = "${local.name_prefix}-verifier-${each.value + 1}" }
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

resource "aws_route" "development_nat_default" {
  route_table_id         = data.aws_route_table.development_nat.id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = data.aws_network_interface.development_nat.id

  lifecycle {
    precondition {
      condition     = data.aws_network_interface.development_nat.vpc_id == aws_vpc.main.id
      error_message = "The development NAT network interface must belong to the development VPC."
    }
  }
}

resource "aws_route_table_association" "control" {
  for_each       = aws_subnet.control
  subnet_id      = each.value.id
  route_table_id = data.aws_route_table.development_nat.id

  lifecycle {
    precondition {
      condition     = data.aws_route_table.development_nat.vpc_id == aws_vpc.main.id
      error_message = "The development NAT route table must belong to the development VPC."
    }
  }
}

resource "aws_route_table_association" "agent" {
  for_each       = aws_subnet.agent
  subnet_id      = each.value.id
  route_table_id = data.aws_route_table.development_nat.id

  lifecycle {
    precondition {
      condition     = data.aws_route_table.development_nat.vpc_id == aws_vpc.main.id
      error_message = "The development NAT route table must belong to the development VPC."
    }
  }
}

resource "aws_route_table_association" "source_fetcher" {
  for_each       = aws_subnet.source_fetcher
  subnet_id      = each.value.id
  route_table_id = data.aws_route_table.development_nat.id

  lifecycle {
    precondition {
      condition     = data.aws_route_table.development_nat.vpc_id == aws_vpc.main.id
      error_message = "The development NAT route table must belong to the development VPC."
    }
  }
}

resource "aws_route_table_association" "verifier" {
  for_each       = aws_subnet.verifier
  subnet_id      = each.value.id
  route_table_id = data.aws_route_table.development_nat.id

  lifecycle {
    precondition {
      condition     = data.aws_route_table.development_nat.vpc_id == aws_vpc.main.id
      error_message = "The development NAT route table must belong to the development VPC."
    }
  }
}

resource "aws_cloudwatch_log_group" "network_firewall" {
  name              = "/migration-api/development/network-firewall"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.logs.arn
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
      [for subnet in aws_subnet.source_fetcher : subnet.cidr_block],
      [for subnet in aws_subnet.verifier : subnet.cidr_block]
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
  description = "Agent TLS egress through private endpoints and the development NAT instance"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "TLS through private endpoints or the development NAT instance"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "source_fetcher" {
  name        = "${local.name_prefix}-source-fetcher"
  description = "Source-fetcher TLS egress through private endpoints and the development NAT instance"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "TLS through private endpoints or the development NAT instance"
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

resource "aws_security_group" "verifier" {
  name        = "${local.name_prefix}-verifier"
  description = "Verifier egress to private AWS endpoints and allowlisted registry"
  vpc_id      = aws_vpc.main.id

  egress {
    description     = "TLS to interface endpoints used for image pulls and logs"
    protocol        = "tcp"
    from_port       = 443
    to_port         = 443
    security_groups = [aws_security_group.vpc_endpoints.id]
  }

  egress {
    description     = "TLS to the regional S3 gateway endpoint"
    protocol        = "tcp"
    from_port       = 443
    to_port         = 443
    prefix_list_ids = [aws_vpc_endpoint.s3.prefix_list_id]
  }

  egress {
    description = "TLS through the development NAT instance to the application-approved registry"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [data.aws_route_table.development_nat.id]
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
