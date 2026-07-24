terraform {
  required_version = "= 1.15.8"

  required_providers {
    archive = {
      source  = "hashicorp/archive"
      version = "= 2.7.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.84.0"
    }
  }
}
