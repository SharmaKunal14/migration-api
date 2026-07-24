terraform {
  backend "s3" {
    key          = "development/application.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

