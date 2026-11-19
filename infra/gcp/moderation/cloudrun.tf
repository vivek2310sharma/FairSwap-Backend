# infra/gcp/moderation/cloudrun.tf
# FairSwap Google Cloud Run Moderation Architecture V1
# Region: Mumbai (asia-south1)
# Serverless, request-based billing, min instances 0, bounded max instances.
# No always-on compute, no GKE, no VM.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  type        = string
  description = "GCP Project ID (e.g. fairswap-test or fairswap-prod)"
}

variable "environment" {
  type        = string
  description = "Target deployment environment (test or prod)"
  validation {
    condition     = contains(["test", "prod"], var.environment)
    error_message = "Environment must be either 'test' or 'prod'."
  }
}

variable "region" {
  type        = string
  default     = "asia-south1" # Mumbai, India
  description = "Google Cloud Region for deployment"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Container image tag from public GHCR"
}

variable "allowed_storage_host" {
  type        = string
  description = "Supabase project storage hostname (e.g. wpppxlnbzqynvhpeuavd.supabase.co for test, kriuhwppxgxsyyrbjsau.supabase.co for prod)"
}

variable "moderation_secret" {
  type        = string
  sensitive   = true
  description = "Shared secret for controller external authorization and internal worker calls"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# -----------------------------------------------------------------------------
# 1. Secret Manager for Moderation Secret
# -----------------------------------------------------------------------------
resource "google_secret_manager_secret" "mod_secret" {
  secret_id = "fairswap-moderation-secret-${var.environment}"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "mod_secret_val" {
  secret      = google_secret_manager_secret.mod_secret.id
  secret_data = var.moderation_secret
}

# -----------------------------------------------------------------------------
# 2. Dedicated Service Accounts
# -----------------------------------------------------------------------------
resource "google_service_account" "controller_sa" {
  account_id   = "sa-mod-ctrl-${var.environment}"
  display_name = "FairSwap Moderation Controller Service Account (${var.environment})"
}

resource "google_service_account" "vision_sa" {
  account_id   = "sa-mod-vision-${var.environment}"
  display_name = "FairSwap Moderation Node Vision Service Account (${var.environment})"
}

resource "google_service_account" "ocr_sa" {
  account_id   = "sa-mod-ocr-${var.environment}"
  display_name = "FairSwap Moderation Python OCR Service Account (${var.environment})"
}

# Grant Secret Access to Service Accounts
resource "google_secret_manager_secret_iam_member" "ctrl_secret_access" {
  secret_id = google_secret_manager_secret.mod_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.controller_sa.email}"
}

resource "google_secret_manager_secret_iam_member" "vision_secret_access" {
  secret_id = google_secret_manager_secret.mod_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vision_sa.email}"
}

resource "google_secret_manager_secret_iam_member" "ocr_secret_access" {
  secret_id = google_secret_manager_secret.mod_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ocr_sa.email}"
}

# -----------------------------------------------------------------------------
# 3. Private Worker: Node Vision (NSFWJS + MobileNet)
# Protected by Cloud Run IAM (invoker role granted strictly to controller SA)
# -----------------------------------------------------------------------------
resource "google_cloud_run_v2_service" "node_vision" {
  name     = "cr-node-vision-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.vision_sa.email

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {
      image = "ghcr.io/vivek2310sharma/fairswap-node-vision:${var.image_tag}"

      resources {
        limits = {
          cpu    = "1000m"
          memory = "1024Mi"
        }
      }

      ports {
        container_port = 8081
      }

      env {
        name  = "ALLOWED_STORAGE_HOST"
        value = var.allowed_storage_host
      }

      env {
        name = "MODERATION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.mod_secret.secret_id
            version = "latest"
          }
        }
      }
    }
  }
}

# -----------------------------------------------------------------------------
# 4. Private Worker: Python OCR (PaddleOCR + OpenCV QR)
# Protected by Cloud Run IAM (invoker role granted strictly to controller SA)
# -----------------------------------------------------------------------------
resource "google_cloud_run_v2_service" "python_ocr" {
  name     = "cr-python-ocr-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.ocr_sa.email

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {
      image = "ghcr.io/vivek2310sharma/fairswap-python-ocr:${var.image_tag}"

      resources {
        limits = {
          cpu    = "1000m"
          memory = "1536Mi"
        }
      }

      ports {
        container_port = 8082
      }

      env {
        name  = "ALLOWED_STORAGE_HOST"
        value = var.allowed_storage_host
      }

      env {
        name = "MODERATION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.mod_secret.secret_id
            version = "latest"
          }
        }
      }
    }
  }
}

# Allow Controller Service Account to invoke Private Workers
resource "google_cloud_run_v2_service_iam_member" "controller_invoke_vision" {
  name     = google_cloud_run_v2_service.node_vision.name
  location = google_cloud_run_v2_service.node_vision.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.controller_sa.email}"
}

resource "google_cloud_run_v2_service_iam_member" "controller_invoke_ocr" {
  name     = google_cloud_run_v2_service.python_ocr.name
  location = google_cloud_run_v2_service.python_ocr.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.controller_sa.email}"
}

# -----------------------------------------------------------------------------
# 5. External Controller (Public Ingress for Supabase Edge Functions)
# -----------------------------------------------------------------------------
resource "google_cloud_run_v2_service" "controller" {
  name     = "cr-moderation-controller-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.controller_sa.email

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    containers {
      image = "ghcr.io/vivek2310sharma/fairswap-moderation-controller:${var.image_tag}"

      resources {
        limits = {
          cpu    = "1000m"
          memory = "1024Mi"
        }
      }

      ports {
        container_port = 8080
      }

      env {
        name  = "ALLOWED_STORAGE_HOST"
        value = var.allowed_storage_host
      }

      env {
        name  = "NODE_VISION_SERVICE_URL"
        value = google_cloud_run_v2_service.node_vision.uri
      }

      env {
        name  = "PYTHON_OCR_SERVICE_URL"
        value = google_cloud_run_v2_service.python_ocr.uri
      }

      env {
        name  = "TIMEOUT_MS"
        value = "15000"
      }

      env {
        name  = "MODERATION_PROVIDER"
        value = "google_cloud"
      }

      env {
        name = "MODERATION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.mod_secret.secret_id
            version = "latest"
          }
        }
      }
    }
  }
}

# Allow external callers to reach controller (application-level authentication via X-Moderation-Secret)
resource "google_cloud_run_v2_service_iam_member" "controller_public_access" {
  name     = google_cloud_run_v2_service.controller.name
  location = google_cloud_run_v2_service.controller.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "controller_uri" {
  value       = google_cloud_run_v2_service.controller.uri
  description = "Public HTTPS URI of the Moderation Controller"
}

output "node_vision_uri" {
  value       = google_cloud_run_v2_service.node_vision.uri
  description = "Internal URI of Node Vision Worker"
}

output "python_ocr_uri" {
  value       = google_cloud_run_v2_service.python_ocr.uri
  description = "Internal URI of Python OCR Worker"
}
