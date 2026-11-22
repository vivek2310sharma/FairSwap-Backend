# FairSwap Google Cloud Moderation V1 — Owner Bootstrap & IAM/OIDC Setup

## 1. Overview
FairSwap Google Cloud Moderation V1 deploys containerized moderation services (Controller, Node Vision, Python OCR) to **Google Cloud Run** in the **Mumbai region (`asia-south1`)**.
- Request-based billing, min instances `0` (scale-to-zero), bounded max instances (5-10).
- 0 always-on compute, no GKE, no VM.
- Private authenticated worker calls (Node Vision and Python OCR are internal-only).
- External Controller boundary with `X-Moderation-Secret` authentication.
- Keyless GitHub Actions CI/CD using **Workload Identity Federation (WIF)** (no service-account JSON keys).
- Kept **disabled by default** (`moderation_google_cloud_enabled = 'false'`) across Test and Production.

---

## 2. One-Time Project Bootstrap Checklist

### Step 2.1: Enable Required Google Cloud APIs
Run in your Google Cloud Shell or authenticated terminal for both projects (`fairswap-test` and `fairswap-prod`):

```bash
gcloud services enable \
  run.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  secretmanager.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="<GCP_PROJECT_ID>"
```

### Step 2.2: Create Service Accounts
Create dedicated least-privilege service accounts:

```bash
# 1. Controller service account
gcloud iam service-accounts create sa-mod-ctrl-<ENV> \
  --display-name="FairSwap Moderation Controller (<ENV>)" \
  --project="<GCP_PROJECT_ID>"

# 2. Node Vision worker service account
gcloud iam service-accounts create sa-mod-vision-<ENV> \
  --display-name="FairSwap Node Vision Worker (<ENV>)" \
  --project="<GCP_PROJECT_ID>"

# 3. Python OCR worker service account
gcloud iam service-accounts create sa-mod-ocr-<ENV> \
  --display-name="FairSwap Python OCR Worker (<ENV>)" \
  --project="<GCP_PROJECT_ID>"

# 4. GitHub Actions Deployment CI service account
gcloud iam service-accounts create sa-github-ci-<ENV> \
  --display-name="FairSwap GitHub Actions CI (<ENV>)" \
  --project="<GCP_PROJECT_ID>"
```

### Step 2.3: Assign Service-to-Service Invocation Permissions
Workers (`cr-node-vision` and `cr-python-ocr`) are deployed with `--no-allow-unauthenticated` (public requests return HTTP 403 Forbidden).
Cloud Run IAM restricts invocation: the controller service account is granted `roles/run.invoker` on both workers.
At runtime, the controller generates Google-signed audience-specific ID tokens via the instance metadata server to invoke workers securely without requiring extra VPC network infrastructure:

```bash
# Allow Controller to call Vision worker
gcloud run services add-iam-policy-binding "cr-node-vision-<ENV>" \
  --project="<GCP_PROJECT_ID>" \
  --region="asia-south1" \
  --member="serviceAccount:sa-mod-ctrl-<ENV>@<GCP_PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# Allow Controller to call Python OCR worker
gcloud run services add-iam-policy-binding "cr-python-ocr-<ENV>" \
  --project="<GCP_PROJECT_ID>" \
  --region="asia-south1" \
  --member="serviceAccount:sa-mod-ctrl-<ENV>@<GCP_PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# Grant CI account permissions to deploy Cloud Run and act as service accounts
gcloud projects add-iam-policy-binding "<GCP_PROJECT_ID>" \
  --member="serviceAccount:sa-github-ci-<ENV>@<GCP_PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding "<GCP_PROJECT_ID>" \
  --member="serviceAccount:sa-github-ci-<ENV>@<GCP_PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding "<GCP_PROJECT_ID>" \
  --member="serviceAccount:sa-github-ci-<ENV>@<GCP_PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.admin"
```

### Step 2.4: Setup GitHub Actions OIDC Workload Identity Federation (WIF)
Configure passwordless OIDC authentication from GitHub Actions:

```bash
# 1. Create Workload Identity Pool
gcloud iam workload-identity-pools create "github-pool" \
  --project="<GCP_PROJECT_ID>" \
  --location="global" \
  --display-name="GitHub Actions Pool"

# Get Pool ID
POOL_ID=$(gcloud iam workload-identity-pools describe "github-pool" \
  --project="<GCP_PROJECT_ID>" \
  --location="global" \
  --format="value(name)")

# 2. Create OIDC Provider for GitHub Actions
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --project="<GCP_PROJECT_ID>" \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub Actions Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
  --issuer-uri="https://token.actions.githubusercontent.com"

# 3. Allow GitHub repository to impersonate the CI service account
gcloud iam service-accounts add-iam-policy-binding \
  "sa-github-ci-<ENV>@<GCP_PROJECT_ID>.iam.gserviceaccount.com" \
  --project="<GCP_PROJECT_ID>" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/vivek2310sharma/FairSwap-Backend"
```

---

## 3. GitHub Repository Secrets & Environment Values

Configure in GitHub Settings -> Environments (`FairSwapTest` and `FairSwapProd`):

| Secret / Variable Name | Description | Example / Required Format |
|---|---|---|
| `GCP_PROJECT_ID` | Project Ref in Google Cloud | `fairswap-test-XXXX` / `fairswap-prod-XXXX` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full resource name of OIDC provider | `projects/<NUM>/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `GCP_SERVICE_ACCOUNT` | Email of deployment CI service account | `sa-github-ci-test@<PROJECT_ID>.iam.gserviceaccount.com` |
| `GOOGLE_CLOUD_MODERATION_SECRET` | High-entropy random secret (>= 16 chars) | `openssl rand -hex 32` |
| `SUPABASE_ACCESS_TOKEN` | Pinned Supabase CLI access token | Token with secret write permissions |

---

## 4. Rollout & Rollback Sequence

### Rollout (Automated CI/CD):
1. **GitHub CI Trigger**: Workflow `Deploy Google Cloud Moderation (OIDC)` runs on `workflow_dispatch`.
2. **FairSwapTest Deploy**:
   - Builds/publishes multi-arch images to GHCR.
   - Deploys Cloud Run services in `asia-south1`.
   - Runs automated postflight verification (cold start, ingress isolation, scale-to-zero, 401 unauthenticated blocking).
   - Configures `GOOGLE_CLOUD_MODERATION_ENDPOINT` and `GOOGLE_CLOUD_MODERATION_SECRET` in Supabase Edge runtime.
3. **Automated Verification**: Probes test edge functions to ensure 401 fail-closed protection.
4. **FairSwapProd Deploy**:
   - Executes identical deployment and verification against `FairSwapProd` environment.
5. **Feature Activation** (Zero-downtime, separate explicit step):
   - Toggle `moderation_google_cloud_enabled = 'true'` via Supabase dashboard / Vault.

### Rollback:
- Set `moderation_google_cloud_enabled = 'false'` in `public.app_system_settings`.
- Instant killswitch: `moderation_automation_enabled = 'false'`.
