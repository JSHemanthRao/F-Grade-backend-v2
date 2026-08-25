"""
services/crm_service.py
-----------------------
Async Zoho CRM client built on ``httpx``.

Responsibilities:
  * OAuth2 access-token refresh (``grant_type=refresh_token``) with in-memory
    caching, an expiry buffer and a single-flight refresh lock so concurrent
    requests never trigger duplicate refreshes.
  * Every read-only Zoho CRM v8 call used by the middleware.
  * Uniform ``CRMServiceError`` errors; failures surface as clear JSON error
    bodies instead of crashing the process.
  * Every record is sanitized by ``schemas.crm_schema.sanitize_record``
    before it leaves the service layer.
"""

import asyncio
import csv
import io
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import httpx

import config
from schemas.crm_schema import sanitize_record

CRM_API_PREFIX = "/crm/v8"

# Zoho returns paginated data; 200 is the hard ceiling for per_page.
MAX_PER_PAGE = 200
DEFAULT_PAGE = 1

# Activity report timezone defaults (matches the original backend).
DEFAULT_TIMEZONE = "Asia/Kolkata"
IST_OFFSET = "+05:30"
EXPORT_MAX_POLLS = 10
EXPORT_POLL_MS = 2.0  # seconds

logger = logging.getLogger(__name__)
DEAL_CONVERSION_TIME_FIELD = "Lead_Conversion_Time"

# ---------------------------------------------------------------------------
# Supported CRM modules (module key -> Zoho API endpoint + display label)
# ---------------------------------------------------------------------------
MODULE_ENDPOINTS: Dict[str, str] = {
    "leads": "Leads",
    "contacts": "Contacts",
    "accounts": "Accounts",
    "deals": "Deals",
    "tasks": "Tasks",
    "events": "Events",
    "calls": "Calls",
    "meetings": "Meetings",
    "notes": "Notes",
    "products": "Products",
    "vendors": "Vendors",
    "quotes": "Quotes",
    "sales-orders": "Sales_Orders",
    "purchase-orders": "Purchase_Orders",
    "campaigns": "Campaigns",
    "cases": "Cases",
    "solutions": "Solutions",
    "users": "Users",
    "organization": "org",
    "partners": "Partners",
    "enterprise-leads": "Enterprise",
    "renewal-accounts": "Renewal_Accounts",
    "service-provider": "Service_Provider",
    "co-operative-banks": "Co_operative_Banks",
    "documents": "Documents",
}

MODULE_LABELS: Dict[str, str] = {
    "sales-orders": "Sales Orders",
    "purchase-orders": "Purchase Orders",
    "enterprise-leads": "Enterprise Leads",
    "renewal-accounts": "Renewal Accounts",
    "service-provider": "Service Provider",
    "co-operative-banks": "Co-operative Banks",
}

# Default field list per module. Zoho's list/search APIs reject requests that
# omit ``fields``, so the middleware supplies a sensible default for every
# supported module (mirroring the original Node.js backend).
DEFAULT_FIELDS: Dict[str, List[str]] = {
    "leads": ["First_Name", "Last_Name", "Company", "Email", "Phone", "Lead_Source", "Created_Time"],
    "contacts": ["First_Name", "Last_Name", "Email", "Phone", "Mailing_City", "Mailing_Country"],
    "accounts": ["Account_Name", "Website", "Phone", "Industry", "Annual_Revenue", "Billing_Country"],
    "deals": ["Deal_Name", "Amount", "Stage", "Closing_Date", "Lead_Conversion_Time", "Account_Name", "Deal_Source", "Owner"],
    "tasks": ["Subject", "Status", "Due_Date", "Owner", "Priority"],
    "events": ["Subject", "Start_DateTime", "End_DateTime", "Owner", "Location"],
    "calls": ["Subject", "Call_Type", "Call_Duration", "Call_Start_Time", "Status"],
    "meetings": ["Subject", "Start_DateTime", "End_DateTime", "Owner", "Related_To"],
    "notes": ["Title", "Note_Content", "Parent_Id", "Owner"],
    "products": ["Product_Name", "Product_Code", "Unit_Price", "Description"],
    "vendors": ["Vendor_Name", "Email", "Phone", "City", "State", "Country"],
    "quotes": ["Subject", "Quote_Number", "Grand_Total", "Status", "Potential_Name"],
    "sales-orders": ["Subject", "Sales_Order_Number", "Grand_Total", "Status", "Account_Name"],
    "purchase-orders": ["Subject", "Purchase_Order_Number", "Grand_Total", "Status", "Vendor_Name"],
    "campaigns": ["Campaign_Name", "Type", "Status", "Start_Date", "End_Date"],
    "cases": ["Subject", "Status", "Priority", "Origin", "Account_Name"],
    "solutions": ["Solution_Title", "Solution_Number", "Status", "IsPublished"],
    "users": ["first_name", "last_name", "email", "role"],
    "organization": ["Company_Name", "Alias", "Primary_Email"],
    "partners": ["Partner_Name", "Company_Name", "Partner_Owner", "Partner_Status", "Email", "Created_Time", "Modified_Time", "Last_Activity_Time", "End_Customer_Accounts", "id"],
    "enterprise-leads": ["Enterprise_Name", "Email", "Enterprise_Owner", "Modified_Time", "Created_Time", "Created_By", "Connected_To", "id"],
    "renewal-accounts": ["Account_Name", "Renewal_Date", "Status", "Owner"],
    "service-provider": ["Service_Provider_Name", "Email", "Phone", "Website"],
    "co-operative-banks": ["Co_operative_Banks_Name", "Contact_Name", "Contact_Number", "State_UT"],
    "documents": ["Title", "File_Name", "Owner", "Created_Time"],
}

# Modules whose list API does not consume the standard ``fields`` parameter.
NO_FIELDS_MODULES = ("users", "organization")

# Natural-language aliases used by the assistant and module path resolver.
MODULE_ALIASES: Dict[str, str] = {
    "opportunity": "deals",
    "opportunities": "deals",
    "sales order": "sales-orders",
    "salesorders": "sales-orders",
    "purchase order": "purchase-orders",
    "purchaseorders": "purchase-orders",
    "organizations": "organization",
    "org": "organization",
    "meeting": "meetings",
    "event": "events",
    "call": "calls",
    "vendor": "vendors",
    "product": "products",
    "quote": "quotes",
    "campaign": "campaigns",
    "case": "cases",
    "solution": "solutions",
    "note": "notes",
    "task": "tasks",
    "account": "accounts",
    "contact": "contacts",
    "lead": "leads",
    "deal": "deals",
    "enterprise lead": "enterprise-leads",
    "renewal account": "renewal-accounts",
    "service provider": "service-provider",
    "cooperative bank": "co-operative-banks",
    "co-operative bank": "co-operative-banks",
    "document": "documents",
}

# Modules tracked by the activity report's record-search fallback.
ACTIVITY_MODULES: List[str] = [
    "deals",
    "leads",
    "contacts",
    "accounts",
    "tasks",
    "calls",
    "events",
    "meetings",
]


def normalize_module_key(raw: Optional[str]) -> Optional[str]:
    """Normalize free-form module input into a supported module key."""
    if not raw:
        return None
    key = str(raw).strip().lower()
    if key in MODULE_ENDPOINTS:
        return key
    alias = MODULE_ALIASES.get(key)
    if alias:
        return alias
    hyphenated = re.sub(r"[\s_]+", "-", key)
    return hyphenated if hyphenated in MODULE_ENDPOINTS else None


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class CRMServiceError(Exception):
    """Raised for every Zoho failure so routers can return JSON errors."""

    def __init__(
        self,
        message: str,
        status_code: int = 502,
        code: str = "CRM_API_ERROR",
        details: Any = None,
    ):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.details = details

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details is not None:
            payload["details"] = self.details
        return payload


# ---------------------------------------------------------------------------
# Date / criteria helpers (mirrors the Node buildDateRangeCriteria contract)
# ---------------------------------------------------------------------------

def _safe_tz(timezone_name: str) -> ZoneInfo:
    """Resolve an IANA timezone, falling back to IST or a fixed +05:30 offset.

    Windows and slim containers often lack the system tz database; the
    ``tzdata`` wheel provides it, and the fixed offset keeps the app usable
    even if neither is available.
    """
    try:
        return ZoneInfo(timezone_name)
    except Exception:
        try:
            return ZoneInfo(DEFAULT_TIMEZONE)
        except Exception:
            return timezone(timedelta(hours=5, minutes=30))


def safe_tz(timezone_name: str) -> ZoneInfo:
    """Public alias used by the router layer."""
    return _safe_tz(timezone_name)


def _to_ist_string(value: str, timezone_name: str = DEFAULT_TIMEZONE) -> str:
    """Canonicalize a date/datetime to an IST-offset string for Zoho criteria."""
    raw = str(value or "").strip()
    if not raw:
        return raw
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return f"{raw}T00:00:00{IST_OFFSET}"
    if re.search(r"[+-]\d{2}:\d{2}$", raw):
        return raw
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        local = parsed.astimezone(_safe_tz(timezone_name))
        return local.isoformat(timespec="seconds")
    except ValueError:
        return raw


def _today_range(timezone_name: str = DEFAULT_TIMEZONE) -> Dict[str, str]:
    tz = _safe_tz(timezone_name)
    now = datetime.now(tz)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return {
        "date": start.date().isoformat(),
        "from": start.isoformat(timespec="seconds"),
        "to": end.isoformat(timespec="seconds"),
        "timezone": timezone_name,
    }


def _dict_to_criteria(filters: Any) -> Optional[str]:
    """Translate plain dict filters or structured field/operator/value objects into Zoho criteria."""
    if filters is None:
        return None
    if isinstance(filters, str):
        return filters

    clauses: List[str] = []

    def add_clause(field: Any, operator: str, value: Any) -> None:
        field_name = str(field)
        if operator in {"equals", "equal"}:
            clauses.append(f"({field_name}:equals:{value})")
        elif operator in {"not_equals", "not_equal"}:
            clauses.append(f"({field_name}:not_equals:{value})")
        elif operator == "in":
            items = value if isinstance(value, (list, tuple, set)) else [value]
            values = ",".join(f'"{item}"' for item in items if item is not None)
            clauses.append(f"({field_name}:in:[{values}])")
        elif operator == "contains":
            clauses.append(f"({field_name}:contains:{value})")
        elif operator == "starts_with":
            clauses.append(f"({field_name}:starts_with:{value})")
        elif operator == "greater_than":
            clauses.append(f"({field_name}:greater_than:{value})")
        elif operator == "less_than":
            clauses.append(f"({field_name}:less_than:{value})")
        elif operator == "greater_equal":
            clauses.append(f"({field_name}:greater_equal:{value})")
        elif operator == "less_equal":
            clauses.append(f"({field_name}:less_equal:{value})")
        elif operator == "between":
            if isinstance(value, (list, tuple)) and len(value) == 2:
                clauses.append(f"({field_name}:greater_equal:{value[0]})and({field_name}:less_than:{value[1]})")
        elif operator in {"is_null", "is_not_null"}:
            clauses.append(f"({field_name}:{operator}:{value})")

    if isinstance(filters, dict):
        if {"field", "operator", "value"}.issubset(filters.keys()):
            add_clause(filters.get("field"), filters.get("operator", "equals"), filters.get("value"))
        else:
            for field, value in filters.items():
                field_name = str(field)
                if isinstance(value, (list, tuple, set)):
                    values = ",".join(f'"{v}"' for v in value if v is not None)
                    clauses.append(f"({field_name}:in:[{values}])")
                else:
                    clauses.append(f"({field_name}:equals:{value})")
    elif isinstance(filters, list):
        for item in filters:
            if isinstance(item, dict) and {"field", "operator", "value"}.issubset(item.keys()):
                add_clause(item.get("field"), item.get("operator", "equals"), item.get("value"))
            elif isinstance(item, dict):
                for field, value in item.items():
                    add_clause(field, "equals", value)

    return "and".join(clauses) if clauses else None


def build_criteria(
    *,
    criteria: Optional[str] = None,
    filter: Optional[Any] = None,
    filters: Optional[Any] = None,
    date_field: Optional[str] = None,
    from_value: Optional[str] = None,
    to_value: Optional[str] = None,
    timezone_name: str = DEFAULT_TIMEZONE,
) -> Optional[str]:
    """Combine user criteria + dict filters + date range into one Zoho query."""
    parts: List[str] = []
    if criteria and str(criteria).strip():
        parts.append(str(criteria).strip())

    dict_criteria = _dict_to_criteria(filter) or _dict_to_criteria(filters)
    if dict_criteria:
        parts.append(dict_criteria)

    if date_field and from_value and to_value:
        start = _to_ist_string(from_value, timezone_name)
        end = _to_ist_string(to_value, timezone_name)
        if start and end:
            parts.append(
                f"({date_field}:greater_equal:{start})and({date_field}:less_than:{end})"
            )

    if not parts:
        return None
    merged = parts[0]
    for part in parts[1:]:
        merged = f"({merged})and({part})"
    return merged


def _coql_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    escaped = str(value).replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def _dict_to_coql(filters: Any) -> Optional[str]:
    if filters is None:
        return None
    if isinstance(filters, str):
        return filters

    clauses: List[str] = []

    def add_clause(field: Any, operator: str, value: Any) -> None:
        field_name = str(field)
        if operator in {"equals", "equal"}:
            clauses.append(f"{field_name} = {_coql_value(value)}")
        elif operator in {"not_equals", "not_equal"}:
            clauses.append(f"{field_name} != {_coql_value(value)}")
        elif operator == "contains":
            clauses.append(f"{field_name} like {_coql_value(f'%{value}%')}")
        elif operator == "starts_with":
            clauses.append(f"{field_name} like {_coql_value(f'{value}%')}")
        elif operator == "greater_than":
            clauses.append(f"{field_name} > {_coql_value(value)}")
        elif operator == "less_than":
            clauses.append(f"{field_name} < {_coql_value(value)}")
        elif operator == "greater_equal":
            clauses.append(f"{field_name} >= {_coql_value(value)}")
        elif operator == "less_equal":
            clauses.append(f"{field_name} <= {_coql_value(value)}")
        elif operator == "is_null":
            clauses.append(f"{field_name} is null")
        elif operator == "is_not_null":
            clauses.append(f"{field_name} is not null")

    if isinstance(filters, dict):
        if {"field", "operator", "value"}.issubset(filters.keys()):
            add_clause(filters.get("field"), filters.get("operator", "equals"), filters.get("value"))
        else:
            for field, value in filters.items():
                add_clause(field, "equals", value)
    elif isinstance(filters, list):
        for item in filters:
            if isinstance(item, dict) and {"field", "operator", "value"}.issubset(item.keys()):
                add_clause(item.get("field"), item.get("operator", "equals"), item.get("value"))
            elif isinstance(item, dict):
                for field, value in item.items():
                    add_clause(field, "equals", value)

    return " and ".join(f"({clause})" for clause in clauses) if clauses else None


def build_coql_criteria(
    *,
    criteria: Optional[str] = None,
    filter: Optional[Any] = None,
    filters: Optional[Any] = None,
    date_field: Optional[str] = None,
    from_value: Optional[str] = None,
    to_value: Optional[str] = None,
    timezone_name: str = DEFAULT_TIMEZONE,
) -> Optional[str]:
    """Build valid COQL predicates from the same supported filter inputs."""
    parts: List[str] = []
    if criteria and str(criteria).strip():
        parts.append(str(criteria).strip())
    filter_query = _dict_to_coql(filter) or _dict_to_coql(filters)
    if filter_query:
        parts.append(filter_query)
    if date_field and from_value and to_value:
        start = _to_ist_string(from_value, timezone_name)
        end = _to_ist_string(to_value, timezone_name)
        parts.append(
            f"({date_field} >= {_coql_value(start)} and {date_field} < {_coql_value(end)})"
        )
    return " and ".join(f"({part})" for part in parts) if parts else None


# ---------------------------------------------------------------------------
# Zoho CRM service
# ---------------------------------------------------------------------------

class ZohoCRMService:
    """Async Zoho CRM client with cached, single-flight OAuth token refresh."""

    # 60s buffer so tokens are refreshed before Zoho actually rejects them.
    TOKEN_EXPIRY_BUFFER_S = 60
    TOKEN_DEFAULT_TTL_S = 3600

    def __init__(self) -> None:
        self._client: Optional[httpx.AsyncClient] = None
        self._access_token: Optional[str] = None
        self._expires_at: float = 0.0
        self._refresh_lock = asyncio.Lock()

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=config.ZOHO_API_DOMAIN or None,
                timeout=max(config.ZOHO_API_TIMEOUT_MS / 1000, 5.0),
                limits=httpx.Limits(
                    max_connections=100,
                    max_keepalive_connections=20,
                ),
            )

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # -- configuration guard ----------------------------------------------

    def _assert_configured(self) -> None:
        missing = []
        if not config.ZOHO_CLIENT_ID:
            missing.append("ZOHO_CLIENT_ID/CLIENT_ID")
        if not config.ZOHO_CLIENT_SECRET:
            missing.append("ZOHO_CLIENT_SECRET/CLIENT_SECRET")
        if not config.ZOHO_REFRESH_TOKEN:
            missing.append("ZOHO_REFRESH_TOKEN/REFRESH_TOKEN")
        if not config.ZOHO_API_DOMAIN:
            missing.append("ZOHO_API_DOMAIN/API_DOMAIN")
        if missing:
            raise CRMServiceError(
                f"Missing required Zoho CRM configuration: {', '.join(missing)}",
                status_code=502,
                code="ZOHO_CONFIGURATION_ERROR",
            )

    # -- OAuth -------------------------------------------------------------

    async def _refresh_access_token(self) -> None:
        self._assert_configured()
        token_url = f"{config.ZOHO_ACCOUNTS_URL}/oauth/v2/token"
        form = {
            "refresh_token": config.ZOHO_REFRESH_TOKEN,
            "client_id": config.ZOHO_CLIENT_ID,
            "client_secret": config.ZOHO_CLIENT_SECRET,
            "grant_type": "refresh_token",
        }

        try:
            async with httpx.AsyncClient(timeout=10.0) as http:
                response = await http.post(
                    token_url,
                    data=form,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPError as exc:
            raise CRMServiceError(
                "Zoho authentication failed while refreshing the access token.",
                status_code=502,
                code="ZOHO_AUTHENTICATION_ERROR",
                details=str(exc),
            ) from exc

        access_token = payload.get("access_token")
        if not access_token:
            raise CRMServiceError(
                "Zoho authentication failed because no access token was returned.",
                status_code=502,
                code="ZOHO_AUTHENTICATION_ERROR",
            )

        try:
            ttl = float(payload.get("expires_in", self.TOKEN_DEFAULT_TTL_S))
        except (TypeError, ValueError):
            ttl = self.TOKEN_DEFAULT_TTL_S

        self._access_token = str(access_token)
        self._expires_at = time.monotonic() + max(ttl, 60)

    def _cached_token(self) -> Optional[str]:
        if (
            self._access_token
            and time.monotonic() + self.TOKEN_EXPIRY_BUFFER_S < self._expires_at
        ):
            return self._access_token
        return None

    async def get_access_token(self, force: bool = False) -> str:
        """Return a valid token; refresh once under a lock when needed."""
        token = None if force else self._cached_token()
        if token:
            return token

        async with self._refresh_lock:
            token = None if force else self._cached_token()
            if token:
                return token
            await self._refresh_access_token()
            return self._access_token or ""


    # -- request execution ------------------------------------------------

    @staticmethod
    def _parse_json(response: httpx.Response) -> Dict[str, Any]:
        try:
            data = response.json()
            return data if isinstance(data, dict) else {"data": data}
        except ValueError:
            return {"message": response.text[:500]}

    @staticmethod
    def _friendly_error_message(payload: Dict[str, Any], status_code: int) -> str:
        message = str(payload.get("message") or "").strip()
        if message:
            return message
        if status_code == 429:
            return "Zoho CRM rate limit exceeded. Please retry after a short delay."
        if status_code >= 500:
            return "Zoho CRM is unavailable (upstream server error)."
        return f"Zoho CRM returned an error (HTTP {status_code})."

    async def _request(
        self,
        method: str,
        url_path: str,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Perform an authenticated call, retrying once on invalid tokens."""
        await self.start()
        token = await self.get_access_token()
        headers = {"Authorization": f"Zoho-oauthtoken {token}"}

        try:
            response = await self._client.request(
                method,
                url_path,
                params=params,
                json=json_body,
                headers=headers,
            )
        except httpx.HTTPError as exc:
            raise CRMServiceError(
                f"Zoho CRM request failed: {exc}",
                status_code=502,
                code="CRM_NETWORK_ERROR",
                details=str(exc),
            ) from exc

        # A rejected access token invalidates the cache; refresh once and retry.
        if response.status_code == 401 and self._is_invalid_token(response):
            token = await self.get_access_token(force=True)
            try:
                response = await self._client.request(
                    method,
                    url_path,
                    params=params,
                    json=json_body,
                    headers={"Authorization": f"Zoho-oauthtoken {token}"},
                )
            except httpx.HTTPError as exc:
                raise CRMServiceError(
                    f"Zoho CRM request failed on retry: {exc}",
                    status_code=502,
                    code="CRM_NETWORK_ERROR",
                    details=str(exc),
                ) from exc

        if response.status_code >= 400:
            payload = self._parse_json(response)
            if self._is_scope_error(response):
                raise CRMServiceError(
                    "The Zoho OAuth token is missing the required scope for this API. "
                    "Regenerate the token with the needed ZohoCRM.* scope, or use a "
                    "supported fallback endpoint.",
                    status_code=403,
                    code="OAUTH_SCOPE_MISMATCH",
                    details=payload.get("details") or payload.get("message"),
                )
            raise CRMServiceError(
                self._friendly_error_message(payload, response.status_code),
                status_code=response.status_code,
                code=str(payload.get("code") or "CRM_API_ERROR"),
                details=payload,
            )

        return self._parse_json(response)

    @staticmethod
    def _is_invalid_token(response: httpx.Response) -> bool:
        text = response.text.lower()
        return "invalid_token" in text or "invalid token" in text

    @staticmethod
    def _is_scope_error(response: httpx.Response) -> bool:
        status = response.status_code
        text = response.text.lower()
        return status == 401 and ("scope" in text or "oauth" in text)


    # -- module resolution ------------------------------------------------

    @staticmethod
    def resolve_module(raw: Optional[str]) -> str:
        key = normalize_module_key(raw)
        if not key:
            raise CRMServiceError(
                f"Unsupported CRM module: {raw or '(none)'}. "
                f"Supported modules: {', '.join(sorted(MODULE_ENDPOINTS))}.",
                status_code=400,
                code="UNSUPPORTED_MODULE",
            )
        return key

    @staticmethod
    def module_label(key: str) -> str:
        return MODULE_LABELS.get(key, key.title().replace("-", " "))

    @staticmethod
    def _to_csv(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, (list, tuple)):
            return ",".join(str(item).strip() for item in value if str(item).strip())
        return ",".join(part.strip() for part in str(value).split(",") if part.strip())

    @staticmethod
    def _sanitize_records(raw: Any) -> List[Dict[str, Any]]:
        if not isinstance(raw, list):
            return []
        return [sanitize_record(record) for record in raw if isinstance(record, dict)]

    # -- data endpoints ----------------------------------------------------

    @staticmethod
    def _owner_field_name(field_name: Any) -> str:
        return str(field_name or "").strip().lower().replace("_", " ").replace("-", " ")

    @staticmethod
    def _is_owner_field(field_name: Any) -> bool:
        normalized = ZohoCRMService._owner_field_name(field_name)
        return normalized in {"owner", "deal owner"}

    async def _resolve_owner_value(self, raw_value: Any) -> Any:
        if raw_value is None:
            return raw_value

        text = str(raw_value).strip()
        if not text:
            return raw_value
        if re.fullmatch(r"\d+", text):
            return text

        users_payload = await self.get_users()
        users = users_payload.get("data") or []
        requested = text.casefold()
        matches: List[str] = []
        for user in users:
            if not isinstance(user, dict):
                continue
            candidates: List[str] = []
            name = user.get("name") or user.get("full_name") or user.get("display_name")
            if name:
                candidates.append(str(name))

            first_name = user.get("first_name")
            last_name = user.get("last_name")
            if first_name:
                candidates.append(str(first_name))
            if last_name:
                candidates.append(str(last_name))
            if first_name and last_name:
                candidates.append(f"{first_name} {last_name}")
            email = user.get("email")
            if email:
                candidates.append(str(email))

            if any(candidate.casefold() == requested for candidate in candidates):
                resolved_id = user.get("id")
                if resolved_id is None and isinstance(user.get("user_id"), (str, int)):
                    resolved_id = user.get("user_id")
                if resolved_id is None:
                    continue
                matches.append(str(resolved_id))

        if len(matches) > 1:
            raise CRMServiceError(
                f"Owner name '{text}' matches multiple Zoho CRM users. Use a user ID or full name.",
                status_code=400,
                code="OWNER_AMBIGUOUS",
                details={"owner": text, "matching_user_ids": matches},
            )
        if matches:
            logger.info("Owner requested: %s", text)
            logger.info("Owner resolved ID: %s", matches[0])
            logger.info("Final CRM criteria: (Owner:equals:%s)", matches[0])
            return matches[0]

        raise CRMServiceError(
            f"No Zoho CRM user matches the owner name '{text}'. Use a valid user name or user ID.",
            status_code=400,
            code="OWNER_NOT_FOUND",
        )

    @staticmethod
    def _parse_filter_payload(raw_filters: Any) -> Any:
        if raw_filters is None:
            return None
        if isinstance(raw_filters, str):
            text = raw_filters.strip()
            if not text:
                return None
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                return raw_filters
            return parsed
        return raw_filters

    async def _resolve_owner_filters(self, raw_filters: Any) -> Any:
        parsed = self._parse_filter_payload(raw_filters)
        if parsed is None:
            return parsed

        if isinstance(parsed, list):
            resolved: List[Dict[str, Any]] = []
            for item in parsed:
                if not isinstance(item, dict):
                    resolved.append(item)
                    continue
                if {"field", "operator", "value"}.issubset(item.keys()):
                    field_name = item.get("field")
                    value = item.get("value")
                    if self._is_owner_field(field_name):
                        if isinstance(value, (list, tuple, set)):
                            item = {**item, "value": [await self._resolve_owner_value(v) for v in value]}
                        else:
                            item = {**item, "value": await self._resolve_owner_value(value)}
                    resolved.append(item)
                else:
                    resolved.append(item)
            return resolved

        if isinstance(parsed, dict):
            if {"field", "operator", "value"}.issubset(parsed.keys()):
                field_name = parsed.get("field")
                value = parsed.get("value")
                if self._is_owner_field(field_name):
                    if isinstance(value, (list, tuple, set)):
                        return {**parsed, "value": [await self._resolve_owner_value(v) for v in value]}
                    return {**parsed, "value": await self._resolve_owner_value(value)}
                return parsed

            resolved: Dict[str, Any] = {}
            for field_name, field_value in parsed.items():
                if self._is_owner_field(field_name):
                    if isinstance(field_value, (list, tuple, set)):
                        resolved[field_name] = [await self._resolve_owner_value(value) for value in field_value]
                    else:
                        resolved[field_name] = await self._resolve_owner_value(field_value)
                else:
                    resolved[field_name] = field_value
            return resolved
        return parsed

    async def query_module(
        self,
        module: str,
        *,
        fields: Any = None,
        ids: Any = None,
        criteria: Optional[str] = None,
        filter: Any = None,
        filters: Any = None,
        page: Optional[int] = None,
        per_page: Optional[int] = None,
        limit: Optional[int] = None,
        sort_by: Optional[str] = None,
        sort_order: Optional[str] = None,
        date_field: Optional[str] = None,
        from_value: Optional[str] = None,
        to_value: Optional[str] = None,
    ) -> Dict[str, Any]:
        """List records from a module (``/search`` when filtering, else list)."""
        key = self.resolve_module(module)
        endpoint = MODULE_ENDPOINTS[key]
        resolved_filter = await self._resolve_owner_filters(filter)
        resolved_filters = await self._resolve_owner_filters(filters)

        params: Dict[str, Any] = {}
        page_value = int(page) if isinstance(page, (int, str)) and str(page).isdigit() and int(page) > 0 else DEFAULT_PAGE
        per_page_value = limit or per_page or 20
        try:
            per_page_value = min(max(int(per_page_value), 1), MAX_PER_PAGE)
        except (TypeError, ValueError):
            per_page_value = MAX_PER_PAGE
        params["page"] = page_value
        params["per_page"] = per_page_value

        fields_csv = self._to_csv(fields)
        if not fields_csv and key not in NO_FIELDS_MODULES:
            fields_csv = ",".join(DEFAULT_FIELDS.get(key, ["id"]))
        if fields_csv:
            params["fields"] = fields_csv
        ids_csv = self._to_csv(ids)
        if ids_csv:
            params["ids"] = ids_csv
        if sort_by:
            params["sort_by"] = str(sort_by)
        if sort_order:
            params["sort_order"] = str(sort_order)

        query = build_criteria(
            criteria=criteria,
            filter=resolved_filter,
            filters=resolved_filters,
            date_field=date_field,
            from_value=from_value,
            to_value=to_value,
        )

        if query:
            payload = await self._request(
                "GET",
                f"{CRM_API_PREFIX}/{endpoint}/search",
                params={**params, "criteria": query},
            )
        else:
            payload = await self._request(
                "GET",
                f"{CRM_API_PREFIX}/{endpoint}",
                params=params,
            )

        raw_records = payload.get("data")
        if raw_records is None and key == "users":
            raw_records = payload.get("users")
        if raw_records is None and key == "organization":
            raw_records = payload.get("org")

        info = payload.get("info") or {}
        records = self._sanitize_records(raw_records)
        return {
            "module": key,
            "label": self.module_label(key),
            "data": records,
            "count": int(info.get("count") or len(records)),
            "page": int(info.get("page") or page_value),
            "per_page": int(info.get("per_page") or per_page_value),
            "more_records": bool(info.get("more_records", False)),
        }

    async def get_count(
        self,
        module: str,
        *,
        criteria: Optional[str] = None,
        filter: Any = None,
        filters: Any = None,
        date_field: Optional[str] = None,
        from_value: Optional[str] = None,
        to_value: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Count matching records via the count API, falling back to COQL."""
        key = self.resolve_module(module)
        endpoint = MODULE_ENDPOINTS[key]
        resolved_filter = await self._resolve_owner_filters(filter)
        resolved_filters = await self._resolve_owner_filters(filters)
        query = build_criteria(
            criteria=criteria,
            filter=resolved_filter,
            filters=resolved_filters,
            date_field=date_field,
            from_value=from_value,
            to_value=to_value,
        )

        try:
            payload = await self._request(
                "GET",
                f"{CRM_API_PREFIX}/{endpoint}/actions/count",
                params={"criteria": query} if query else None,
            )
        except CRMServiceError as exc:
            # COQL is a robust fallback when the count API rejects the query.
            if exc.status_code not in (400, 401, 403):
                raise
            select_query = f"select count(id) as count from {endpoint}"
            if query:
                select_query += f" where {query}"
            payload = await self.coql_query(select_query)
            rows = payload.get("data") or []
            return {
                "module": key,
                "label": self.module_label(key),
                "count": int(rows[0].get("count") or 0) if rows else 0,
            }

        rows = payload.get("data") or []
        return {
            "module": key,
            "label": self.module_label(key),
            "count": int(rows[0].get("count") or 0) if rows else 0,
        }

    async def get_aggregate_count(
        self,
        module: str,
        *,
        criteria: Optional[str] = None,
        filter: Any = None,
        filters: Any = None,
        date_field: Optional[str] = None,
        from_value: Optional[str] = None,
        to_value: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Count records with a server-side COQL aggregate query."""
        key = self.resolve_module(module)
        endpoint = MODULE_ENDPOINTS[key]
        resolved_filter = await self._resolve_owner_filters(filter)
        resolved_filters = await self._resolve_owner_filters(filters)
        query = build_coql_criteria(
            criteria=criteria,
            filter=resolved_filter,
            filters=resolved_filters,
            date_field=date_field,
            from_value=from_value,
            to_value=to_value,
        )
        select_query = f"select count(id) as count from {endpoint}"
        if query:
            select_query += f" where {query}"
        logger.info("Final COQL: %s", select_query)
        payload = await self.coql_query(select_query)
        rows = payload.get("data") or []
        return {
            "module": key,
            "label": self.module_label(key),
            "count": int(rows[0].get("count") or 0) if rows else 0,
        }

    async def get_aggregate(
        self,
        module: str,
        *,
        operation: str,
        field: str,
        group_by: Optional[str] = None,
        criteria: Optional[str] = None,
        filter: Any = None,
        filters: Any = None,
        date_field: Optional[str] = None,
        from_value: Optional[str] = None,
        to_value: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Run a validated server-side COQL aggregate without retrieving records."""
        key = self.resolve_module(module)
        endpoint = MODULE_ENDPOINTS[key]
        operation = str(operation or "").lower()
        allowed_operations = {"sum", "avg", "min", "max", "count"}
        if operation not in allowed_operations:
            raise CRMServiceError(
                f"Unsupported aggregate operation: {operation}.",
                status_code=400,
                code="INVALID_AGGREGATE_OPERATION",
            )

        allowed_fields = set(DEFAULT_FIELDS.get(key, [])) | {"id"}
        if field not in allowed_fields:
            raise CRMServiceError(
                f"Field '{field}' is not supported for aggregate queries on {key}.",
                status_code=400,
                code="INVALID_AGGREGATE_FIELD",
            )
        if group_by and group_by not in allowed_fields:
            raise CRMServiceError(
                f"Group field '{group_by}' is not supported for {key}.",
                status_code=400,
                code="INVALID_GROUP_FIELD",
            )

        resolved_filter = await self._resolve_owner_filters(filter)
        resolved_filters = await self._resolve_owner_filters(filters)
        query = build_coql_criteria(
            criteria=criteria,
            filter=resolved_filter,
            filters=resolved_filters,
            date_field=date_field,
            from_value=from_value,
            to_value=to_value,
        )
        expression = f"{operation}({field}) as value"
        select_query = f"select {group_by + ', ' if group_by else ''}{expression} from {endpoint}"
        if query:
            select_query += f" where {query}"
        if group_by:
            select_query += f" group by {group_by}"
        logger.info("[AGGREGATE QUERY] %s", select_query)
        payload = await self.coql_query(select_query)
        rows = payload.get("data") or []
        return {
            "module": key,
            "label": self.module_label(key),
            "operation": operation,
            "field": field,
            "group_by": group_by,
            "rows": rows if isinstance(rows, list) else [],
            "criteria": query,
        }

    async def get_lead_conversion_metrics(
        self,
        *,
        from_value: str,
        to_value: str,
    ) -> Dict[str, Any]:
        """Count created leads and Lead-conversion Deals for one time range."""
        logger.info("[METRIC QUERY] leads created and converted to deals")
        logger.info("[DATE RANGE] from=%s to=%s", from_value, to_value)
        leads = await self.get_aggregate_count(
            "leads",
            date_field="Created_Time",
            from_value=from_value,
            to_value=to_value,
        )
        converted_deals = await self.get_aggregate_count(
            "deals",
            date_field=DEAL_CONVERSION_TIME_FIELD,
            from_value=from_value,
            to_value=to_value,
        )
        leads_created = leads["count"]
        converted_count = converted_deals["count"]
        rate = round((converted_count / leads_created) * 100, 2) if leads_created else 0.0
        logger.info("[LEADS COUNT] %s", leads_created)
        logger.info("[CONVERTED TO DEALS COUNT] %s", converted_count)
        logger.info("[CONVERSION RATE] %s%%", rate)
        return {
            "leads_created": leads_created,
            "converted_deals": converted_count,
            "conversion_rate": rate,
            "date_range": {"from": from_value, "to": to_value},
        }

    async def coql_query(self, select_query: str) -> Dict[str, Any]:
        """Run a Zoho COQL ``select_query`` (used as the count fallback)."""
        if not select_query or not str(select_query).strip():
            raise CRMServiceError(
                "A non-empty select_query is required for COQL.",
                status_code=400,
                code="INVALID_COQL",
            )
        return await self._request(
            "POST",
            f"{CRM_API_PREFIX}/coql",
            json_body={"select_query": str(select_query).strip()},
        )

    # -- metadata endpoints -------------------------------------------------

    async def get_users(self) -> Dict[str, Any]:
        """Fetch all CRM users (``type=AllUsers``)."""
        payload = await self._request(
            "GET",
            f"{CRM_API_PREFIX}/users",
            params={"type": "AllUsers"},
        )
        users = payload.get("users") or payload.get("data") or []
        return {
            "module": "users",
            "label": "Users",
            "data": self._sanitize_records(users),
            "count": len(users) if isinstance(users, list) else 0,
        }

    async def get_org(self) -> Dict[str, Any]:
        """Fetch organization details."""
        payload = await self._request("GET", f"{CRM_API_PREFIX}/org")
        orgs = payload.get("org") or payload.get("data") or []
        return {
            "module": "organization",
            "label": "Organization",
            "data": self._sanitize_records(orgs),
            "count": len(orgs) if isinstance(orgs, list) else 0,
        }

    async def get_field_metadata(self, module: str) -> Dict[str, Any]:
        """Fetch field names for a module (``/settings/fields``)."""
        key = self.resolve_module(module)
        endpoint = MODULE_ENDPOINTS[key]
        payload = await self._request(
            "GET",
            f"{CRM_API_PREFIX}/settings/fields",
            params={"module": endpoint},
        )
        fields = payload.get("fields") or []
        field_names = [
            str(field.get("api_name"))
            for field in fields
            if isinstance(field, dict) and field.get("api_name")
        ]

    # -- activity report ----------------------------------------------------

    async def _create_audit_export_job(
        self,
        from_value: str,
        to_value: str,
        *,
        user_id: Optional[str] = None,
        module: Optional[str] = None,
        action: Optional[str] = None,
    ) -> str:
        """Submit an audit-log export job; returns the Zoho ``job id``."""
        criteria_group: Dict[str, Any] = {
            "group": [
                {
                    "field": {"api_name": "audited_time"},
                    "comparator": "between",
                    "value": [from_value, to_value],
                }
            ],
            "group_operator": "and",
        }
        if user_id:
            criteria_group["group"].append(
                {"field": {"api_name": "done_by"}, "comparator": "equal", "value": user_id}
            )
        if module and module != "all":
            criteria_group["group"].append(
                {"field": {"api_name": "module"}, "comparator": "equal", "value": module}
            )
        if action and action != "all":
            criteria_group["group"].append(
                {"field": {"api_name": "action"}, "comparator": "equal", "value": action}
            )

        payload = await self._request(
            "POST",
            f"{CRM_API_PREFIX}/settings/audit_log_export",
            json_body={"audit_log_export": [{"criteria": criteria_group}]},
        )
        jobs = payload.get("audit_log_export") or []
        job_id = jobs[0].get("id") if isinstance(jobs[0], dict) else None
        if not job_id:
            raise CRMServiceError(
                "Zoho audit log export API did not return a job ID.",
                status_code=500,
                code="AUDIT_EXPORT_NO_JOB",
            )
        return str(job_id)

    async def _poll_audit_export_job(self, job_id: str) -> Dict[str, Any]:
        """Poll the export job until it completes, fails, or times out."""
        for _ in range(EXPORT_MAX_POLLS):
            await asyncio.sleep(EXPORT_POLL_MS)
            payload = await self._request(
                "GET",
                f"{CRM_API_PREFIX}/settings/audit_log_export/{job_id}",
            )
            jobs = payload.get("audit_log_export") or []
            job = jobs[0] if isinstance(jobs, list) and jobs else {}
            status = str(job.get("status") or "").lower()
            if status in ("completed", "finished"):
                return {"status": status, "download_url": job.get("download_url")}
            if status in ("failed", "error"):
                raise CRMServiceError(
                    f"Zoho audit log export job failed with status: {job.get('status')}",
                    status_code=500,
                    code="AUDIT_EXPORT_FAILED",
                    details=job,
                )
        raise CRMServiceError(
            f"Zoho audit log export job timed out after "
            f"{EXPORT_MAX_POLLS * EXPORT_POLL_MS:.0f} seconds.",
            status_code=504,
            code="AUDIT_EXPORT_TIMEOUT",
        )

    async def _download_and_parse_csv(self, download_url: str) -> List[Dict[str, Any]]:
        """Download the exported CSV and parse it into flat row dicts."""
        if not download_url:
            raise CRMServiceError(
                "Zoho audit log export completed without a download URL.",
                status_code=500,
                code="AUDIT_EXPORT_NO_DOWNLOAD",
            )
        await self.start()
        try:
            response = await self._client.get(download_url)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise CRMServiceError(
                f"Failed to download the audit log export: {exc}",
                status_code=502,
                code="CRM_NETWORK_ERROR",
            ) from exc


    @staticmethod
    def _record_display_name(record: Dict[str, Any]) -> str:
        for field in (
            "Deal_Name",
            "First_Name",
            "Last_Name",
            "Subject",
            "Account_Name",
            "Product_Name",
            "Title",
            "Vendor_Name",
            "Solution_Title",
            "id",
        ):
            value = record.get(field)
            if isinstance(value, dict):
                value = value.get("name")
            if value:
                return str(value)
        return ""

    async def _activity_from_module_search(
        self,
        from_value: str,
        to_value: str,
        *,
        user_id: Optional[str] = None,
        module: Optional[str] = "all",
        action: Optional[str] = None,
        limit: int = 200,
        timezone_name: str = DEFAULT_TIMEZONE,
    ) -> List[Dict[str, Any]]:
        """Fallback activity feed built from per-module record searches."""
        modules = ACTIVITY_MODULES if not module or module == "all" else [module]
        items: List[Dict[str, Any]] = []

        for module_key in modules:
            if len(items) >= limit:
                break
            if module_key not in MODULE_ENDPOINTS:
                continue
            try:
                result = await self.query_module(
                    module_key,
                    date_field="Modified_Time",
                    from_value=from_value,
                    to_value=to_value,
                    per_page=min(limit, MAX_PER_PAGE),
                )
            except CRMServiceError:
                continue

            for record in result["data"]:
                if len(items) >= limit:
                    break
                created_by = record.get("Created_By") or record.get("Owner") or {}
                user_name = (
                    created_by.get("name") if isinstance(created_by, dict) else created_by
                ) or "Unknown User"
                items.append(
                    {
                        "user_id": (
                            str(created_by.get("id"))
                            if isinstance(created_by, dict) and created_by.get("id")
                            else None
                        ),
                        "user_name": user_name,
                        "module": result["label"],
                        "module_api_name": MODULE_ENDPOINTS[module_key],
                        "record_id": str(record.get("id") or ""),
                        "record_name": self._record_display_name(record),
                        "action": action or "updated",
                        "activity_type": module_key,
                        "time": record.get("Modified_Time"),
                        "source": "crm_ui",
                    }
                )
        return items[:limit]

    async def get_activity(
        self,
        *,
        module: Optional[str] = "all",
        user_id: Optional[str] = None,
        from_value: Optional[str] = None,
        to_value: Optional[str] = None,
        action: Optional[str] = None,
        limit: int = 200,
        timezone_name: str = DEFAULT_TIMEZONE,
    ) -> Dict[str, Any]:
        """Activity report: audit-log export with a record-search fallback.

        When the OAuth token lacks the ``ZohoCRM.settings.audit_logs.*``
        scope the export APIs raise ``OAUTH_SCOPE_MISMATCH`` and the report
        transparently degrades to per-module searches so the agent still gets
        useful data instead of a hard failure.
        """
        today = _today_range(timezone_name)
        from_value = from_value or today["from"]
        to_value = to_value or today["to"]
        start_ist = _to_ist_string(from_value, timezone_name)
        end_ist = _to_ist_string(to_value, timezone_name)

        try:
            job_id = await self._create_audit_export_job(
                start_ist,
                end_ist,
                user_id=user_id,
                module=module,
                action=action,
            )
            job = await self._poll_audit_export_job(job_id)
            rows = await self._download_and_parse_csv(job.get("download_url") or "")
            return {
                "module": module,
                "count": len(rows),
                "activities": rows[: max(limit, 0)],
                "strategy": "audit_log_export",
            }
        except CRMServiceError as exc:
            if exc.code not in ("OAUTH_SCOPE_MISMATCH", "ZOHO_AUTHENTICATION_ERROR"):
                raise

        items = await self._activity_from_module_search(
            start_ist,
            end_ist,
            user_id=user_id,
            module=module,
            action=action,
            limit=limit,
            timezone_name=timezone_name,
        )
        return {
            "module": module,
            "count": len(items),
            "activities": items,
            "strategy": "module_search",
        }


# ---------------------------------------------------------------------------
# Module-level singleton (initialized/closed by the FastAPI lifespan)
# ---------------------------------------------------------------------------
zoho_service = ZohoCRMService()






