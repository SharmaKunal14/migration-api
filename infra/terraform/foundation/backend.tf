terraform {
  backend "s3" {
    key          = "development/foundation.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
