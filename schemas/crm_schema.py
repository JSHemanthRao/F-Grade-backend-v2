"""
schemas/crm_schema.py
---------------------
Pydantic models for every request/response the middleware exposes, plus the
record sanitizer that turns verbose Zoho CRM payloads into lightweight flat
JSON objects.

Zoho returns records that are heavy with metadata: nested lookup objects
(``Owner: {"name": ..., "id": ..., "email": ...}``), ``$``-prefixed review
state, internal system IDs and timestamps. ``sanitize_record`` strips that
noise so the Corporate Studio agent only ever receives clean, flat business
data.
"""

from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Sanitization
# ---------------------------------------------------------------------------

# Keys that are pure framework/review metadata and never belong in agent data.
_DROPPED_KEY_PREFIXES = ("$", "@", "internal_")
_DROPPED_KEY_SUFFIXES = ("_review_process",)


def _should_drop_key(key: str) -> bool:
    lowered = key.lower()
    return (
        lowered.startswith(_DROPPED_KEY_PREFIXES)
        or lowered.endswith(_DROPPED_KEY_SUFFIXES)
    )


def _sanitize_value(value: Any) -> Any:
    """Collapse nested Zoho structures into flat, agent-friendly values."""
    if isinstance(value, dict):
        # Lookup/reference objects ("Owner", "Account_Name", "Created_By", ...)
        # collapse to their display label (or id when no label exists).
        if "name" in value or "value" in value:
            return value.get("name") or value.get("value") or value.get("id")
        return sanitize_record(value)
    if isinstance(value, (list, tuple)):
        return [_sanitize_value(item) for item in value]
    return value


def sanitize_record(raw: Any) -> Dict[str, Any]:
    """Reduce one raw Zoho record to a flat dict of business fields only.

    The record ``id`` is preserved at the top level; everything else is a
    scalar, a flattened label, or a simple list of scalars.
    """
    if not isinstance(raw, dict):
        return {}

    clean: Dict[str, Any] = {}
    for key, value in raw.items():
        if _should_drop_key(key):
            continue
        if key in ("id", "ID"):
            clean["id"] = str(value) if value is not None else None
            continue
        clean[str(key)] = _sanitize_value(value)
    return clean


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class CRMRecord(BaseModel):
    """A single sanitized CRM record.

    Business fields are attached as extra attributes so the serialized JSON
    stays flat (``{"id": ..., "First_Name": ...}``) instead of wrapping the
    payload in a generic ``fields`` container.
    """

    model_config = ConfigDict(extra="allow")

    id: Optional[str] = None


class QueryResponse(BaseModel):
    """Standard list response handed back to the Corporate Studio agent."""

    success: bool = True
    module: str
    count: int = 0
    page: int = 1
    per_page: int = 0
    execution_time_ms: Optional[float] = None
    source: str = "Zoho CRM"
    data: List[CRMRecord] = Field(default_factory=list)


class CountResponse(BaseModel):
    """Count-only response (avoids shipping full records)."""

    success: bool = True
    module: str
    count: int = 0
    execution_time_ms: Optional[float] = None
    source: str = "Zoho CRM"


class ActivityItem(BaseModel):
    """A flattened activity/audit event."""

    user_id: Optional[str] = None
    user_name: Optional[str] = None
    module: Optional[str] = None
    module_api_name: Optional[str] = None
    record_id: Optional[str] = None
    record_name: Optional[str] = None
    action: Optional[str] = None
    activity_type: Optional[str] = None
    time: Optional[str] = None
    source: Optional[str] = None
    field: Optional[str] = None
    old_value: Optional[Any] = None
    new_value: Optional[Any] = None


class ActivityResponse(BaseModel):
    """Response for the ``/activity`` report endpoint."""

    success: bool = True
    module: Optional[str] = "all"
    count: int = 0
    activities: List[ActivityItem] = Field(default_factory=list)
    execution_time_ms: Optional[float] = None
    source: str = "Zoho CRM"


class ErrorResponse(BaseModel):
    """Uniform JSON error body. Failures never crash the process."""

    success: bool = False
    error: Dict[str, Any] = Field(default_factory=dict)
    source: str = "Zoho CRM"


class AssistantResponse(BaseModel):
    """Natural-language assistant response."""

    success: bool = True
    question: str
    intent: str
    request_type: Optional[str] = None
    module: Optional[str] = None
    criteria: List[Dict[str, Any]] = Field(default_factory=list)
    summary: Dict[str, Any] = Field(default_factory=dict)
    metrics: Dict[str, Any] = Field(default_factory=dict)
    count: int = 0
    message: Optional[str] = None
    leads_created: Optional[int] = None
    converted_deals: Optional[int] = None
    conversion_rate: Optional[float] = None
    date_range: Optional[Dict[str, str]] = None
    data: List[CRMRecord] = Field(default_factory=list)
    pagination: Dict[str, Any] = Field(default_factory=dict)
    calculations: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    execution_time_ms: Optional[float] = None
    source: str = "Zoho CRM"


# ---------------------------------------------------------------------------
# Request models (strict validation before anything reaches Zoho)
# ---------------------------------------------------------------------------

class QueryRequest(BaseModel):
    """Read-only record query. Mirrors the Node ``/query`` contract."""

    module: str = Field(..., min_length=1, description="CRM module key, e.g. leads, deals, contacts.")
    fields: Optional[Union[str, List[str]]] = None
    ids: Optional[Union[str, List[str]]] = None
    criteria: Optional[str] = None
    filter: Optional[Any] = None
    filters: Optional[Any] = None
    page: Optional[int] = Field(default=None, ge=1)
    per_page: Optional[int] = Field(default=None, ge=1, le=200)
    limit: Optional[int] = Field(default=None, ge=1, le=200)
    sort_by: Optional[str] = None
    sort_order: Optional[str] = None
    date_field: Optional[str] = None
    from_: Optional[str] = Field(default=None, alias="from", description="Inclusive start date (ISO or date-only).")
    to: Optional[str] = None
    search: Optional[str] = None

    model_config = ConfigDict(populate_by_name=True)


class CountRequest(BaseModel):
    """Count query — pagination is deliberately rejected."""

    module: str = Field(..., min_length=1, description="CRM module key, e.g. leads, deals, contacts.")
    criteria: Optional[str] = None
    filter: Optional[Any] = None
    filters: Optional[Any] = None
    date_field: Optional[str] = None
    from_: Optional[str] = Field(default=None, alias="from")
    to: Optional[str] = None
    search: Optional[str] = None

    model_config = ConfigDict(populate_by_name=True)


class ActivityRequest(BaseModel):
    """Parameters for the activity report endpoint."""

    module: Optional[str] = "all"
    user_id: Optional[str] = None
    from_: Optional[str] = Field(default=None, alias="from")
    to: Optional[str] = None
    action: Optional[str] = None
    limit: Optional[int] = Field(default=200, ge=1, le=500)
    timezone: Optional[str] = "Asia/Kolkata"

    model_config = ConfigDict(populate_by_name=True)


class AssistantRequest(BaseModel):
    """Body accepted by ``POST /api/crm/assistant``."""

    question: Optional[str] = None
    prompt: Optional[str] = None
    message: Optional[str] = None

    @property
    def query_text(self) -> str:
        return next(
            (
                text.strip()
                for text in (self.question, self.prompt, self.message)
                if text and text.strip()
            ),
            "",
        )
