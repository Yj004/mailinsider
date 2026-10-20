# MailInsider

MailInsider is a workspace for sending email from a connected Gmail account and reading what happened afterward. Each workspace connects its own Gmail account through the Gmail API and its own private Google Sheet through the Sheets API. A send can attach a PDF, include the recipient’s document link, and include that private sheet link. A public sheet link is not used. It records provider acceptance, opens, link requests, and document views.

## Deploy API (Docker → Artifact Registry → Cloud Run)

See **[docs/DEPLOY_CLOUD_RUN.md](docs/DEPLOY_CLOUD_RUN.md)**.

```bash
# Quick path (local Docker + gcloud)
PROJECT_ID=YOUR_GCP_PROJECT_ID REGION=asia-south1 ./scripts/deploy-api-cloudrun.sh
# Then set env vars / secrets as documented in that guide.
```

Or Cloud Build only:

```bash
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions=_REGION=asia-south1,_SERVICE=mailinsider-api,_REPO=mailinsider
```

## Run it locally

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r services/api/requirements.txt
cp .env.example .env
# Edit .env: JWT_SECRET, DATABASE_URL (Supabase), Google OAuth values, PUBLIC_OPEN_PIXEL_URL
uvicorn app.main:app --reload --app-dir services/api --host 127.0.0.1 --port 8765
```

In another terminal:

```bash
cd apps/web
npm install
VITE_API_URL=http://127.0.0.1:8765 npm run dev -- --host 127.0.0.1 --port 5178
```

Open http://127.0.0.1:5178 for the public site. Sign in lands on **Mail** (`/app/mail`). Connect Gmail under Integrations before sending.

### Supabase database

1. Create a project at https://supabase.com
2. Project Settings → Database → copy the Postgres URI
3. Prefix it for SQLAlchemy: `postgresql+psycopg://...` and add `?sslmode=require`
4. Put that in `DATABASE_URL` in `.env`
5. In the Supabase SQL editor, run these files in order:
   - `supabase/migrations/20261014120000_mailinsider_schema.sql`
   - `supabase/migrations/20261019120000_campaigns_templates_suppressions.sql`
   - `supabase/migrations/20261019140000_contact_crm_fields.sql`
   - `supabase/migrations/20261019150000_tracking_pixel_asset.sql`

Auth stays in the FastAPI app (JWT). Supabase is the Postgres host. Do not put the Supabase secret key in frontend env.

### Public open-tracking pixel (required for Gmail opens)

Gmail cannot load images from `127.0.0.1`. Open tracking uses a Supabase Edge Function that writes `open_pixel_requested` and returns the 1×1 GIF from Postgres.

1. Apply `supabase/migrations/20261019150000_tracking_pixel_asset.sql` in the SQL editor (if not already).
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and log in: `supabase login`
3. From the repo root, link the project and deploy:

```bash
supabase login
supabase link --project-ref desemifklpeifqbzicnu
supabase functions deploy open-pixel --no-verify-jwt
```

(Replace the project ref if yours differs. A local CLI binary may live at `.bin/supabase` after download.)

4. Set in `.env` (already set for this project):

```bash
PUBLIC_OPEN_PIXEL_URL=https://desemifklpeifqbzicnu.supabase.co/functions/v1/open-pixel
```

5. Restart the API. New emails embed that URL. Verify by opening
   `https://desemifklpeifqbzicnu.supabase.co/functions/v1/open-pixel/{token}.gif`
   from a recipient preview — the dashboard should show an open on that conversation.

Leave `PUBLIC_OPEN_PIXEL_URL` empty only for local pytest (falls back to `{PUBLIC_API_URL}/t/open`).

Until the Edge Function is deployed, Gmail may not record opens from image loads; link and document engagement still appear on the conversation.

### Google OAuth (Gmail + Sheets)

1. Google Cloud Console → create/select a project
2. Enable **Gmail API**, **Google Sheets API**, and **Google Drive API** (Drive is required to browse existing spreadsheets)
3. Configure the OAuth consent screen; add test users while in Testing
4. Create an OAuth client ID (Web application)
5. Add Authorized redirect URIs exactly:
   - `http://127.0.0.1:8765/api/v1/integrations/gmail/callback`
   - `http://127.0.0.1:8765/api/v1/integrations/sheets/callback`
6. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and both redirect URIs in `.env`

Gmail uses `gmail.send` plus `userinfo.email`. Sheets uses spreadsheets + Drive readonly so you can **browse any spreadsheet**, preview tabs, and **attach the one you want** (or create a fresh MailInsider send-log sheet). Leave Google vars empty only if you use the local demo connection.

## How to read the product

- **Accepted by Gmail** means Google took the message.
- **Opened** means the message was opened.
- **Link requested** / **Document viewed** appear on the same conversation timeline.
- **No activity detected** means nothing was observed yet.
- Each To recipient gets a separate copy so a signal stays with that person. Cc and Bcc are only offered when there is one To.

## AI writer & deliverability assist

Compose includes native AI controls (never auto-sends):

- **Write with AI** — generate drafts from a goal; tone/length controls; improve, shorten, change tone, personalize, subject suggestions, refine, grammar.
- **Spam & quality check** — content spam risk (Low/Medium/High), quality dimensions, findings with evidence, optional improved draft.
- **Authentication** — best-effort SPF/DMARC DNS TXT lookups for the connected From domain; DKIM shown as unknown without a selector.

Local LLM via **Ollama** (default). Set in `.env` (server only):

```
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2
```

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama serve   # if not already running
ollama pull llama3.2
```

Optional cloud fallback: `AI_PROVIDER=openai` (or `auto`) with `OPENAI_API_KEY`. For RAG embeddings: `OLLAMA_EMBED_MODEL=nomic-embed-text` (`ollama pull nomic-embed-text`). Restart the API after changing settings. Without a provider, manual compose still works; some improve paths fall back to rule-based cleanup.

**AI P&R** (`/app/ai-pr`): store career parameters, regulations, and knowledge documents. Compose AI retrieves relevant chunks (embeddings when Ollama embed model is available, otherwise lexical) so drafts stay grounded in your profile.

Scores estimate **content risk**, not a probability of inbox delivery.

## Campaigns, CRM, sheets import, and suppressions

- **Templates** (`/app/templates`): save reusable subjects/bodies with `{{first_name}}`, `{{company}}`, `{{role}}`, and other mapped fields.
- **Campaigns** (`/app/campaigns`): attach contacts (including Google Sheet imports), confirm recipient count, and launch through the same durable recipient queue used by Compose.
- **Contacts CRM** (`/app/contacts`): company, role, LinkedIn, job posting URL, pipeline status, notes, and next follow-up. Opens/clicks never move a contact backward from Interview or Replied.
- **Follow-up queue** (`/app/follow-ups`): overdue and upcoming reminders. Follow-ups are never sent automatically.
- **Sheet import**: with a connected sheet (or demo sheet), preview headers, map columns, and import contacts with row-level validation errors.
- **Unsubscribe / suppressions**: every outbound HTML body includes an opaque unsubscribe link. Confirmed unsubscribes are stored per workspace and blocked from later sends.

Gmail acceptance is not inbox delivery proof.

## What is enforced

The browser talks only to the FastAPI app. Every workspace route checks membership and role. Tracking tokens in URLs are random; the database stores their hashes. Click redirects only go to the https address stored when the message was created. Document files are stored in a private Supabase Storage bucket and served only with a valid, unrevoked link. Refresh tokens are encrypted at rest and never returned to the browser.

Tests cover tenant isolation, HTML sanitization, open redirects, pixel and click recording, burst filtering, document revocation, sheet import, campaigns, personalization, and unsubscribe suppressions:

```bash
cd services/api && ../../.venv/bin/python -m pytest tests -q
```
