"""Central, safe configuration loader for the Corporate Studio AI middleware.

Values are read from the process environment first and from a local ``.env``
file (``python-dotenv``) as a fallback, mirroring the environment contract of
the original Node.js backend. Every consumer should import from here instead
of touching ``os.environ`` directly.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Project root is the directory containing this file; ``.env`` is colocated.
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def _to_int(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _to_bool(value, default=False):
    return str(value).strip().lower() in ("true", "1", "yes", "on") if value else default


# ---------------------------------------------------------------------------
# Application basics
# ---------------------------------------------------------------------------
APP_NAME = os.getenv("APP_NAME", "F-Grade Corporate AI Backend")
ENVIRONMENT = os.getenv("NODE_ENV", os.getenv("ENVIRONMENT", "development"))
DEBUG_ASSISTANT = _to_bool(os.getenv("DEBUG_ASSISTANT"))

# Port used locally / by the Render start command override.
PORT = _to_int(os.getenv("PORT"), 8000)

# Per-call CRM timeout in milliseconds (default 15s, matches the Node client).
ZOHO_API_TIMEOUT_MS = _to_int(os.getenv("ZOHO_API_TIMEOUT_MS"), 15000)


# ---------------------------------------------------------------------------
# Zoho OAuth credentials
# ---------------------------------------------------------------------------
# Both the prefixed (ZOHO_*) and the legacy (CLIENT_ID/CLIENT_SECRET/
# REFRESH_TOKEN/API_DOMAIN) names are supported so the existing ``.env`` and
# Render dashboard variables keep working unchanged.
ZOHO_CLIENT_ID = os.getenv("ZOHO_CLIENT_ID") or os.getenv("CLIENT_ID") or ""
ZOHO_CLIENT_SECRET = os.getenv("ZOHO_CLIENT_SECRET") or os.getenv("CLIENT_SECRET") or ""
ZOHO_REFRESH_TOKEN = os.getenv("ZOHO_REFRESH_TOKEN") or os.getenv("REFRESH_TOKEN") or ""
ZOHO_API_DOMAIN = (os.getenv("ZOHO_API_DOMAIN") or os.getenv("API_DOMAIN") or "").rstrip("/")


def default_accounts_url(api_domain):
    """Derive the Zoho Accounts host from the API domain (same data center).

    E.g. ``https://www.zohoapis.in`` -> ``https://accounts.zoho.in``.
    """
    if not api_domain:
        return ""
    host = api_domain.split("://", 1)[-1].split("/", 1)[0].lower()
    suffix = host.removeprefix("www.").replace("zohoapis.", "", 1)
    return f"https://accounts.zoho.{suffix}"


ZOHO_ACCOUNTS_URL = (os.getenv("ZOHO_ACCOUNTS_URL") or default_accounts_url(ZOHO_API_DOMAIN)).rstrip("/")


# ---------------------------------------------------------------------------
# CORS (defaults to allow-all, pin it via CORS_ORIGINS for production)
# ---------------------------------------------------------------------------
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "*").split(",")
    if origin.strip()
]