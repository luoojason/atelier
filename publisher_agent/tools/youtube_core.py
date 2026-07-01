"""Pure-function core for uploading video to YouTube (Data API v3).

All real logic lives in plain module-level functions that take arguments and
return values, with NO dependency on agency_swarm or pydantic. The BaseTool in
``UploadToYouTube.py`` is a thin wrapper around ``upload_video`` /
``get_service`` defined here.

The only YouTube-specific pieces:
- ``build_upload_request`` builds the exact ``videos.insert`` body/params dict.
- ``upload_video`` performs the insert against an injected ``service_factory``
  (so tests can pass a fake and never touch the network).
- ``get_service`` builds the real google-api-python-client client and is only
  imported lazily, so importing this module has no heavy dependencies.
"""

import datetime
import os

# YouTube API accepts exactly these three privacy values.
VALID_PRIVACY = ("public", "private", "unlisted")

# "People & Blogs" — a safe, always-valid default category for generic uploads.
DEFAULT_CATEGORY_ID = "22"

WATCH_URL = "https://www.youtube.com/watch?v={video_id}"


def normalize_privacy(privacy):
    """Return a valid YouTube privacy status, defaulting unknown/empty to unlisted."""
    value = (privacy or "").strip().lower()
    if value not in VALID_PRIVACY:
        return "unlisted"
    return value


def normalize_publish_at(publish_at):
    """Parse an ISO-8601 timestamp and normalize it to an RFC3339 UTC string.

    Returns ``None`` for an empty/None input (meaning "not scheduled"). Otherwise
    parses the value, treating a naive timestamp as UTC and converting an aware
    one to UTC, and returns a string like ``2026-07-05T14:00:00Z``.

    Raises ``ValueError`` when the value cannot be parsed as ISO-8601 or when it
    is not strictly in the future (YouTube rejects past scheduled times).
    """
    if publish_at is None:
        return None
    raw = str(publish_at).strip()
    if not raw:
        return None

    # datetime.fromisoformat on older Pythons does not accept a trailing 'Z';
    # normalize it to an explicit +00:00 offset before parsing.
    candidate = raw
    if candidate.endswith(("Z", "z")):
        candidate = candidate[:-1] + "+00:00"

    try:
        parsed = datetime.datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise ValueError(
            f"publish_at is not a valid ISO-8601 timestamp: {publish_at!r} ({exc})."
        ) from exc

    # Naive timestamps are interpreted as UTC; aware ones are converted to UTC.
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    else:
        parsed = parsed.astimezone(datetime.timezone.utc)

    now = datetime.datetime.now(datetime.timezone.utc)
    if parsed <= now:
        raise ValueError(
            f"publish_at must be a future time (got {publish_at!r}; "
            f"now is {now.strftime('%Y-%m-%dT%H:%M:%SZ')})."
        )

    return parsed.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_upload_request(
    file_path, title, description="", tags=None, privacy="unlisted", publish_at=None
):
    """Build the params dict for a YouTube Data API v3 ``videos.insert`` call.

    Returns a plain dict with the ``part``, ``body`` (snippet + status), and the
    ``media_path`` that the caller should turn into a media upload. This function
    has no side effects and does not touch the network or the filesystem.

    When ``publish_at`` is set, the video is scheduled: YouTube requires the
    privacy status to be ``private`` (this overrides an explicit ``privacy`` such
    as ``public``), and ``status.publishAt`` is set to the normalized RFC3339 UTC
    timestamp. A past or malformed ``publish_at`` raises ``ValueError``.
    """
    if not title or not str(title).strip():
        raise ValueError("YouTube upload requires a non-empty title.")

    snippet = {
        "title": str(title),
        "description": str(description or ""),
        "tags": list(tags or []),
        "categoryId": DEFAULT_CATEGORY_ID,
    }

    normalized_publish_at = normalize_publish_at(publish_at)
    if normalized_publish_at is not None:
        # Scheduled videos must be private until they go live; publishAt wins over
        # any explicit privacy the caller passed.
        status = {"privacyStatus": "private", "publishAt": normalized_publish_at}
    else:
        status = {"privacyStatus": normalize_privacy(privacy)}

    return {
        "part": "snippet,status",
        "body": {"snippet": snippet, "status": status},
        "media_path": file_path,
    }


def resolve_credential_paths(env=None):
    """Return (token_file, client_secrets) resolved from the environment."""
    env = env if env is not None else os.environ
    token_file = env.get("YOUTUBE_TOKEN_FILE", "").strip()
    client_secrets = env.get("YOUTUBE_CLIENT_SECRETS", "").strip()
    return token_file, client_secrets


def credentials_error(token_file, client_secrets):
    """Return a clear error string when no usable credentials exist, else None.

    A usable setup needs either a saved OAuth token file or a client-secrets file
    to run the OAuth flow. If neither path is configured or present on disk, we
    return a human-readable message instead of letting google-api-python-client
    raise a cryptic error.
    """
    have_token = bool(token_file) and os.path.exists(token_file)
    have_secrets = bool(client_secrets) and os.path.exists(client_secrets)
    if have_token or have_secrets:
        return None

    missing = []
    if not token_file:
        missing.append("YOUTUBE_TOKEN_FILE is not set")
    elif not os.path.exists(token_file):
        missing.append(f"YOUTUBE_TOKEN_FILE points to a missing file: {token_file}")
    if not client_secrets:
        missing.append("YOUTUBE_CLIENT_SECRETS is not set")
    elif not os.path.exists(client_secrets):
        missing.append(f"YOUTUBE_CLIENT_SECRETS points to a missing file: {client_secrets}")

    return (
        "YouTube credentials are not configured. "
        + "; ".join(missing)
        + ". Set YOUTUBE_TOKEN_FILE (a saved OAuth token) or "
        "YOUTUBE_CLIENT_SECRETS (an OAuth client-secrets JSON) and try again."
    )


def _default_media_factory(file_path):
    """Build a real MediaFileUpload (resumable). Imported lazily for testability."""
    from googleapiclient.http import MediaFileUpload  # noqa: PLC0415

    return MediaFileUpload(file_path, chunksize=-1, resumable=True)


def upload_video(file_path, meta, service_factory, media_factory=None):
    """Upload one video file to YouTube via an injected service.

    Args:
        file_path: absolute path to the video file to upload.
        meta: dict with optional keys ``title``, ``description``, ``tags``,
            ``privacy``.
        service_factory: zero-arg callable returning a YouTube API service object
            (real client in production, a fake in tests). Called once.
        media_factory: optional one-arg callable ``(file_path) -> media_body``.
            Defaults to building a resumable ``MediaFileUpload``; tests override it
            to avoid importing google-api-python-client.

    Returns a dict. On success: ``{"ok": True, "video_id", "url", "privacy",
    "title"}``. On failure: ``{"ok": False, "error"}``. Never raises for the
    common error paths (missing file, service build failure, API error).
    """
    meta = meta or {}
    title = meta.get("title", "")
    description = meta.get("description", "")
    tags = meta.get("tags", [])
    privacy = normalize_privacy(meta.get("privacy", "unlisted"))
    publish_at = meta.get("publish_at")

    if not file_path or not os.path.exists(file_path):
        return {"ok": False, "error": f"Video file not found: {file_path}"}

    try:
        request = build_upload_request(
            file_path, title, description, tags, privacy, publish_at
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    # A scheduled upload forces privacyStatus='private'; report what was actually
    # sent rather than the caller's requested privacy.
    effective_privacy = request["body"]["status"]["privacyStatus"]

    try:
        service = service_factory()
    except Exception as exc:  # noqa: BLE001 - surface any creds/build failure cleanly
        return {"ok": False, "error": f"Could not build YouTube client: {exc}"}

    factory = media_factory or _default_media_factory
    try:
        media_body = factory(request["media_path"])
        response = (
            service.videos()
            .insert(part=request["part"], body=request["body"], media_body=media_body)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001 - API/network errors become a clear string
        return {"ok": False, "error": f"YouTube upload failed: {exc}"}

    video_id = None
    if isinstance(response, dict):
        video_id = response.get("id")
    if not video_id:
        return {"ok": False, "error": f"YouTube upload returned no video id: {response!r}"}

    return {
        "ok": True,
        "video_id": video_id,
        "url": WATCH_URL.format(video_id=video_id),
        "privacy": effective_privacy,
        "title": request["body"]["snippet"]["title"],
    }


def load_or_refresh_credentials(
    token_file,
    client_secrets,
    scopes,
    *,
    credentials_loader,
    request_factory,
    flow_runner,
):
    """Return usable OAuth credentials, persisting them to ``token_file``.

    Pure orchestration with injected seams so the write-back is testable without
    google-api-python-client:

    - ``credentials_loader(token_file, scopes) -> creds`` loads a saved token.
    - ``request_factory() -> Request`` builds the transport for a refresh.
    - ``flow_runner(client_secrets, scopes) -> creds`` runs the interactive flow.

    Loads any saved token; if it is missing or invalid, either refreshes it
    (when expired but refreshable) or runs the OAuth flow, then writes the
    resulting ``creds.to_json()`` back to ``token_file``. Persisting after a
    REFRESH (not only after the flow) is the fix for the original bug: otherwise
    the on-disk token stays stale, every run refreshes again, and a rotated
    refresh_token would be silently discarded and could later fail auth.
    """
    creds = None
    if token_file and os.path.exists(token_file):
        creds = credentials_loader(token_file, scopes)

    if creds is None or not getattr(creds, "valid", False):
        if creds and getattr(creds, "expired", False) and getattr(creds, "refresh_token", None):
            creds.refresh(request_factory())
        else:
            creds = flow_runner(client_secrets, scopes)
        # Persist the refreshed OR newly obtained token so the next run reuses it
        # and any rotated refresh_token is not lost.
        if token_file:
            with open(token_file, "w", encoding="utf-8") as handle:
                handle.write(creds.to_json())

    return creds


def get_service(env=None):
    """Build a real authenticated YouTube Data API v3 service.

    Reads token/creds paths from env (YOUTUBE_TOKEN_FILE / YOUTUBE_CLIENT_SECRETS).
    Raises RuntimeError with a clear message when credentials are missing so the
    caller (``upload_video``) turns it into a friendly error string. Heavy Google
    libraries are imported lazily so importing this module stays cheap.
    """
    env = env if env is not None else os.environ
    token_file, client_secrets = resolve_credential_paths(env)

    err = credentials_error(token_file, client_secrets)
    if err:
        raise RuntimeError(err)

    from google.oauth2.credentials import Credentials  # noqa: PLC0415
    from googleapiclient.discovery import build  # noqa: PLC0415

    scopes = ["https://www.googleapis.com/auth/youtube.upload"]

    def _load(token, scp):
        return Credentials.from_authorized_user_file(token, scp)

    def _request():
        from google.auth.transport.requests import Request  # noqa: PLC0415

        return Request()

    def _flow(secrets, scp):
        from google_auth_oauthlib.flow import InstalledAppFlow  # noqa: PLC0415

        flow = InstalledAppFlow.from_client_secrets_file(secrets, scp)
        return flow.run_local_server(port=0)

    try:
        creds = load_or_refresh_credentials(
            token_file,
            client_secrets,
            scopes,
            credentials_loader=_load,
            request_factory=_request,
            flow_runner=_flow,
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"YouTube OAuth failed: {exc}") from exc

    return build("youtube", "v3", credentials=creds)
