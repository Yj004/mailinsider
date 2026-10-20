import logging
from urllib.parse import quote, urlparse

import httpx

from app.core.security import decrypt_secret
from app.errors import AppError
from app.models import SheetConnection, utcnow
from app.services.gmail import NeedsReauth, refresh_access_token
from app.services.signals import iso

log = logging.getLogger("mailinsider.sheets")


def private_spreadsheet_body(title: str) -> dict:
    safe = " ".join((title or "MailInsider sends").split())[:200] or "MailInsider sends"
    headers = ["Sent at", "From", "To", "Subject", "PDF", "Status"]
    return {
        "properties": {"title": safe},
        "sheets": [
            {
                "properties": {"title": "Sends"},
                "data": [
                    {
                        "startRow": 0,
                        "startColumn": 0,
                        "rowData": [
                            {
                                "values": [{"userEnteredValue": {"stringValue": header}} for header in headers],
                            }
                        ],
                    }
                ],
            }
        ],
    }


def create_private_spreadsheet(access_token: str, title: str) -> tuple[str, str, str, str]:
    body = private_spreadsheet_body(title)
    try:
        response = httpx.post(
            "https://sheets.googleapis.com/v4/spreadsheets",
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            json=body,
            timeout=20,
        )
    except httpx.HTTPError as exc:
        raise AppError(502, "sheet_create_failed", "Google Sheets did not create a private sheet.") from exc
    if response.status_code >= 400:
        raise AppError(400, "sheet_create_failed", "Google Sheets did not create a private sheet. Nothing was stored.")
    created = response.json() or {}
    spreadsheet_id = str(created.get("spreadsheetId") or "")
    if not spreadsheet_id:
        raise AppError(400, "sheet_create_failed", "Google Sheets did not return a sheet. Nothing was stored.")
    url = created.get("spreadsheetUrl") or f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}"
    return spreadsheet_id, str(url), body["properties"]["title"], "Sends"


def parse_spreadsheet_url(value: str) -> tuple[str, str]:
    raw = (value or "").strip()
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    parts = [part for part in parsed.path.split("/") if part]
    if parsed.scheme != "https" or host != "docs.google.com" or parts[:2] != ["spreadsheets", "d"] or len(parts) < 3:
        raise AppError(
            400,
            "invalid_sheet",
            "Paste a Google Sheets link, like https://docs.google.com/spreadsheets/d/…",
        )
    spreadsheet_id = parts[2]
    if not spreadsheet_id or len(spreadsheet_id) > 128:
        raise AppError(400, "invalid_sheet", "That Google Sheets link is not valid.")
    return spreadsheet_id, f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}"


def google_account_email(access_token: str) -> str:
    try:
        response = httpx.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=20,
        )
    except httpx.HTTPError as exc:
        raise AppError(502, "sheets_profile_failed", "Google did not share the account address.") from exc
    if response.status_code >= 400:
        raise AppError(400, "sheets_profile_failed", "Google did not share the account address. Nothing was stored.")
    email = (response.json() or {}).get("email")
    if not email:
        raise AppError(400, "sheets_profile_failed", "Google did not share the account address. Nothing was stored.")
    return str(email).lower()


PENDING_SHEET_ID = "pending"


def is_sheet_attached(connection: SheetConnection) -> bool:
    return bool(connection.spreadsheet_id) and connection.spreadsheet_id != PENDING_SHEET_ID


def list_account_spreadsheets(
    access_token: str,
    *,
    query: str | None = None,
    page_token: str | None = None,
    page_size: int = 25,
) -> dict:
    """Browse Google Sheets the connected account can open (Drive API)."""
    clauses = ["mimeType='application/vnd.google-apps.spreadsheet'", "trashed=false"]
    cleaned = " ".join((query or "").split()).strip()
    if cleaned:
        safe = cleaned.replace("\\", "\\\\").replace("'", "\\'")
        clauses.append(f"name contains '{safe}'")
    params: dict[str, str | int] = {
        "q": " and ".join(clauses),
        "spaces": "drive",
        "corpora": "user",
        "orderBy": "modifiedTime desc",
        "pageSize": max(1, min(page_size, 50)),
        "fields": "nextPageToken,files(id,name,modifiedTime,owners(displayName,emailAddress),webViewLink,shared)",
    }
    if page_token:
        params["pageToken"] = page_token
    try:
        response = httpx.get(
            "https://www.googleapis.com/drive/v3/files",
            params=params,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=25,
        )
    except httpx.HTTPError as exc:
        raise AppError(502, "drive_list_failed", "Google Drive could not list spreadsheets.") from exc
    if response.status_code == 401:
        raise NeedsReauth()
    if response.status_code in {403, 404}:
        raise AppError(
            400,
            "drive_permission",
            "Enable the Google Drive API for this OAuth client, then reconnect Sheets.",
        )
    if response.status_code >= 400:
        raise AppError(400, "drive_list_failed", "Google Drive did not return spreadsheets.")
    body = response.json() or {}
    files = []
    for item in body.get("files") or []:
        owners = item.get("owners") or []
        owner = ""
        if owners:
            owner = str(owners[0].get("emailAddress") or owners[0].get("displayName") or "")
        files.append(
            {
                "id": str(item.get("id") or ""),
                "name": str(item.get("name") or "Untitled spreadsheet"),
                "modified_at": item.get("modifiedTime"),
                "owner": owner,
                "url": str(item.get("webViewLink") or ""),
                "shared": bool(item.get("shared")),
            }
        )
    return {
        "files": [row for row in files if row["id"]],
        "next_page_token": body.get("nextPageToken"),
    }


def preview_spreadsheet(access_token: str, spreadsheet_id: str, tab: str | None = None, max_rows: int = 8) -> dict:
    title, default_tab = spreadsheet_details(access_token, spreadsheet_id)
    tabs = list_tabs(access_token, spreadsheet_id)
    tab_name = (tab or default_tab or (tabs[0] if tabs else "Sheet1")).strip() or "Sheet1"
    safe_tab = tab_name.replace("'", "''")
    range_name = quote(f"'{safe_tab}'!A1:Z{max_rows + 1}", safe="")
    try:
        response = httpx.get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_name}",
            params={"majorDimension": "ROWS"},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=20,
        )
    except httpx.HTTPError as exc:
        raise AppError(502, "sheet_access", "Google Sheets could not be reached.") from exc
    if response.status_code == 401:
        raise NeedsReauth()
    if response.status_code in {403, 404}:
        raise AppError(400, "sheet_access", "That Google account cannot read this worksheet.")
    if response.status_code >= 400:
        raise AppError(400, "sheet_access", "Google Sheets did not return worksheet data.")
    values = (response.json() or {}).get("values") or []
    headers = [str(cell).strip() for cell in (values[0] if values else [])]
    rows = []
    for row in values[1:max_rows + 1]:
        padded = [str(cell) if cell is not None else "" for cell in row]
        if len(padded) < len(headers):
            padded.extend([""] * (len(headers) - len(padded)))
        rows.append(padded[: len(headers)] if headers else padded)
    return {
        "spreadsheet_id": spreadsheet_id,
        "spreadsheet_title": title,
        "tabs": tabs,
        "tab": tab_name,
        "headers": headers,
        "preview_rows": rows,
        "url": f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}",
    }


def spreadsheet_details(access_token: str, spreadsheet_id: str) -> tuple[str, str]:
    try:
        response = httpx.get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}",
            params={"fields": "properties.title,sheets.properties.title"},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=20,
        )
    except httpx.HTTPError as exc:
        raise AppError(502, "sheet_access", "Google Sheets could not be reached.") from exc
    if response.status_code in {401, 403, 404}:
        raise AppError(
            400,
            "sheet_access",
            "That Google account cannot open this sheet. Share the sheet with the account you connect.",
        )
    if response.status_code >= 400:
        raise AppError(400, "sheet_access", "Google Sheets did not accept that link.")
    body = response.json() or {}
    title = ((body.get("properties") or {}).get("title")) or "Google Sheet"
    sheets = body.get("sheets") or []
    tab = "Sheet1"
    if sheets:
        tab = ((sheets[0].get("properties") or {}).get("title")) or "Sheet1"
    return str(title)[:200], str(tab)[:120]


def append_send_row(connection: SheetConnection, values: list[str]) -> None:
    if connection.is_demo:
        return
    refresh = decrypt_secret(connection.encrypted_refresh_token)
    if not refresh:
        raise NeedsReauth()
    access = refresh_access_token(refresh)
    tab = connection.sheet_tab.replace("'", "''")
    range_name = quote(f"'{tab}'!A:F", safe="")
    headers = {
        "Authorization": f"Bearer {access}",
        "Content-Type": "application/json",
    }
    existing = httpx.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{connection.spreadsheet_id}/values/{range_name}",
        params={"majorDimension": "ROWS"},
        headers=headers,
        timeout=20,
    )
    if existing.status_code == 401:
        raise NeedsReauth()
    rows = []
    if existing.status_code == 200:
        rows = (existing.json() or {}).get("values") or []
    payload_rows = []
    if not rows:
        payload_rows.append(["Sent at", "From", "To", "Subject", "PDF", "Status"])
    payload_rows.append(values)
    written = httpx.post(
        f"https://sheets.googleapis.com/v4/spreadsheets/{connection.spreadsheet_id}/values/{range_name}:append",
        params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
        headers=headers,
        json={"values": payload_rows},
        timeout=20,
    )
    if written.status_code == 401:
        raise NeedsReauth()
    if written.status_code >= 400:
        raise AppError(502, "sheet_append_failed", "The email was sent, but the sheet row could not be added.")
    connection.updated_at = utcnow()


def row_values(*, sent_at, from_email: str, to_email: str, subject: str, attached: bool) -> list[str]:
    return [
        iso(sent_at) or "",
        from_email,
        to_email,
        subject,
        "PDF attached" if attached else "",
        "Accepted",
    ]


def list_tabs(access_token: str, spreadsheet_id: str) -> list[str]:
    try:
        response = httpx.get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}",
            params={"fields": "sheets.properties.title"},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=20,
        )
    except httpx.HTTPError as exc:
        raise AppError(502, "sheet_access", "Google Sheets could not be reached.") from exc
    if response.status_code in {401, 403, 404}:
        raise AppError(
            400,
            "sheet_access",
            "That Google account cannot open this sheet. Share the sheet with the account you connect.",
        )
    if response.status_code >= 400:
        raise AppError(400, "sheet_access", "Google Sheets did not accept that request.")
    sheets = (response.json() or {}).get("sheets") or []
    titles = []
    for sheet in sheets:
        title = ((sheet.get("properties") or {}).get("title")) or ""
        if title:
            titles.append(str(title)[:120])
    return titles or ["Sheet1"]


def read_sheet_values(connection: SheetConnection, tab: str | None = None, max_rows: int = 200) -> dict:
    """Return headers and data rows for recipient import."""
    tab_name = (tab or connection.sheet_tab or "Sheet1").strip() or "Sheet1"
    if connection.is_demo:
        headers = ["email", "first_name", "last_name", "company"]
        rows = [
            ["aisha@northwind.example", "Aisha", "Khan", "Northwind"],
            ["ben@brightpath.example", "Ben", "Ortiz", "Brightpath"],
            ["casey@example.com", "Casey", "", "Indie"],
            ["", "Skip", "Empty", "ShouldFail"],
            ["not-an-email", "Bad", "Address", "ShouldFail"],
        ]
        return {"headers": headers, "rows": rows[:max_rows], "tab": tab_name, "demo": True}

    refresh = decrypt_secret(connection.encrypted_refresh_token)
    if not refresh:
        raise NeedsReauth()
    access = refresh_access_token(refresh)
    safe_tab = tab_name.replace("'", "''")
    range_name = quote(f"'{safe_tab}'!A1:Z{max_rows + 1}", safe="")
    headers_http = {"Authorization": f"Bearer {access}"}
    try:
        response = httpx.get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{connection.spreadsheet_id}/values/{range_name}",
            params={"majorDimension": "ROWS"},
            headers=headers_http,
            timeout=20,
        )
    except httpx.HTTPError as exc:
        raise AppError(502, "sheet_access", "Google Sheets could not be reached.") from exc
    if response.status_code == 401:
        raise NeedsReauth()
    if response.status_code in {403, 404}:
        raise AppError(400, "sheet_access", "That Google account cannot read this worksheet.")
    if response.status_code >= 400:
        raise AppError(400, "sheet_access", "Google Sheets did not return worksheet data.")
    values = (response.json() or {}).get("values") or []
    if not values:
        return {"headers": [], "rows": [], "tab": tab_name, "demo": False}
    headers = [str(cell).strip() for cell in values[0]]
    rows = []
    for row in values[1:]:
        padded = [str(cell) if cell is not None else "" for cell in row]
        if len(padded) < len(headers):
            padded.extend([""] * (len(headers) - len(padded)))
        rows.append(padded[: len(headers)])
    connection.updated_at = utcnow()
    return {"headers": headers, "rows": rows[:max_rows], "tab": tab_name, "demo": False}


def map_sheet_rows(
    headers: list[str],
    rows: list[list[str]],
    mapping: dict[str, str],
) -> tuple[list[dict], list[dict]]:
    """Map sheet rows to contact dicts. Returns (contacts, errors)."""
    index = {header.lower().strip(): idx for idx, header in enumerate(headers) if header.strip()}
    email_col = mapping.get("email") or mapping.get("Email")
    if not email_col:
        raise AppError(400, "email_column_required", "Map a spreadsheet column to email.")
    email_key = email_col.lower().strip()
    if email_key not in index:
        raise AppError(400, "email_column_missing", f"Column '{email_col}' was not found in the sheet header.")

    def cell(row: list[str], column: str | None) -> str:
        if not column:
            return ""
        key = column.lower().strip()
        if key not in index:
            return ""
        pos = index[key]
        return (row[pos] if pos < len(row) else "").strip()

    contacts: list[dict] = []
    errors: list[dict] = []
    seen: set[str] = set()
    for offset, row in enumerate(rows, start=2):
        if not any(str(value).strip() for value in row):
            continue
        email_raw = cell(row, email_col)
        if not email_raw:
            errors.append({"row": offset, "code": "missing_email", "message": "Email is empty."})
            continue
        first = cell(row, mapping.get("first_name"))
        last = cell(row, mapping.get("last_name"))
        company = cell(row, mapping.get("company"))
        name = " ".join(part for part in [first, last] if part).strip() or None
        custom = {}
        for field, column in mapping.items():
            if field in {"email", "first_name", "last_name", "company"}:
                continue
            value = cell(row, column)
            if value:
                custom[field] = value
        if company:
            custom["company"] = company
        if first:
            custom["first_name"] = first
        if last:
            custom["last_name"] = last
        try:
            from email_validator import EmailNotValidError, validate_email

            email = validate_email(email_raw, check_deliverability=False).normalized.lower()
        except EmailNotValidError:
            errors.append({"row": offset, "code": "invalid_email", "message": f"Invalid email: {email_raw}"})
            continue
        if email in seen:
            errors.append({"row": offset, "code": "duplicate", "message": f"Duplicate email in sheet: {email}"})
            continue
        seen.add(email)
        contacts.append({"email": email, "name": name, "custom_fields": custom, "row": offset})
    return contacts, errors
