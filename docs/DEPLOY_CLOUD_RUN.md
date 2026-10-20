# Deploy MailInsider API → Docker → Artifact Registry → Cloud Run

## One-time GCP setup

```bash
export PROJECT_ID=YOUR_GCP_PROJECT_ID
export REGION=asia-south1          # or us-central1, etc.
export REPO=mailinsider
export SERVICE=mailinsider-api

gcloud config set project "$PROJECT_ID"
gcloud auth login
gcloud auth configure-docker "${REGION}-docker.pkg.dev"
```

## Path A — script (local Docker build + push + deploy)

From the repo root (Docker Desktop / daemon must be running):

```bash
chmod +x scripts/deploy-api-cloudrun.sh
PROJECT_ID=YOUR_GCP_PROJECT_ID REGION=asia-south1 ./scripts/deploy-api-cloudrun.sh
```

## Path B — Cloud Build (no local Docker daemon)

```bash
# Create Artifact Registry repo once
gcloud artifacts repositories create mailinsider \
  --repository-format=docker \
  --location=asia-south1 \
  --description="MailInsider images"

gcloud builds submit --config=cloudbuild.yaml \
  --substitutions=_REGION=asia-south1,_SERVICE=mailinsider-api,_REPO=mailinsider
```

## Set production env vars (required after first deploy)

Replace `https://YOUR_CLOUD_RUN_URL` with the URL from `gcloud run services describe`.

```bash
export SERVICE=mailinsider-api
export REGION=asia-south1
export API_URL=https://YOUR_CLOUD_RUN_URL   # e.g. https://mailinsider-api-xxxxx-as.a.run.app
export APP_URL=https://YOUR_FRONTEND_URL    # Vercel/Netlify later; temporary: same as API is ok for smoke

gcloud run services update "$SERVICE" --region="$REGION" --update-env-vars="\
APP_ENV=production,\
JWT_SECRET=$(openssl rand -hex 32),\
DATABASE_URL=postgresql+psycopg://postgres:PASSWORD@db.desemifklpeifqbzicnu.supabase.co:5432/postgres?sslmode=require,\
PUBLIC_API_URL=${API_URL},\
PUBLIC_APP_URL=${APP_URL},\
CORS_ORIGINS=${APP_URL},\
PUBLIC_OPEN_PIXEL_URL=https://desemifklpeifqbzicnu.supabase.co/functions/v1/open-pixel,\
PUBLIC_DOCUMENT_URL=https://desemifklpeifqbzicnu.supabase.co/functions/v1/view-document,\
PUBLIC_CLICK_URL=https://desemifklpeifqbzicnu.supabase.co/functions/v1/track-click,\
SUPABASE_URL=https://desemifklpeifqbzicnu.supabase.co,\
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY,\
DOCUMENTS_BUCKET=documents,\
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID,\
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET,\
GOOGLE_REDIRECT_URI=${API_URL}/api/v1/integrations/gmail/callback,\
GOOGLE_SHEETS_REDIRECT_URI=${API_URL}/api/v1/integrations/sheets/callback,\
AI_PROVIDER=openai,\
OPENAI_API_KEY=YOUR_OPENAI_KEY,\
OPENAI_MODEL=gpt-4o-mini"
```

Prefer **Secret Manager** for secrets instead of plain env:

```bash
echo -n "YOUR_SERVICE_ROLE_KEY" | gcloud secrets create supabase-service-role --data-file=-
# grant Cloud Run SA access, then:
gcloud run services update "$SERVICE" --region="$REGION" \
  --update-secrets=SUPABASE_SERVICE_ROLE_KEY=supabase-service-role:latest
```

## Google OAuth

Add these **Authorized redirect URIs** in Google Cloud Console:

- `{API_URL}/api/v1/integrations/gmail/callback`
- `{API_URL}/api/v1/integrations/sheets/callback`

## Verify

```bash
curl -s "$API_URL/health"
# {"status":"ok"}
```

## Local image smoke test (optional)

```bash
docker build -f services/api/Dockerfile -t mailinsider-api:local .
docker run --rm -p 8080:8080 \
  -e APP_ENV=development \
  -e JWT_SECRET=dev-only-change-me \
  -e DATABASE_URL="postgresql+psycopg://..." \
  -e SUPABASE_URL=https://desemifklpeifqbzicnu.supabase.co \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  mailinsider-api:local

curl -s http://127.0.0.1:8080/health
```

## Notes

- Cloud Run sets `PORT=8080`; the Dockerfile reads it.
- Document / open / click links stay on **Supabase Edge Functions** (already public).
- Use `AI_PROVIDER=openai` on Cloud Run (Ollama is for local only).
- After the frontend is deployed, update `PUBLIC_APP_URL` + `CORS_ORIGINS` to that origin.
