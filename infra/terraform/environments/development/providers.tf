provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Application        = "migration-api"
      Environment        = "development"
      Owner              = var.owner
      DataClassification = "synthetic"
      ManagedBy          = "terraform"
      Stage              = "1"
    }
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Application        = "migration-api"
      Environment        = "development"
      Owner              = var.owner
      DataClassification = "synthetic"
      ManagedBy          = "terraform"
      Stage              = "1"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name_prefix = "migration-api-development-${var.aws_region}"
  azs         = slice(data.aws_availability_zones.available.names, 0, 2)
  common_tags = {
    Application        = "migration-api"
    Environment        = "development"
    Owner              = var.owner
    DataClassification = "synthetic"
    ManagedBy          = "terraform"
    Stage              = "1"
  }
}
