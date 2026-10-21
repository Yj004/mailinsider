import os
import tempfile

from cryptography.fernet import Fernet

_fd, _path = tempfile.mkstemp(prefix="mailinsider-test-", suffix=".db")
os.close(_fd)
os.environ["TESTING"] = "1"
os.environ["APP_ENV"] = "development"
os.environ["DATABASE_URL"] = f"sqlite:///{_path}"
os.environ["JWT_SECRET"] = "test-secret-value-please"
os.environ["TOKEN_ENCRYPTION_KEY"] = Fernet.generate_key().decode()
os.environ["PUBLIC_API_URL"] = "http://localhost:8000"
os.environ["PUBLIC_OPEN_PIXEL_URL"] = ""
os.environ["PUBLIC_APP_URL"] = "http://localhost:5173"
os.environ["GOOGLE_CLIENT_ID"] = ""
os.environ["GOOGLE_CLIENT_SECRET"] = ""

import pytest
from fastapi.testclient import TestClient

from app.core.database import Base, engine
from app.core.limiter import limiter
from app.main import app


@pytest.fixture()
def client():
    limiter._hits.clear()
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with TestClient(app) as test_client:
        yield test_client


def register(client, email="ava@northwind.example", workspace="Northwind", password="correct-horse"):
    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": password,
            "display_name": "Ava Shah",
            "workspace_name": workspace,
            "open_tracking_default": True,
            "link_tracking_default": True,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def headers(session):
    return {
        "Authorization": f"Bearer {session['access_token']}",
        "X-Workspace-Id": session["memberships"][0]["workspace_id"],
    }


def test_register_login_and_workspace_isolation(client):
    ava = register(client)
    leo = register(client, email="leo@brightpath.example", workspace="Brightpath")
    demo = client.post("/api/v1/integrations/gmail/demo", headers=headers(ava))
    assert demo.status_code == 200, demo.text
    sent = client.post(
        "/api/v1/messages",
        headers=headers(ava),
        json={
            "to": [{"email": "aisha@northwind.example", "name": "Aisha"}],
            "subject": "Security questionnaire",
            "body_text": "Please review https://example.com/security",
            "send": True,
        },
    )
    assert sent.status_code == 200, sent.text
    body = sent.json()
    assert body["send_status"] == "sent"
    assert body["demo"] is True
    assert body["recipients"][0]["gmail_message_id"]
    assert "aisha@northwind.example" not in body["recipients"][0]["gmail_message_id"]

    leaked = client.get(f"/api/v1/messages/{body['id']}", headers=headers(leo))
    assert leaked.status_code == 404
    other_list = client.get("/api/v1/messages", headers={**headers(ava), "X-Workspace-Id": leo["memberships"][0]["workspace_id"]})
    assert other_list.status_code == 403


def test_viewer_cannot_send_and_html_is_sanitized(client):
    owner = register(client)
    client.post(
        "/api/v1/workspaces/current/members",
        headers=headers(owner),
        json={"email": "view@northwind.example", "role": "viewer"},
    )
    viewer = register(client, email="view@northwind.example", workspace="Unused")
    # The second workspace is their own; switch to the invited one.
    invited = next(item for item in viewer["memberships"] if item["name"] == "Northwind")
    viewer_headers = {
        "Authorization": f"Bearer {viewer['access_token']}",
        "X-Workspace-Id": invited["workspace_id"],
    }
    denied = client.post(
        "/api/v1/messages",
        headers=viewer_headers,
        json={"to": [{"email": "a@b.co"}], "subject": "Hi", "body_text": "Hello", "send": False},
    )
    assert denied.status_code == 403

    client.post("/api/v1/integrations/gmail/demo", headers=headers(owner))
    sent = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "Notes",
            "body_html": '<p>Hello</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><a href="https://example.com/ok">Docs</a>',
            "body_text": "Hello",
            "send": True,
        },
    )
    assert sent.status_code == 200, sent.text
    recipient_id = sent.json()["recipients"][0]["id"]
    preview = client.get(
        f"/api/v1/messages/{sent.json()['id']}/recipients/{recipient_id}/preview",
        headers=headers(owner),
    )
    html = preview.json()["html"]
    assert "<script" not in html.lower()
    assert "javascript:" not in html.lower()
    assert "https://example.com/ok" not in html
    assert "/t/click/" in html
    # Preview replaces the live open pixel so opening the message in-app cannot
    # record a false open; the real GIF URL remains in stored rendered_html.
    assert "/t/open/" not in html
    assert "data:image/gif;base64," in html
    assert "aisha@northwind.example" not in html


def test_pixel_click_redirect_and_revoke(client):
    owner = register(client)
    client.post("/api/v1/integrations/gmail/demo", headers=headers(owner))
    sent = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "Project update",
            "body_text": "The update is at https://example.com/project.",
            "send": True,
        },
    )
    assert sent.status_code == 200, sent.text
    message_id = sent.json()["id"]
    preview = client.get(
        f"/api/v1/messages/{message_id}/recipients/{sent.json()['recipients'][0]['id']}/preview",
        headers=headers(owner),
    ).json()["html"]
    assert "Yashjeet" in preview
    assert "Portfolio" in preview
    assert "/t/unsubscribe/" not in preview
    assert "/t/open/" not in preview  # preview strips live pixel
    assert "data:image/gif;base64," in preview
    pixel = _raw_open_token_for_message(message_id)
    click = preview.split("/t/click/")[1].split('"')[0]
    opened = client.get(f"/t/open/{pixel}.gif")
    assert opened.status_code == 200
    assert opened.headers["content-type"].startswith("image/gif")
    ignored = client.get("/t/click/not-a-real-token?url=https://evil.example", follow_redirects=False)
    assert ignored.status_code == 404
    redirected = client.get(f"/t/click/{click}?url=https://evil.example", follow_redirects=False)
    assert redirected.status_code == 302
    assert redirected.headers["location"] == "https://example.com/project"
    events = client.get(f"/api/v1/messages/{message_id}/events", headers=headers(owner)).json()["events"]
    types = [event["event_type"] for event in events]
    assert "open_pixel_requested" in types
    assert "tracked_link_requested" in types
    client.delete(f"/api/v1/messages/{message_id}/tracking", headers=headers(owner))
    revoked = client.get(f"/t/click/{click}", follow_redirects=False)
    assert revoked.status_code == 404


def _raw_open_token_for_message(message_id: str) -> str:
    """Recover the plaintext open token from rendered HTML stored on the recipient."""
    from app.core.database import SessionLocal
    from app.models import MessageRecipient

    db = SessionLocal()
    try:
        recipient = (
            db.query(MessageRecipient)
            .filter(MessageRecipient.message_id == message_id, MessageRecipient.recipient_type == "to")
            .first()
        )
        assert recipient and recipient.rendered_html
        html = recipient.rendered_html
        marker = "/t/open/"
        if marker not in html and "open-pixel/" in html:
            marker = "open-pixel/"
        assert marker in html
        return html.split(marker)[1].split(".gif")[0]
    finally:
        db.close()


def test_open_pixel_is_idempotent_per_gif_token(client):
    owner = register(client)
    client.post("/api/v1/integrations/gmail/demo", headers=headers(owner))
    sent = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "Burst",
            "body_text": "Hello",
            "send": True,
        },
    )
    pixel = _raw_open_token_for_message(sent.json()["id"])
    for _ in range(3):
        assert client.get(f"/t/open/{pixel}.gif").status_code == 200
    overview = client.get("/api/v1/analytics/overview", headers=headers(owner)).json()
    assert overview["unique_opens_estimated"] == 1
    detail = client.get(f"/api/v1/messages/{sent.json()['id']}", headers=headers(owner)).json()
    assert detail["engagement"]["estimated_opens"] == 1
    events = client.get(f"/api/v1/messages/{sent.json()['id']}/events", headers=headers(owner)).json()["events"]
    opens = [event for event in events if event["event_type"] == "open_pixel_requested"]
    assert len(opens) == 1


def test_pixel_load_counts_as_open_immediately(client):
    """Any GIF GET counts as Opened — no grace window."""
    owner = register(client)
    client.post("/api/v1/integrations/gmail/demo", headers=headers(owner))
    sent = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "Immediate open",
            "body_text": "Hello",
            "send": True,
        },
    )
    message_id = sent.json()["id"]
    pixel = _raw_open_token_for_message(message_id)
    assert (
        client.get(
            f"/t/open/{pixel}.gif",
            headers={"User-Agent": "Mozilla/5.0 (via ggpht.com GoogleImageProxy)"},
        ).status_code
        == 200
    )
    detail = client.get(f"/api/v1/messages/{message_id}", headers=headers(owner)).json()
    assert detail["engagement"]["estimated_opens"] == 1
    assert detail["recipients"][0]["open_count"] == 1
    assert detail["recipients"][0]["signal"] == "open_detected"


def test_second_send_revokes_prior_open_gif(client):
    owner = register(client)
    client.post("/api/v1/integrations/gmail/demo", headers=headers(owner))
    first = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "First",
            "body_text": "Hello one",
            "send": True,
        },
    )
    assert first.status_code == 200, first.text
    first_pixel = _raw_open_token_for_message(first.json()["id"])
    second = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "Second",
            "body_text": "Hello two",
            "send": True,
        },
    )
    assert second.status_code == 200, second.text
    assert client.get(f"/t/open/{first_pixel}.gif").status_code == 200
    first_detail = client.get(f"/api/v1/messages/{first.json()['id']}", headers=headers(owner)).json()
    assert first_detail["engagement"]["estimated_opens"] == 0
    second_pixel = _raw_open_token_for_message(second.json()["id"])
    assert client.get(f"/t/open/{second_pixel}.gif").status_code == 200
    second_detail = client.get(f"/api/v1/messages/{second.json()['id']}", headers=headers(owner)).json()
    assert second_detail["engagement"]["estimated_opens"] == 1


def test_link_click_infers_estimated_open_without_pixel(client):
    owner = register(client)
    client.post("/api/v1/integrations/gmail/demo", headers=headers(owner))
    sent = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "Click implies open",
            "body_text": "See https://example.com/project",
            "send": True,
        },
    )
    assert sent.status_code == 200, sent.text
    message_id = sent.json()["id"]
    preview = client.get(
        f"/api/v1/messages/{message_id}/recipients/{sent.json()['recipients'][0]['id']}/preview",
        headers=headers(owner),
    ).json()["html"]
    click = preview.split("/t/click/")[1].split('"')[0]
    redirected = client.get(f"/t/click/{click}", follow_redirects=False)
    assert redirected.status_code == 302
    detail = client.get(f"/api/v1/messages/{message_id}", headers=headers(owner)).json()
    assert detail["engagement"]["estimated_opens"] == 1
    assert detail["engagement"]["link_clicks"] == 1
    events = client.get(f"/api/v1/messages/{message_id}/events", headers=headers(owner)).json()["events"]
    opens = [event for event in events if event["event_type"] == "open_pixel_requested"]
    assert len(opens) == 1
    assert opens[0]["source"] == "inferred"
    assert opens[0]["metadata"]["inferred_from"] == "tracked_link_requested"


def test_document_view_infers_estimated_open_without_pixel(client):
    owner = register(client)
    client.post("/api/v1/integrations/gmail/demo", headers=headers(owner))
    uploaded = client.post(
        "/api/v1/documents",
        headers=headers(owner),
        files={"file": ("brief.pdf", b"%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "application/pdf")},
    )
    assert uploaded.status_code == 200, uploaded.text
    sent = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "Doc implies open",
            "body_text": "Please review the brief.",
            "send": True,
            "document_id": uploaded.json()["id"],
            "tracking": {"open_pixel": True, "link_clicks": False},
        },
    )
    assert sent.status_code == 200, sent.text
    message_id = sent.json()["id"]
    preview = client.get(
        f"/api/v1/messages/{message_id}/recipients/{sent.json()['recipients'][0]['id']}/preview",
        headers=headers(owner),
    ).json()["html"]
    assert "/view/" in preview
    token = preview.split("/view/")[1].split('"')[0].split("'")[0].rstrip("/")
    viewed = client.post(
        f"/api/v1/public/documents/{token}/events",
        json={"type": "document_view_started"},
    )
    assert viewed.status_code == 200, viewed.text
    detail = client.get(f"/api/v1/messages/{message_id}", headers=headers(owner)).json()
    assert detail["engagement"]["estimated_opens"] == 1
    assert detail["engagement"]["document_views"] == 1
    events = client.get(f"/api/v1/messages/{message_id}/events", headers=headers(owner)).json()["events"]
    opens = [event for event in events if event["event_type"] == "open_pixel_requested"]
    assert len(opens) == 1
    assert opens[0]["source"] == "inferred"
    assert opens[0]["metadata"]["inferred_from"] == "document_view_started"


def test_document_revoke_blocks_access(client):
    owner = register(client)
    upload = client.post(
        "/api/v1/documents",
        headers=headers(owner),
        files={"file": ("notes.txt", b"Page one of the notes.", "text/plain")},
    )
    assert upload.status_code == 200, upload.text
    document_id = upload.json()["id"]
    link = client.post(f"/api/v1/documents/{document_id}/links", headers=headers(owner), json={"expires_in_days": 7})
    assert link.status_code == 200, link.text
    token = link.json()["url"].rstrip("/").split("/")[-1]
    meta = client.get(f"/api/v1/public/documents/{token}")
    assert meta.status_code == 200
    assert "opened" in meta.json()["disclosure"]
    downloaded = client.get(f"/api/v1/public/documents/{token}/file")
    assert downloaded.status_code == 200
    assert downloaded.content.startswith(b"Page one")
    viewed = client.post(
        f"/api/v1/public/documents/{token}/events",
        json={"type": "document_view_started"},
    )
    assert viewed.status_code == 200
    client.post(f"/api/v1/documents/{document_id}/revoke", headers=headers(owner), json={})
    blocked = client.get(f"/api/v1/public/documents/{token}/file")
    assert blocked.status_code == 404
    events = client.get(f"/api/v1/documents/{document_id}/events", headers=headers(owner)).json()["events"]
    assert any(event["event_type"] == "document_view_started" for event in events)


def test_export_omits_secrets_and_last_owner_cannot_leave(client):
    owner = register(client, password="correct-horse")
    demo = client.post("/api/v1/integrations/gmail/demo", headers=headers(owner))
    assert "encrypted" not in demo.text
    exported = client.get("/api/v1/workspaces/current/export", headers=headers(owner))
    assert exported.status_code == 200
    assert "refresh" not in exported.text.lower()
    remove = client.delete(f"/api/v1/workspaces/current/members/{owner['user']['id']}", headers=headers(owner))
    assert remove.status_code == 400


def test_subject_newline_rejected(client):
    owner = register(client)
    response = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={"to": [{"email": "a@b.co"}], "subject": "Hello\nBcc: evil@example.com", "body_text": "Hi", "send": False},
    )
    assert response.status_code == 422


def test_sheet_connection_stays_in_its_workspace(client):
    from app.services.sheets import private_spreadsheet_body

    ava = register(client)
    leo = register(client, email="leo@brightpath.example", workspace="Brightpath")
    connected = client.post("/api/v1/integrations/sheets/demo", headers=headers(ava))
    assert connected.status_code == 200, connected.text
    assert "encrypted" not in connected.text
    assert "docs.google.com" not in connected.json()["spreadsheet_url"]
    mine = client.get("/api/v1/integrations/sheets/connections", headers=headers(ava))
    assert mine.json()["connections"][0]["spreadsheet_id"].startswith("local-")
    theirs = client.get("/api/v1/integrations/sheets/connections", headers=headers(leo))
    assert theirs.json()["connections"] == []
    stolen = client.delete(
        f"/api/v1/integrations/sheets/connections/{connected.json()['id']}",
        headers=headers(leo),
    )
    assert stolen.status_code == 404
    api_connect = client.post("/api/v1/integrations/sheets/connect", headers=headers(ava))
    assert api_connect.status_code == 400
    assert api_connect.json()["error"]["code"] == "oauth_not_configured"
    created = private_spreadsheet_body("MailInsider — Northwind")
    encoded = str(created)
    assert "anyone" not in encoded
    assert "permission" not in encoded
    assert created["sheets"][0]["properties"]["title"] == "Sends"


def test_send_attaches_pdf_and_includes_sheet_link(client):
    from app.services.gmail import build_mime

    owner = register(client)
    client.post("/api/v1/integrations/gmail/demo", headers=headers(owner))
    missing = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "Need a sheet",
            "body_text": "Hello",
            "send": True,
            "include_sheet_link": True,
        },
    )
    assert missing.status_code == 400
    client.post("/api/v1/integrations/sheets/demo", headers=headers(owner))
    notes = client.post(
        "/api/v1/documents",
        headers=headers(owner),
        files={"file": ("notes.txt", b"Just notes.", "text/plain")},
    )
    refused = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "Notes",
            "body_text": "See the notes.",
            "send": True,
            "document_id": notes.json()["id"],
            "attach_pdf": True,
        },
    )
    assert refused.status_code == 400
    pdf = b"%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
    uploaded = client.post(
        "/api/v1/documents",
        headers=headers(owner),
        files={"file": ("brief.pdf", pdf, "application/pdf")},
    )
    assert uploaded.status_code == 200, uploaded.text
    sent = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example", "name": "Aisha"}],
            "subject": "Brief and sheet",
            "body_text": "The brief is attached.",
            "send": True,
            "document_id": uploaded.json()["id"],
            "attach_pdf": True,
            "include_sheet_link": True,
        },
    )
    assert sent.status_code == 200, sent.text
    body = sent.json()
    assert body["attach_pdf"] is True
    assert body["include_sheet_link"] is True
    preview = client.get(
        f"/api/v1/messages/{body['id']}/recipients/{body['recipients'][0]['id']}/preview",
        headers=headers(owner),
    )
    html = preview.json()["html"]
    assert "View document" in html
    assert "docs.google.com" not in html
    assert "workspace sheet inside MailInsider" in html
    events = client.get(f"/api/v1/messages/{body['id']}/events", headers=headers(owner)).json()["events"]
    assert any(event["event_type"] == "sheet_row_appended" for event in events)
    logged = client.get("/api/v1/integrations/sheets/connections", headers=headers(owner)).json()
    assert logged["recent_rows"]
    mime = build_mime(
        from_name="Ava",
        from_email="ava@northwind.example",
        to_emails=["aisha@northwind.example"],
        cc_emails=[],
        bcc_emails=[],
        subject="Brief",
        text="Attached",
        html="<p>Attached</p>",
        pdf_filename="brief.pdf",
        pdf_bytes=pdf,
    )
    assert b"application/pdf" in mime
    assert b"brief.pdf" in mime


def test_contact_crm_and_follow_up_queue(client):
    owner = register(client)
    created = client.post(
        "/api/v1/contacts",
        headers=headers(owner),
        json={
            "email": "recruiter@acme.example",
            "display_name": "Alex Recruiter",
            "company": "Acme",
            "target_role": "Backend Engineer",
            "pipeline_status": "to_contact",
            "next_follow_up_at": "2020-01-01T10:00:00+00:00",
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["company"] == "Acme"
    assert body["follow_up_overdue"] is True
    queued = client.get("/api/v1/contacts/follow-ups", headers=headers(owner)).json()
    assert queued["due_count"] >= 1
    assert any(item["email"] == "recruiter@acme.example" for item in queued["due"])
    patched = client.patch(
        f"/api/v1/contacts/{body['id']}",
        headers=headers(owner),
        json={"pipeline_status": "interview", "clear_follow_up": True},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["pipeline_status"] == "interview"
    assert patched.json()["next_follow_up_at"] is None
    other = register(client, email="leo@brightpath.example", workspace="Brightpath")
    hidden = client.get(f"/api/v1/contacts/{body['id']}", headers=headers(other))
    assert hidden.status_code == 404


def test_dashboard_analytics_stay_inside_the_workspace(client):
    owner = register(client)
    other = register(client, email="leo@brightpath.example", workspace="Brightpath")
    client.post("/api/v1/integrations/gmail/demo", headers=headers(owner))
    sent = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example", "name": "Aisha"}],
            "subject": "Quarterly note",
            "body_text": "Hello from the workspace",
            "send": True,
        },
    )
    assert sent.status_code == 200, sent.text
    performance = client.get("/api/v1/analytics/performance?grain=daily", headers=headers(owner))
    assert performance.status_code == 200, performance.text
    body = performance.json()
    assert body["current"]["emails_sent"] >= 1
    assert body["current"]["open_rate"] is None or body["current"]["emails_sent"] > 0
    assert any(point["emails_sent"] >= 1 for point in body["series"])
    assert body["definitions"]["estimated_opens"]
    listed = client.get("/api/v1/messages", headers=headers(owner)).json()
    assert listed["items"][0]["engagement"]["estimated_opens"] == 0
    activity = client.get("/api/v1/analytics/activity", headers=headers(owner)).json()
    assert any(item["kind"] == "email_sent" and item["actor"] == "Aisha" for item in activity["items"])
    hidden = client.get("/api/v1/analytics/performance", headers=headers(other)).json()
    assert hidden["current"]["emails_sent"] == 0
    assert client.get("/api/v1/analytics/activity", headers=headers(other)).json()["items"] == []
    rejected = client.get("/api/v1/analytics/performance?grain=hourly", headers=headers(owner))
    assert rejected.status_code == 400


def test_templates_sheet_import_campaign_and_unsubscribe(client):
    owner = register(client)
    auth = headers(owner)
    client.post("/api/v1/integrations/gmail/demo", headers=auth)
    client.post("/api/v1/integrations/sheets/demo", headers=auth)

    template = client.post(
        "/api/v1/templates",
        headers=auth,
        json={"name": "Intro", "subject": "Hi {{first_name}}", "body_text": "Hello {{first_name}} at {{company}}"},
    )
    assert template.status_code == 200, template.text
    assert template.json()["name"] == "Intro"

    preview = client.get("/api/v1/integrations/sheets/preview", headers=auth)
    assert preview.status_code == 200, preview.text
    mapping = preview.json()["suggested_mapping"]
    assert mapping.get("email")

    imported = client.post(
        "/api/v1/integrations/sheets/import",
        headers=auth,
        json={"mapping": mapping, "dry_run": False},
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["imported_count"] >= 2
    assert imported.json()["error_count"] >= 1

    contacts = client.get("/api/v1/contacts?limit=50", headers=auth)
    assert contacts.status_code == 200
    contact_ids = [item["id"] for item in contacts.json()["contacts"]]
    assert contact_ids

    campaign = client.post(
        "/api/v1/campaigns",
        headers=auth,
        json={
            "name": "Sheet wave",
            "subject": "Hi {{first_name}}",
            "body_text": "Hello {{first_name}} — see https://example.com/docs",
            "template_id": template.json()["id"],
        },
    )
    assert campaign.status_code == 200, campaign.text
    campaign_id = campaign.json()["id"]

    attached = client.post(
        f"/api/v1/campaigns/{campaign_id}/recipients",
        headers=auth,
        json={"contact_ids": contact_ids[:2], "recipients": []},
    )
    assert attached.status_code == 200, attached.text
    assert attached.json()["counts"]["pending"] >= 1

    launched = client.post(
        f"/api/v1/campaigns/{campaign_id}/launch",
        headers=auth,
        json={"confirm_count": attached.json()["counts"]["pending"]},
    )
    assert launched.status_code == 200, launched.text
    assert launched.json()["message_id"]
    message_id = launched.json()["message_id"]

    detail = client.get(f"/api/v1/messages/{message_id}", headers=auth)
    assert detail.status_code == 200, detail.text
    assert detail.json()["send_status"] in {"sent", "queued", "sending", "partial"}
    recipient_id = detail.json()["recipients"][0]["id"]
    preview_html = client.get(
        f"/api/v1/messages/{message_id}/recipients/{recipient_id}/preview",
        headers=auth,
    )
    assert preview_html.status_code == 200, preview_html.text
    html = preview_html.json()["html"]
    assert "/t/unsubscribe/" in html
    assert "{{first_name}}" not in html

    token = html.split("/t/unsubscribe/")[1].split('"')[0].split("<")[0]
    unsub = client.get(f"/t/unsubscribe/{token}")
    assert unsub.status_code == 200
    assert "unsubscribed" in unsub.text.lower()

    suppressions = client.get("/api/v1/suppressions", headers=auth)
    assert suppressions.status_code == 200
    assert any(item["email"] for item in suppressions.json()["suppressions"])

    # Suppressed address cannot be the only recipient on a new send.
    blocked = client.post(
        "/api/v1/messages",
        headers=auth,
        json={
            "to": [{"email": suppressions.json()["suppressions"][0]["email"]}],
            "subject": "Should block",
            "body_text": "Nope",
            "send": True,
        },
    )
    assert blocked.status_code == 400
    assert blocked.json()["error"]["code"] == "all_suppressed"


def test_waitlist_signup_and_list(client):
    created = client.post(
        "/api/v1/public/waitlist",
        json={
            "name": "Priya Shah",
            "company_name": "Northwind",
            "email": "priya@northwind.example",
            "monthly_sends": 1000,
            "willing_to_pay": "$29 / month",
        },
    )
    assert created.status_code == 200, created.text
    again = client.post(
        "/api/v1/public/waitlist",
        json={
            "name": "Priya S.",
            "company_name": "Northwind",
            "email": "priya@northwind.example",
            "monthly_sends": 2500,
            "willing_to_pay": "$49 / month",
        },
    )
    assert again.status_code == 200, again.text
    bot = client.post(
        "/api/v1/public/waitlist",
        json={
            "name": "Bot",
            "email": "bot@spam.example",
            "monthly_sends": 10,
            "willing_to_pay": "$1",
            "website": "http://spam.example",
        },
    )
    assert bot.status_code == 200
    owner = register(client)
    listed = client.get("/api/v1/waitlist", headers=headers(owner))
    assert listed.status_code == 200, listed.text
    emails = [row["email"] for row in listed.json()["signups"]]
    assert "priya@northwind.example" in emails
    assert "bot@spam.example" not in emails
    priya = next(row for row in listed.json()["signups"] if row["email"] == "priya@northwind.example")
    assert priya["monthly_sends"] == 2500
    assert priya["willing_to_pay"] == "$49 / month"


def test_preview_lock_blocks_non_owner(client, monkeypatch):
    from app.core.config import get_settings

    owner = register(client, email="work.yashjeet@gmail.com", workspace="Owner")
    outsider = register(client, email="leo@brightpath.example", workspace="Brightpath")
    monkeypatch.setenv("TESTING", "0")
    monkeypatch.setenv("ALLOW_PUBLIC_SIGNUP", "false")
    monkeypatch.setenv("OWNER_EMAIL", "work.yashjeet@gmail.com")
    get_settings.cache_clear()
    try:
        denied = client.post(
            "/api/v1/auth/login",
            json={"email": "leo@brightpath.example", "password": "correct-horse"},
        )
        assert denied.status_code == 403
        assert denied.json()["error"]["code"] == "waitlist_only"
        allowed = client.post(
            "/api/v1/auth/login",
            json={"email": "work.yashjeet@gmail.com", "password": "correct-horse"},
        )
        assert allowed.status_code == 200, allowed.text
        blocked_me = client.get("/api/v1/auth/me", headers=headers(outsider))
        assert blocked_me.status_code == 403
        blocked_ws = client.post(
            "/api/v1/workspaces",
            headers=headers(outsider),
            json={"name": "Should fail", "open_tracking_default": True, "link_tracking_default": True},
        )
        assert blocked_ws.status_code == 403
        ok_ws = client.post(
            "/api/v1/workspaces",
            headers=headers(owner),
            json={"name": "Second workspace", "open_tracking_default": True, "link_tracking_default": True},
        )
        assert ok_ws.status_code == 200, ok_ws.text
        blocked_reg = client.post(
            "/api/v1/auth/register",
            json={
                "email": "new@example.com",
                "password": "correct-horse",
                "display_name": "New",
                "workspace_name": "Nope",
                "open_tracking_default": True,
                "link_tracking_default": True,
            },
        )
        assert blocked_reg.status_code == 403
    finally:
        monkeypatch.setenv("TESTING", "1")
        get_settings.cache_clear()


def test_hide_message_from_inbox(client):
    owner = register(client)
    created = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "Hide me",
            "body_text": "Hello",
            "send": False,
        },
    )
    assert created.status_code == 200, created.text
    message_id = created.json()["id"]
    inbox = client.get("/api/v1/messages", headers=headers(owner))
    assert any(item["id"] == message_id for item in inbox.json()["items"])
    hidden = client.post(
        f"/api/v1/messages/{message_id}/hide",
        headers=headers(owner),
        json={"hidden": True},
    )
    assert hidden.status_code == 200, hidden.text
    assert hidden.json()["hidden"] is True
    after = client.get("/api/v1/messages", headers=headers(owner))
    assert all(item["id"] != message_id for item in after.json()["items"])
    parked = client.get("/api/v1/messages?hidden=true", headers=headers(owner))
    assert any(item["id"] == message_id for item in parked.json()["items"])
    shown = client.post(
        f"/api/v1/messages/{message_id}/hide",
        headers=headers(owner),
        json={"hidden": False},
    )
    assert shown.status_code == 200
    assert shown.json()["hidden"] is False
    restored = client.get("/api/v1/messages", headers=headers(owner))
    assert any(item["id"] == message_id for item in restored.json()["items"])


def test_compose_can_skip_or_override_signature(client):
    owner = register(client)
    client.post("/api/v1/integrations/gmail/demo", headers=headers(owner))
    skipped = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "No signature",
            "body_text": "Hello without a footer.",
            "send": True,
            "include_signature": False,
        },
    )
    assert skipped.status_code == 200, skipped.text
    skipped_html = client.get(
        f"/api/v1/messages/{skipped.json()['id']}/recipients/{skipped.json()['recipients'][0]['id']}/preview",
        headers=headers(owner),
    ).json()["html"]
    assert "yashjeet.space" not in skipped_html.lower()
    assert "github.com/yj004" not in skipped_html.lower()
    custom = client.post(
        "/api/v1/messages",
        headers=headers(owner),
        json={
            "to": [{"email": "aisha@northwind.example"}],
            "subject": "Custom signature",
            "body_text": "Hello with a custom footer.",
            "send": True,
            "include_signature": True,
            "signature_text": "Ada Lovelace\nLabs: https://example.com/ada",
        },
    )
    assert custom.status_code == 200, custom.text
    custom_html = client.get(
        f"/api/v1/messages/{custom.json()['id']}/recipients/{custom.json()['recipients'][0]['id']}/preview",
        headers=headers(owner),
    ).json()["html"]
    assert "Ada Lovelace" in custom_html
    assert "example.com/ada" in custom_html
    assert "yashjeet.space" not in custom_html.lower()
