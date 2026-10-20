#!/usr/bin/env bash
# Build API image → push to Artifact Registry → deploy Cloud Run.
# Prerequisites: gcloud auth, Docker, project with billing.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-asia-south1}"
REPO="${REPO:-mailinsider}"
SERVICE="${SERVICE:-mailinsider-api}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}"

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "Set PROJECT_ID or run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Project: ${PROJECT_ID}"
echo "==> Image:   ${IMAGE}:${TAG}"

echo "==> Enable APIs"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  --project="${PROJECT_ID}"

echo "==> Ensure Artifact Registry repo (${REPO})"
if ! gcloud artifacts repositories describe "${REPO}" --location="${REGION}" --project="${PROJECT_ID}" &>/dev/null; then
  gcloud artifacts repositories create "${REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="MailInsider images" \
    --project="${PROJECT_ID}"
fi

echo "==> Configure Docker auth for Artifact Registry"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo "==> Build (linux/amd64 for Cloud Run)"
docker build --platform=linux/amd64 -f services/api/Dockerfile -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" .

echo "==> Push"
docker push "${IMAGE}:${TAG}"
docker push "${IMAGE}:latest"

echo "==> Deploy Cloud Run"
gcloud run deploy "${SERVICE}" \
  --image="${IMAGE}:${TAG}" \
  --region="${REGION}" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --memory=1Gi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=5 \
  --timeout=300 \
  --project="${PROJECT_ID}"

URL="$(gcloud run services describe "${SERVICE}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"
echo ""
echo "Deployed: ${URL}"
echo "Health:   ${URL}/health"
echo ""
echo "Next: set env vars (once) — see docs/DEPLOY_CLOUD_RUN.md"
echo "  gcloud run services update ${SERVICE} --region=${REGION} --update-env-vars=..."
