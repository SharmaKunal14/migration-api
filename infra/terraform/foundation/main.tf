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

resource "aws_kms_key" "container_images" {
  description             = "Migration API development container images"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "container_images" {
  name          = "alias/migration-api/development/container-images"
  target_key_id = aws_kms_key.container_images.key_id
}

resource "aws_ecr_repository" "agent" {
  name                 = "migration-api-development-agent"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.container_images.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "agent" {
  repository = aws_ecr_repository.agent.name
  policy     = local.image_lifecycle_policy
}

resource "aws_ecr_repository" "migrator" {
  name                 = "migration-api-development-database-migrator"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.container_images.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "migrator" {
  repository = aws_ecr_repository.migrator.name
  policy     = local.image_lifecycle_policy
}

resource "aws_ecr_repository" "source_fetcher" {
  name                 = "migration-api-development-source-fetcher"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.container_images.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Stage = "2" }
}

resource "aws_ecr_lifecycle_policy" "source_fetcher" {
  repository = aws_ecr_repository.source_fetcher.name
  policy     = local.image_lifecycle_policy
}

resource "aws_ecr_repository" "vendor_fetcher" {
  name                 = "migration-api-development-vendor-fetcher"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.container_images.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Stage = "3" }
}

resource "aws_ecr_lifecycle_policy" "vendor_fetcher" {
  repository = aws_ecr_repository.vendor_fetcher.name
  policy     = local.image_lifecycle_policy
}

resource "aws_ecr_repository" "change_intelligence_agent" {
  name                 = "migration-api-development-change-intelligence-agent"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.container_images.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Stage = "3" }
}

resource "aws_ecr_lifecycle_policy" "change_intelligence_agent" {
  repository = aws_ecr_repository.change_intelligence_agent.name
  policy     = local.image_lifecycle_policy
}

resource "aws_ecr_repository" "impact_analysis_agent" {
  name                 = "migration-api-development-impact-analysis-agent"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.container_images.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Stage = "3" }
}

resource "aws_ecr_lifecycle_policy" "impact_analysis_agent" {
  repository = aws_ecr_repository.impact_analysis_agent.name
  policy     = local.image_lifecycle_policy
}

resource "aws_ecr_repository" "migration_agent" {
  name                 = "migration-api-development-migration-agent"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.container_images.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Stage = "5" }
}

resource "aws_ecr_lifecycle_policy" "migration_agent" {
  repository = aws_ecr_repository.migration_agent.name
  policy     = local.image_lifecycle_policy
}

locals {
  image_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Retain the latest 30 immutable images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = { type = "expire" }
      }
    ]
  })
}
