# Email & Document Engagement SaaS
# Product name : MailInsider
## Enterprise Product Plan: From Discovery to Production

**Status:** Planning blueprint\
**Product type:** Multi-tenant B2B SaaS\
**Backend:** FastAPI (Python)\
**Database and authentication foundation:** Supabase (PostgreSQL, Auth,
Storage as needed)\
**Email sending:** Gmail / Google Workspace\
**Frontend assumption:** React + TypeScript\
**Document format:** Implementation-oriented product, architecture,
security, and delivery plan

------------------------------------------------------------------------

## 1. Executive Summary

Build a secure, multi-tenant SaaS application that lets authorized users
send emails through Gmail and view engagement signals for each message.
The product should provide a recipient timeline covering delivery events
where available, estimated email opens, tracked link clicks, and
document-viewing activity.

The system must distinguish **observed events** from **inferences**. An
image load is not proof that a person read an email; privacy proxies may
pre-load images, recipients may block images, and security scanners may
visit links. The application must not claim definitive "read" status
based only on an open pixel. Use labels such as **Open detected
(estimated)**, **Link clicked**, **Document viewed**, and **No activity
detected**.

### Product goals

1.  Connect a user's Gmail or Google Workspace account with explicit
    OAuth consent.
2.  Send an email to one or more recipients, subject to provider limits
    and product policy.
3.  Track email-open signals with a unique tracking pixel where the
    email client permits it.
4.  Track link clicks through secure redirect URLs.
5.  Offer a controlled document viewer for view and page-activity
    events.
6.  Present a searchable message list, recipient activity timeline, and
    engagement analytics.
7.  Provide enterprise-grade tenant isolation, auditability, privacy
    controls, and operational monitoring.

### Non-goals for the first release

-   Bypassing Gmail sending limits or anti-abuse systems.
-   Guaranteeing that an email was read by a human.
-   Secretly identifying recipients or fingerprinting their devices.
-   Replacing a full marketing automation / CRM platform.
-   Tracking activity on third-party websites after a recipient leaves
    the application.
-   Claiming document reading time from a background tab or unattended
    browser session.

------------------------------------------------------------------------

## 2. Product Requirements

### 2.1 Core user journeys

**Journey A --- Connect Gmail** 1. User creates an account and verifies
their email. 2. User selects **Connect Gmail**. 3. Google OAuth consent
flow requests only the scopes required for the selected features. 4.
Backend validates the OAuth response, securely stores refresh
credentials where permitted, and records the connection status. 5. User
can disconnect the account and revoke access.

**Journey B --- Send a tracked email** 1. User creates a message with
recipients, subject, body, and optional document/link. 2. The
application validates recipient addresses, permissions, quotas, and
message content. 3. Backend creates a message record and opaque tracking
tokens. 4. Backend inserts tracking links and, if enabled, an
open-tracking pixel. 5. The Gmail integration sends the message. 6. The
app records the provider response and shows sent/error state. 7.
Tracking events arrive later and update the activity timeline.

**Journey C --- Review engagement** 1. User opens a message details
page. 2. App shows sending state, available delivery signals, estimated
open events, click events, and document events. 3. Events are displayed
chronologically and deduplicated. 4. UI explains that opens and clicks
can be triggered by privacy proxies or security scanners.

**Journey D --- Share a document** 1. User uploads or selects a
document. 2. App generates a recipient-specific, revocable access token.
3. Recipient opens a hosted viewer. 4. Backend authorizes access and
records a document-open event. 5. The viewer records page changes and
download requests where supported. 6. Owner can revoke the link and
inspect access history.

### 2.2 Functional requirements

-   User registration, login, logout, password recovery, and account
    settings.
-   Gmail / Google Workspace OAuth connection and disconnection.
-   Message composer with To, Cc/Bcc where supported, subject,
    HTML/plain-text body, and attachments only if included in scope.
-   Recipient validation and send confirmation.
-   Send queue, retries, rate limits, and visible error states.
-   Tracking tokens unique to message-recipient-link combinations.
-   Open pixel endpoint with a tiny image response and no recipient PII
    in the URL.
-   Click redirect endpoint that only redirects to a destination stored
    and validated by the server.
-   Provider response logging, where available.
-   Event timeline with timestamps and event-source labels.
-   Document viewer with authorization, expiration, revocation, and
    audit log.
-   Export of activity reports, subject to role permissions.
-   Workspace/team membership and roles.
-   Tenant-aware audit logs and account deletion/export workflows.

### 2.3 Non-functional requirements

-   Security: least-privilege OAuth scopes, strict tenant isolation,
    secret management, rate limits, and audit logs.
-   Reliability: idempotent event ingestion and safe retries.
-   Performance: paginated activity timelines and indexed event queries.
-   Maintainability: typed schemas, service boundaries, migrations,
    automated tests, and API documentation.
-   Observability: structured logs, error tracking, latency metrics, and
    alerts.
-   Privacy: clear notices, configurable retention, data minimization,
    and applicable legal review.
-   Accessibility: keyboard navigation, readable contrast, and
    accessible status indicators.

------------------------------------------------------------------------

## 3. Gmail Integration: Important Architecture Decision

Gmail is the sending provider, not a universal source of accurate
open/read status. Gmail does not provide a general-purpose, reliable
"recipient read this message" API for arbitrary emails.

### 3.1 Recommended integration

Use **Google OAuth 2.0** and the **Gmail API** to send email from a
connected account. Request the narrowest scopes compatible with the
product. Sending typically requires a Gmail send scope; do not request
mailbox-reading scopes unless a separately justified feature needs them.

-   Use OAuth Authorization Code flow with a backend callback.
-   Validate `state` and use PKCE where supported by the selected
    flow/library.
-   Store refresh tokens encrypted at rest; never expose them to the
    frontend.
-   Keep Google client secrets and encryption keys in a secret manager
    or secure deployment configuration.
-   Implement token refresh, revoked-consent handling, and
    disconnect/revoke flows.
-   Follow Google OAuth verification and restricted/sensitive-scope
    requirements applicable to the final scope set.
-   Respect Gmail / Google Workspace sending quotas and anti-abuse
    policies. Show quota errors and retry guidance; never try to evade
    provider limits.
-   Review Google's current API terms, user-data policy, and OAuth
    verification requirements before production launch.

### 3.2 Sending flow

1.  Frontend sends a request to `POST /api/v1/messages`.
2.  FastAPI authenticates the user and checks tenant membership.
3.  Backend validates the request and creates the message record with
    status `queued`.
4.  Backend creates opaque tracking tokens and stores only token hashes
    where practical.
5.  Backend renders a safe HTML/plain-text message and rewrites eligible
    links.
6.  A worker sends through Gmail API, then stores the Gmail message ID
    and result.
7.  Status becomes `sent` or `failed`; subsequent signals are recorded
    as separate events.

Use a queue/worker pattern if sending is not completed quickly within
the request. For an initial low-volume MVP, a background worker is still
preferable to long-running HTTP requests.

### 3.3 Provider limitations

-   Gmail API send success means the provider accepted the message; it
    does not prove final inbox delivery.
-   A Gmail connection alone does not guarantee reliable bounce or
    delivery webhooks for arbitrary outgoing mail.
-   Open tracking depends on images being loaded and may be distorted by
    privacy features.
-   Click tracking can be triggered by security scanners, link previews,
    or automated systems.
-   Do not label a message "read" solely because a tracking pixel
    loaded.

------------------------------------------------------------------------

## 4. System Architecture

### 4.1 Logical architecture

``` text
React + TypeScript frontend
        |
        | HTTPS + authenticated API
        v
FastAPI application
  |-- Authentication / tenant authorization
  |-- Gmail OAuth and token lifecycle
  |-- Message composer and send API
  |-- Tracking endpoints (pixel / redirect)
  |-- Document access and viewer API
  |-- Analytics and activity timeline
  |-- Audit events
        |
        +---- Supabase Auth
        |
        +---- Supabase PostgreSQL
        |
        +---- Supabase Storage (private buckets, if used)
        |
        +---- Gmail API (OAuth)
        |
        +---- Background worker / queue
        |
        +---- Monitoring, logs, alerts
```

### 4.2 Suggested deployment

-   Frontend: Vercel, Cloudflare Pages, or an equivalent managed static
    frontend host.
-   API: Google Cloud Run or another managed container platform.
-   Database/auth/storage: Supabase.
-   Worker: separate Cloud Run worker or managed job, with a durable
    queue if workload warrants it.
-   Secrets: Google Secret Manager or equivalent; do not commit secrets
    to source control.
-   CI/CD: GitHub Actions with test, lint, migration checks, image
    build, and deployment stages.
-   Domain: use a dedicated HTTPS application domain and configure
    security headers.

Avoid introducing multiple queues, caches, and analytics systems before
usage requires them. The MVP can use Supabase Postgres as the source of
truth and add a durable queue when sending volume or retry needs justify
it.

------------------------------------------------------------------------

## 5. Supabase Data Model

Use PostgreSQL migrations as the source of truth. Use UUID primary keys,
UTC timestamps (`timestamptz`), foreign keys, and indexes based on real
query patterns.

### 5.1 Tables

#### `profiles`

-   `id uuid primary key references auth.users(id)`
-   `display_name text`
-   `created_at timestamptz not null default now()`

#### `workspaces`

-   `id uuid primary key`
-   `name text not null`
-   `created_by uuid references auth.users(id)`
-   `created_at timestamptz not null default now()`

#### `workspace_members`

-   `workspace_id uuid references workspaces(id)`
-   `user_id uuid references auth.users(id)`
-   `role text` --- constrain to supported roles such as `owner`,
    `admin`, `member`, `viewer`
-   `created_at timestamptz not null default now()`
-   Composite primary key: `(workspace_id, user_id)`

#### `gmail_connections`

-   `id uuid primary key`
-   `workspace_id uuid not null references workspaces(id)`
-   `connected_by uuid not null references auth.users(id)`
-   `google_account_email text not null`
-   `google_subject_id text`
-   `encrypted_refresh_token text not null`
-   `granted_scopes text[] not null`
-   `status text not null` --- `connected`, `needs_reauth`,
    `disconnected`
-   `created_at timestamptz not null default now()`
-   `updated_at timestamptz not null default now()`

**Security:** never return `encrypted_refresh_token` to the browser.
Prefer application-layer encryption with keys held outside the database.
Restrict table access to trusted backend operations.

#### `contacts`

-   `id uuid primary key`
-   `workspace_id uuid not null references workspaces(id)`
-   `email text not null`
-   `display_name text`
-   `created_at timestamptz not null default now()`
-   Unique constraint on `(workspace_id, lower(email))` if normalized
    case-insensitive matching is desired.

#### `messages`

-   `id uuid primary key`
-   `workspace_id uuid not null references workspaces(id)`
-   `created_by uuid not null references auth.users(id)`
-   `gmail_connection_id uuid references gmail_connections(id)`
-   `gmail_message_id text`
-   `subject text not null`
-   `body_format text not null`
-   `send_status text not null` --- `draft`, `queued`, `sending`,
    `sent`, `failed`
-   `sent_at timestamptz`
-   `created_at timestamptz not null default now()`

#### `message_recipients`

-   `id uuid primary key`
-   `workspace_id uuid not null references workspaces(id)`
-   `message_id uuid not null references messages(id)`
-   `contact_id uuid references contacts(id)`
-   `email_snapshot text not null`
-   `recipient_type text not null` --- `to`, `cc`, `bcc`
-   `created_at timestamptz not null default now()`

Keep the recipient snapshot to preserve the recipient address used at
send time. Limit access because this is personal data.

#### `tracking_links`

-   `id uuid primary key`
-   `workspace_id uuid not null references workspaces(id)`
-   `message_recipient_id uuid not null references message_recipients(id)`
-   `token_hash text not null unique`
-   `destination_url text not null`
-   `created_at timestamptz not null default now()`
-   `revoked_at timestamptz`

Validate allowed schemes and destinations. Do not accept an arbitrary
destination from the redirect request.

#### `document_assets`

-   `id uuid primary key`
-   `workspace_id uuid not null references workspaces(id)`
-   `uploaded_by uuid not null references auth.users(id)`
-   `storage_path text not null`
-   `filename text not null`
-   `content_type text not null`
-   `size_bytes bigint not null`
-   `created_at timestamptz not null default now()`

#### `document_access_tokens`

-   `id uuid primary key`
-   `workspace_id uuid not null references workspaces(id)`
-   `document_id uuid not null references document_assets(id)`
-   `message_recipient_id uuid references message_recipients(id)`
-   `token_hash text not null unique`
-   `expires_at timestamptz`
-   `revoked_at timestamptz`
-   `created_at timestamptz not null default now()`

#### `tracking_events`

-   `id uuid primary key`
-   `workspace_id uuid not null references workspaces(id)`
-   `message_id uuid not null references messages(id)`
-   `message_recipient_id uuid references message_recipients(id)`
-   `event_type text not null`
-   `source text not null` --- `gmail_api`, `tracking_pixel`,
    `redirect`, `document_viewer`, `system`
-   `occurred_at timestamptz not null default now()`
-   `received_at timestamptz not null default now()`
-   `idempotency_key text`
-   `metadata jsonb not null default '{}'::jsonb`

Use a unique constraint on `(source, idempotency_key)` when an event
source supplies a stable idempotency key. Avoid storing full IP
addresses or user-agent strings by default; if operationally necessary,
define a limited retention and access policy.

#### `audit_logs`

-   `id uuid primary key`
-   `workspace_id uuid not null references workspaces(id)`
-   `actor_user_id uuid`
-   `action text not null`
-   `target_type text`
-   `target_id uuid`
-   `created_at timestamptz not null default now()`
-   `metadata jsonb not null default '{}'::jsonb`

Audit logs should be append-only for normal application users.

### 5.2 Essential indexes

-   `messages(workspace_id, created_at desc)`
-   `messages(workspace_id, send_status, created_at desc)`
-   `message_recipients(message_id)`
-   `tracking_events(workspace_id, message_id, occurred_at desc)`
-   `tracking_events(message_recipient_id, occurred_at desc)`
-   `tracking_events(workspace_id, event_type, occurred_at desc)`
-   Unique indexes for token hashes and idempotency keys.

Review indexes against actual query plans as data grows. Do not add
indexes indiscriminately.

### 5.3 Row Level Security (RLS)

-   Enable RLS on all tables exposed through Supabase APIs.
-   Enforce workspace membership on every user-facing read/write policy.
-   Apply role-based policies for owner/admin/member/viewer
    capabilities.
-   Do not rely on frontend checks for authorization.
-   Keep the Supabase service-role key exclusively on trusted servers;
    it bypasses RLS.
-   When FastAPI uses privileged database credentials, it must
    explicitly authorize the current user and workspace on every
    request.
-   Add automated cross-tenant tests to ensure one workspace cannot read
    or modify another workspace's data.

------------------------------------------------------------------------

## 6. Tracking Semantics and Event Definitions

### 6.1 Recommended event types

-   `message_queued`
-   `message_send_started`
-   `message_send_succeeded`
-   `message_send_failed`
-   `open_pixel_requested`
-   `tracked_link_requested`
-   `document_access_granted`
-   `document_view_started`
-   `document_page_viewed`
-   `document_download_requested`
-   `document_access_denied`
-   `tracking_link_revoked`

Keep event names stable and version event payloads if their structure
changes.

### 6.2 Open pixel

-   Use a cryptographically random, opaque token with sufficient
    entropy.
-   Store a hash of the token where practical.
-   Resolve the token to a specific message-recipient record.
-   Return a valid tiny image with appropriate cache controls.
-   Record `open_pixel_requested`; do not automatically equate this with
    a human read.
-   Prevent duplicate event spam from inflating unique-open metrics.
-   Avoid including email addresses, names, or internal IDs in the URL.
-   Provide a product setting to disable open tracking.

### 6.3 Link redirects

-   Store the destination URL server-side when creating the message.
-   Generate a random tracking token; never trust a destination URL
    passed by the requester.
-   Resolve the token, verify that it is active, record the request, and
    redirect only to the stored allowed destination.
-   Allow only appropriate web schemes such as HTTPS; reject
    `javascript:`, `data:`, and other unsafe schemes.
-   Rate-limit and monitor abnormal request patterns.
-   A click event is evidence that a URL was requested, not proof of
    human intent. Security scanners can follow links.

### 6.4 Document tracking

-   Keep files in a private Supabase Storage bucket or equivalent
    private object storage.
-   Authorize access through short-lived signed URLs or an authenticated
    application viewer.
-   For recipient-specific access, use revocable, expiring tokens and
    store only token hashes.
-   Record a document view only after the viewer successfully loads.
-   Record page changes from the viewer where supported.
-   Record download requests separately from page views.
-   Do not claim that a page was read simply because it was rendered.
-   For sensitive documents, consider disabling downloads only if the
    viewer and document format genuinely support that control; no
    browser-based viewer can prevent screenshots or external capture.

### 6.5 Metrics and terminology

Prefer: - **Sent:** Gmail API accepted the send request. -
**Delivered:** only when a trustworthy provider event confirms
delivery. - **Open detected (estimated):** tracking pixel requested. -
**Unique clickers:** distinct recipients with at least one eligible
click event, with bot filtering disclosed. - **Document viewed:**
controlled viewer loaded successfully. - **No activity detected:** no
tracked event observed; this does not mean unread. - **Read receipt:**
only when an explicit, valid read-receipt signal exists.

Use bot/scanner heuristics as a classification, not as certainty.
Preserve raw events and show filtered/estimated metrics transparently.

------------------------------------------------------------------------

## 7. API Contract Plan

Prefix APIs with `/api/v1`. Use JSON, UTC timestamps, consistent error
objects, request IDs, pagination, and input validation.

### Gmail connection

-   `GET /api/v1/integrations/gmail/connect` --- begin OAuth flow.
-   `GET /api/v1/integrations/gmail/callback` --- validate OAuth
    response and persist connection.
-   `GET /api/v1/integrations/gmail/connections` --- list safe
    connection metadata.
-   `DELETE /api/v1/integrations/gmail/connections/{connection_id}` ---
    disconnect and securely remove/revoke credentials as appropriate.

### Messages

-   `POST /api/v1/messages` --- create and enqueue a message.
-   `GET /api/v1/messages` --- list messages with pagination and
    filters.
-   `GET /api/v1/messages/{message_id}` --- message metadata and
    computed summary.
-   `GET /api/v1/messages/{message_id}/events` --- authorized event
    timeline.
-   `POST /api/v1/messages/{message_id}/retry` --- retry a safely
    retryable failed send.
-   `DELETE /api/v1/messages/{message_id}/tracking` --- revoke tracking
    tokens where supported.

### Tracking

-   `GET /t/open/{token}.gif` --- tracking pixel endpoint.
-   `GET /t/click/{token}` --- validate, record, and redirect.
-   `GET /d/{token}` --- authorize and open document viewer.
-   `POST /api/v1/documents/{document_id}/events` --- record
    authenticated viewer events.

Public tracking endpoints should return minimal information and must not
reveal whether arbitrary recipient records exist. Avoid detailed error
messages that allow token enumeration.

### Analytics

-   `GET /api/v1/analytics/overview?from=...&to=...`
-   `GET /api/v1/analytics/messages/{message_id}`
-   `GET /api/v1/analytics/recipients/{recipient_id}`

All analytics must be scoped to the authenticated user's workspace and
role.

### Example send request

``` json
{
  "workspace_id": "UUID",
  "gmail_connection_id": "UUID",
  "to": [
    {
      "email": "recipient@example.com",
      "name": "Recipient"
    }
  ],
  "subject": "Project update",
  "body_text": "Please review the project update.",
  "body_html": "<p>Please review the <a href=\"https://example.com/project\">project update</a>.</p>",
  "tracking": {
    "open_pixel": true,
    "link_clicks": true
  }
}
```

The backend must derive authorization from the authenticated session and
verify workspace membership; never trust `workspace_id` supplied in a
request without checking access. Sanitize HTML, validate URLs, enforce
quotas, and prevent header injection.

------------------------------------------------------------------------

## 8. Frontend Product Areas

1.  **Authentication:** sign up, sign in, password recovery, session
    management.
2.  **Workspace setup:** workspace name, members, roles, and
    invitations.
3.  **Integrations:** Gmail connection state, scopes, disconnect, and
    reauthorization.
4.  **Inbox/outbox:** sent messages, recipients, send state, search, and
    filters.
5.  **Compose:** recipient entry, subject, HTML/plain text, preview,
    tracking settings, and confirmation.
6.  **Message details:** send status, estimated opens, clicks, document
    activity, and chronological event log.
7.  **Documents:** upload, private storage, share settings, expiry,
    revoke, and viewer.
8.  **Analytics:** volume, send failures, tracked engagement, and date
    filters.
9.  **Settings:** privacy defaults, retention, workspace roles,
    connected accounts, and account deletion.
10. **Admin/audit:** workspace membership changes, integration changes,
    exports, and security-relevant actions.

Use accessible status text and icons; do not communicate status by color
alone.

------------------------------------------------------------------------

## 9. Security and Privacy Baseline

Treat this as a mandatory release gate, not a later enhancement.

### Authentication and authorization

-   Use Supabase Auth or another explicitly chosen identity system;
    avoid duplicating identity systems unnecessarily.
-   Validate JWT signature, issuer, audience, expiry, and relevant
    claims in FastAPI.
-   Apply tenant membership and role checks on every protected
    operation.
-   Protect OAuth callback with `state`; use PKCE where applicable.
-   Never expose provider refresh tokens, service-role keys, or secrets
    to the browser.

### Application security

-   Enforce HTTPS.
-   Validate and normalize inputs.
-   Sanitize email HTML and defend against stored/reflected XSS.
-   Prevent open redirects and SSRF.
-   Rate-limit send, pixel, redirect, login, and document endpoints.
-   Set file-size and content-type limits; scan uploaded files if the
    risk profile requires it.
-   Use secure cookies or a well-defined bearer-token strategy.
-   Add CSRF protections where cookie-based authentication is used.
-   Apply security headers and restrictive CORS configuration.
-   Redact credentials, message bodies, and recipient PII from logs.

### Data security

-   Encrypt sensitive OAuth credentials using application-layer
    encryption with key management outside the database.
-   Use private storage buckets and short-lived signed URLs.
-   Restrict database access by environment and role.
-   Maintain backups and test restoration.
-   Define data-retention and deletion policies for messages, documents,
    and tracking events.
-   Audit access to sensitive configuration and workspace
    administration.

### Privacy and compliance

-   Disclose tracking behavior to the sender and, where required,
    recipients.
-   Review applicable privacy, electronic communications, and marketing
    laws with qualified counsel.
-   Provide a way to disable tracking and honor relevant opt-out
    requirements.
-   Collect only necessary event metadata; avoid covert fingerprinting.
-   Define retention, export, deletion, and incident-response
    procedures.
-   Review Google's user-data and OAuth requirements before requesting
    production verification.

------------------------------------------------------------------------

## 10. Reliability, Scale, and Observability

### Delivery and event reliability

-   Use a durable queue for sends once production traffic justifies it.
-   Use idempotency keys for create/send operations where appropriate.
-   Make workers safe to retry; avoid sending duplicate emails after
    uncertain provider outcomes.
-   Track states such as `queued`, `sending`, `sent`, `failed`, and
    `needs_review`.
-   Separate message state from engagement events.
-   Implement bounded retries with exponential backoff and jitter for
    transient errors.
-   Do not retry permanent authorization, invalid-recipient, or quota
    errors blindly.
-   Provide a dead-letter or failed-job review mechanism if a queue is
    introduced.

### Monitoring

Measure: - Send success and failure rates. - Gmail API latency and quota
errors. - Queue depth and oldest queued job. - OAuth refresh failures
and revoked connections. - Tracking endpoint latency and error rate. -
Database connection usage and slow queries. - Document authorization
failures. - Cross-tenant authorization test results. - Storage usage and
event ingestion volume.

Alert on sustained failures and unusual spikes. Never log access tokens
or full message content as a debugging shortcut.

### Capacity planning

Estimate monthly email volume, peak sends per minute, average event
count per message, document storage, and retention before choosing
queue/database sizing. Keep PostgreSQL as the transactional source of
truth. Introduce analytics warehousing only when reporting queries
affect operational performance or reporting needs justify the added
system.

------------------------------------------------------------------------

## 11. Testing Strategy

### Unit tests

-   Email rendering and tracking-link generation.
-   Token creation, hashing, expiration, and revocation.
-   OAuth state validation and credential lifecycle.
-   Authorization helpers and role checks.
-   Metric aggregation and event deduplication.
-   HTML sanitization and URL validation.

### Integration tests

-   Supabase schema migrations and RLS policies.
-   Gmail API calls using a test account or controlled mock.
-   OAuth callback success, denial, expiration, and revoked consent.
-   Send failures, quota errors, and retry behavior.
-   Pixel and click endpoints.
-   Document authorization, expiry, and revocation.
-   Event ingestion and analytics aggregation.

### Security tests

-   Cross-tenant data access attempts.
-   Invalid and replayed tokens.
-   Open-redirect attempts.
-   XSS in email bodies and filenames.
-   Unauthorized document access.
-   Secret leakage in API responses and logs.
-   Rate-limit and abuse scenarios.

### End-to-end tests

-   Connect Gmail → compose → send → see message record.
-   Trigger a test tracking pixel → see estimated-open event.
-   Click a test link → see click event and safe redirect.
-   Open document viewer → see view/page events.
-   Revoke document link → confirm future access is denied.
-   Disconnect Gmail → confirm sending is blocked until reconnection.

Do not use real third-party recipients for automated tests without
authorization. Keep development, staging, and production accounts/data
separate.

------------------------------------------------------------------------

## 12. CI/CD and Environments

Maintain three environments where feasible:

-   **Local:** mocked Gmail integration or dedicated test account;
    local/test database.
-   **Staging:** separate Supabase project, OAuth configuration, test
    domain, and isolated credentials.
-   **Production:** restricted secrets, verified OAuth configuration,
    backups, monitoring, and controlled migrations.

Suggested pipeline: 1. Formatting and linting. 2. Static type checks. 3.
Unit tests. 4. Integration tests against a temporary/test database. 5.
Dependency and secret scanning. 6. Build immutable container image. 7.
Deploy to staging. 8. Run smoke tests and migration checks. 9. Require
approval for production. 10. Deploy and verify health metrics; roll back
safely if needed.

Use Alembic or another migration tool for FastAPI-managed schema
changes. Avoid making unreviewed production schema changes through the
dashboard.

------------------------------------------------------------------------

## 13. Phased Execution Roadmap

Timelines below are planning estimates for a small experienced team, not
guarantees. Adjust after validating Gmail OAuth and document-viewer
requirements.

### Phase 0 --- Discovery and decisions

**Deliverables** - Product requirements and user stories. - Defined
target customer and use cases. - Gmail OAuth scope review. -
Tracking/privacy decision record. - Initial threat model and data-flow
diagram. - Acceptance criteria and MVP scope.

**Exit criteria:** team agrees on what is measurable, what is not, and
what is explicitly out of scope.

### Phase 1 --- Foundations

**Deliverables** - Repository structure and development conventions. -
FastAPI service, React frontend, Supabase project. - Authentication and
workspace membership. - Database migrations, RLS policies, and automated
tenant-isolation tests. - CI pipeline and environment configuration.

**Exit criteria:** authenticated user can access only authorized
workspace data.

### Phase 2 --- Gmail connection and send

**Deliverables** - Google OAuth flow and secure refresh-token storage. -
Connection status and disconnect flow. - Email composer and
validation. - Gmail API send integration. - Message/recipient
persistence. - Send status, error handling, quotas, and basic audit
logs.

**Exit criteria:** an authorized test user can connect Gmail and send a
test email without exposing credentials.

### Phase 3 --- Engagement tracking

**Deliverables** - Opaque tracking tokens. - Open-pixel endpoint. -
Secure tracked-link redirect. - Append-only event log and
deduplication. - Message activity timeline. - UI labels explaining
estimated/automated signals.

**Exit criteria:** test events are associated with the correct message
and recipient, without cross-tenant data leakage.

### Phase 4 --- Documents

**Deliverables** - Private document upload. - Recipient-specific
expiring/revocable access. - Controlled viewer. - View, page-change, and
download-request events. - Authorization and retention tests.

**Exit criteria:** authorized recipient can view a document and the
owner can inspect events and revoke access.

### Phase 5 --- Enterprise readiness

**Deliverables** - Workspace roles and invitations. - Audit logs and
exports. - Rate limiting, abuse controls, security headers, and
monitoring. - Backup/restore validation. - Privacy settings, retention,
deletion, and incident procedures. - Load and security tests.

**Exit criteria:** operational, privacy, and security gates are met and
documented.

### Phase 6 --- Controlled launch

**Deliverables** - Small pilot group and documented feedback process. -
Error and quota dashboards. - Support process and incident owner. -
Usage limits and acceptable-use policy. - Prioritized backlog based on
real usage.

**Exit criteria:** critical issues are resolved, users understand
tracking limitations, and support/operations can maintain the service.

------------------------------------------------------------------------

## 14. Repository Structure

``` text
email-engagement-saas/
├── apps/
│   └── web/                     # React + TypeScript
├── services/
│   └── api/
│       ├── app/
│       │   ├── api/v1/
│       │   ├── core/            # config, security, logging
│       │   ├── integrations/    # Gmail OAuth/API
│       │   ├── models/
│       │   ├── repositories/
│       │   ├── schemas/
│       │   ├── services/
│       │   ├── workers/
│       │   └── main.py
│       ├── tests/
│       ├── alembic/
│       └── pyproject.toml
├── supabase/
│   ├── migrations/
│   └── tests/
├── infra/
│   ├── deployment/
│   └── monitoring/
├── docs/
│   ├── architecture.md
│   ├── threat-model.md
│   ├── api-contracts.md
│   ├── data-retention.md
│   └── runbooks/
├── .github/workflows/
├── .env.example
└── README.md
```

Do not commit `.env` files, credentials, OAuth tokens, or production
data. `.env.example` should contain placeholder names only.

------------------------------------------------------------------------

## 15. Definition of Done

A feature is not complete merely because it works in a developer's
browser.

-   [ ] Acceptance criteria are documented and met.
-   [ ] API input/output schemas are validated and documented.
-   [ ] Authentication, authorization, and tenant boundaries are tested.
-   [ ] Database changes use reviewed migrations.
-   [ ] Error states and retries are handled.
-   [ ] Logs contain request IDs but no secrets or unnecessary PII.
-   [ ] Relevant metrics and alerts exist.
-   [ ] Accessibility and responsive behavior are checked.
-   [ ] Unit/integration/end-to-end tests pass.
-   [ ] Security and privacy implications are reviewed.
-   [ ] User-facing tracking language is accurate.
-   [ ] Rollback and operational steps are documented.

------------------------------------------------------------------------

## 16. Immediate Next Actions

Start with these decisions and tasks, in order:

1.  Confirm whether this is an internal tool, a single-user product, or
    a multi-tenant commercial SaaS.
2.  Decide whether Gmail accounts are personal Gmail or Google Workspace
    accounts and review OAuth requirements for the intended audience.
3.  Choose the minimum Gmail scopes and document why each is required.
4.  Create separate development and staging Supabase projects.
5.  Define workspace membership and RLS policies before building message
    features.
6.  Implement Gmail OAuth connection and a basic send-only proof of
    concept.
7.  Add message/recipient tables and a durable event model.
8.  Implement link tracking before open tracking, because click events
    generally provide a more useful engagement signal.
9.  Add a secure document viewer only after authorization and token
    revocation are working.
10. Run a small, consent-aware pilot and use observed failure modes to
    prioritize production hardening.

## 17. Open Decisions Log

Resolve these before locking the design:

  -----------------------------------------------------------------------
  Decision                Recommended starting    Why it matters
                          point                   
  ----------------------- ----------------------- -----------------------
  Product audience        Small B2B teams         Defines tenancy, roles,
                                                  and support needs

  Gmail account type      Google Workspace where  Enterprise
                          possible                administration and
                                                  OAuth deployment can
                                                  differ from consumer
                                                  accounts

  Email volume            Establish expected      Determines quota
                          monthly and peak volume handling and queue
                                                  design

  Attachments             Defer unless essential  Adds file scanning,
                                                  size, and delivery
                                                  complexity

  Document viewer         Private hosted viewer   Enables access control
                                                  and first-party view
                                                  events

  Tracking defaults       Transparent,            Supports privacy and
                          configurable, and off   user trust
                          where required          

  Event retention         Define by event type    Controls privacy and
                          and customer            storage cost
                          requirements            

  Queue                   Add durable queue       Supports retries and
                          before high-volume      operational resilience
                          production              

  Analytics               PostgreSQL initially    Keeps the MVP simpler;
                                                  add warehouse later if
                                                  needed
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 18. Reference Documentation to Verify During Implementation

Use official documentation and re-check it during implementation because
scopes, quotas, and policies can change:

-   Gmail API: https://developers.google.com/workspace/gmail/api/guides
-   Gmail API sending:
    https://developers.google.com/workspace/gmail/api/guides/sending
-   Google OAuth 2.0:
    https://developers.google.com/identity/protocols/oauth2
-   Google API Services User Data Policy:
    https://developers.google.com/terms/api-services-user-data-policy
-   Supabase Auth: https://supabase.com/docs/guides/auth
-   Supabase Row Level Security:
    https://supabase.com/docs/guides/database/postgres/row-level-security
-   Supabase Storage: https://supabase.com/docs/guides/storage
-   FastAPI: https://fastapi.tiangolo.com/

------------------------------------------------------------------------

## Final Recommendation

Build in this order: **tenant-safe foundation → Gmail OAuth and send →
event model → click tracking → estimated open tracking → controlled
document viewer → enterprise controls and pilot**.

The highest-risk areas are not the tracking pixel itself. They are Gmail
OAuth and policy compliance, reliable sending under provider quotas,
secure multi-tenant authorization, correct event semantics, and
protecting recipient/document data. Design those early to avoid
expensive rewrites.
