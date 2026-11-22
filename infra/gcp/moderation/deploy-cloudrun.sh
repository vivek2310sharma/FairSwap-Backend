#!/usr/bin/env bash
# infra/gcp/moderation/deploy-cloudrun.sh
# Deterministic Google Cloud Run deployment script for FairSwap Moderation V1
# Enforces request-based billing, min-instances 0, Mumbai region (asia-south1),
# private worker ingress, and external controller ingress.

set -euo pipefail

ENVIRONMENT="${1:-test}"
if [[ "$ENVIRONMENT" != "test" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Usage: $0 [test|prod]" >&2
  exit 1
fi

PROJECT_ID="${GCP_PROJECT_ID:?Missing GCP_PROJECT_ID environment variable}"
REGION="${GCP_REGION:-asia-south1}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
NODE_VISION_IMAGE="${NODE_VISION_IMAGE:-ghcr.io/vivek2310sharma/fairswap-node-vision:${IMAGE_TAG}}"
PYTHON_OCR_IMAGE="${PYTHON_OCR_IMAGE:-ghcr.io/vivek2310sharma/fairswap-python-ocr:${IMAGE_TAG}}"
CONTROLLER_IMAGE="${CONTROLLER_IMAGE:-ghcr.io/vivek2310sharma/fairswap-moderation-controller:${IMAGE_TAG}}"
MODERATION_SECRET="${MODERATION_SECRET:?Missing MODERATION_SECRET environment variable}"

if [[ "$ENVIRONMENT" == "prod" ]]; then
  ALLOWED_STORAGE_HOST="kriuhwppxgxsyyrbjsau.supabase.co"
else
  ALLOWED_STORAGE_HOST="wpppxlnbzqynvhpeuavd.supabase.co"
fi

echo "Deploying FairSwap Google Cloud Moderation V1 to environment: $ENVIRONMENT (Project: $PROJECT_ID, Region: $REGION)..."

# 1. Store or update MODERATION_SECRET in Secret Manager
SECRET_NAME="fairswap-moderation-secret-${ENVIRONMENT}"
if ! gcloud secrets describe "$SECRET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "Creating secret $SECRET_NAME in Secret Manager..."
  gcloud secrets create "$SECRET_NAME" --replication-policy="automatic" --project="$PROJECT_ID"
fi
echo -n "$MODERATION_SECRET" | gcloud secrets versions add "$SECRET_NAME" --data-file=- --project="$PROJECT_ID"

# 2. Deploy Private Node Vision Service (Protected by Cloud Run IAM)
echo "Deploying Node Vision worker..."
gcloud run deploy "cr-node-vision-${ENVIRONMENT}" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="${NODE_VISION_IMAGE}" \
  --platform="managed" \
  --ingress="all" \
  --min-instances=0 \
  --max-instances=5 \
  --cpu=1 \
  --memory=1024Mi \
  --port=8081 \
  --service-account="sa-mod-vision-${ENVIRONMENT}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --set-env-vars="ALLOWED_STORAGE_HOST=${ALLOWED_STORAGE_HOST}" \
  --set-secrets="MODERATION_SECRET=${SECRET_NAME}:latest" \
  --no-allow-unauthenticated

NODE_VISION_URI=$(gcloud run services describe "cr-node-vision-${ENVIRONMENT}" --project="$PROJECT_ID" --region="$REGION" --format="value(status.url)")

# 3. Deploy Private Python OCR Service (Protected by Cloud Run IAM)
echo "Deploying Python OCR worker..."
gcloud run deploy "cr-python-ocr-${ENVIRONMENT}" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="${PYTHON_OCR_IMAGE}" \
  --platform="managed" \
  --ingress="all" \
  --min-instances=0 \
  --max-instances=5 \
  --cpu=1 \
  --memory=1536Mi \
  --port=8082 \
  --service-account="sa-mod-ocr-${ENVIRONMENT}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --set-env-vars="ALLOWED_STORAGE_HOST=${ALLOWED_STORAGE_HOST}" \
  --set-secrets="MODERATION_SECRET=${SECRET_NAME}:latest" \
  --no-allow-unauthenticated

PYTHON_OCR_URI=$(gcloud run services describe "cr-python-ocr-${ENVIRONMENT}" --project="$PROJECT_ID" --region="$REGION" --format="value(status.url)")

# Grant Controller Service Account invoker permissions on Workers via IAM
echo "Binding Controller invoker permissions to workers..."
gcloud run services add-iam-policy-binding "cr-node-vision-${ENVIRONMENT}" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --member="serviceAccount:sa-mod-ctrl-${ENVIRONMENT}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker" \
  --quiet

gcloud run services add-iam-policy-binding "cr-python-ocr-${ENVIRONMENT}" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --member="serviceAccount:sa-mod-ctrl-${ENVIRONMENT}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker" \
  --quiet

# 4. Deploy External Controller Service
echo "Deploying Moderation Controller..."
gcloud run deploy "cr-moderation-controller-${ENVIRONMENT}" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="${CONTROLLER_IMAGE}" \
  --platform="managed" \
  --ingress="all" \
  --min-instances=0 \
  --max-instances=10 \
  --cpu=1 \
  --memory=1024Mi \
  --port=8080 \
  --timeout=30s \
  --service-account="sa-mod-ctrl-${ENVIRONMENT}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --set-env-vars="ALLOWED_STORAGE_HOST=${ALLOWED_STORAGE_HOST},NODE_VISION_SERVICE_URL=${NODE_VISION_URI},PYTHON_OCR_SERVICE_URL=${PYTHON_OCR_URI},TIMEOUT_MS=15000,MODERATION_PROVIDER=google_cloud" \
  --set-secrets="MODERATION_SECRET=${SECRET_NAME}:latest" \
  --allow-unauthenticated

CONTROLLER_URI=$(gcloud run services describe "cr-moderation-controller-${ENVIRONMENT}" --project="$PROJECT_ID" --region="$REGION" --format="value(status.url)")

echo "Deployment completed successfully."
echo "Controller Public URI: $CONTROLLER_URI"
echo "Node Vision URI: $NODE_VISION_URI"
echo "Python OCR URI: $PYTHON_OCR_URI"
