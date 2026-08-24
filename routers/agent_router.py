"""
routers/agent_router.py
-----------------------
Endpoints consumed by the Corporate Studio agent.

Mounted at ``/api/crm`` (see ``main.py``) to preserve the original backend's
URL contract: ``/api/crm/query``, ``/api/crm/count``, ``/api/crm/activity``,
``/api/crm/assistant`` plus dynamic ``/api/crm/{module}`` record access.
Every handler catches ``CRMServiceError`` and returns a clean JSON error body.
"""

import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Query
from fastapi.responses import JSONResponse

from schemas.crm_schema import (
    ActivityRequest,
    ActivityResponse,
    AssistantRequest,
    AssistantResponse,
    CountRequest,
    CountResponse,
    ErrorResponse,
    QueryRequest,
    QueryResponse,
)
from services.crm_service import (
    CRMServiceError,
    MODULE_ENDPOINTS,
    safe_tz,
    zoho_service,
)

router = APIRouter(tags=["crm"])

DEFAULT_TIMEZONE = "Asia/Kolkata"


def _error_response(exc: CRMServiceError) -> JSONResponse:
    """Uniform JSON error response for any CRM failure."""
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(error=exc.to_dict()).model_dump(),
    )


def _elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 2)


# ---------------------------------------------------------------------------
# /query
# ---------------------------------------------------------------------------

async def _run_query(payload: Dict[str, Any]) -> QueryResponse:
    start = time.perf_counter()
    result = await zoho_service.query_module(**payload)
    return QueryResponse(
        module=result["label"],
        count=result["count"],
        page=result["page"],
        per_page=result["per_page"],
        execution_time_ms=_elapsed_ms(start),
        data=result["data"],
    )


@router.get(
    "/query",
    response_model=QueryResponse,
    summary="Query CRM module records (GET)",
    description="Read-only record retrieval. Use `criteria`, `filter`, or a "
    "`from`/`to` + `date_field` range to narrow results.",
)
async def get_query(
    module: str = Query(..., description="CRM module key, e.g. leads, deals, contacts."),
    fields: Optional[str] = Query(None, description="Comma-separated field names."),
    ids: Optional[str] = Query(None, description="Comma-separated record IDs."),
    criteria: Optional[str] = Query(None, description="Raw Zoho criteria string."),
    filter: Optional[str] = Query(None, description='Filter, e.g. {"Stage":"Closed Won"}'),
    filters: Optional[str] = Query(None, alias="filters"),
    page: int = Query(1, ge=1),
    per_page: int = Query(200, ge=1, le=200),
    limit: Optional[int] = Query(None, ge=1, le=200),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    date_field: Optional[str] = Query(None),
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
) -> QueryResponse:
    try:
        return await _run_query(
            {
                "module": module,
                "fields": fields,
                "ids": ids,
                "criteria": criteria,
                "filter": filter,
                "filters": filters,
                "page": page,
                "per_page": per_page,
                "limit": limit,
                "sort_by": sort_by,
                "sort_order": sort_order,
                "date_field": date_field,
                "from_value": from_,
                "to_value": to,
            }
        )
    except CRMServiceError as exc:
        return _error_response(exc)


@router.post(
    "/query",
    response_model=QueryResponse,
    summary="Query CRM module records (POST)",
)
async def post_query(payload: QueryRequest) -> QueryResponse:
    start = time.perf_counter()
    try:
        result = await zoho_service.query_module(
            module=payload.module,
            fields=payload.fields,
            ids=payload.ids,
            criteria=payload.criteria,
            filter=payload.filter,
            filters=payload.filters,
            page=payload.page,
            per_page=payload.per_page,
            limit=payload.limit,
            sort_by=payload.sort_by,
            sort_order=payload.sort_order,
            date_field=payload.date_field,
            from_value=payload.from_,
            to_value=payload.to,
        )
        return QueryResponse(
            module=result["label"],
            count=result["count"],
            page=result["page"],
            per_page=result["per_page"],
            execution_time_ms=_elapsed_ms(start),
            data=result["data"],
        )
    except CRMServiceError as exc:
        return _error_response(exc)


# ---------------------------------------------------------------------------
# /count
# ---------------------------------------------------------------------------

@router.get(
    "/count",
    response_model=CountResponse,
    summary="Count CRM module records (GET)",
)
async def get_count(
    module: str = Query(..., description="CRM module key, e.g. leads, deals, contacts."),
    criteria: Optional[str] = Query(None),
    filter: Optional[str] = Query(None),
    filters: Optional[str] = Query(None, alias="filters"),
    date_field: Optional[str] = Query(None),
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
) -> CountResponse:
    start = time.perf_counter()
    try:
        result = await zoho_service.get_count(
            module=module,
            criteria=criteria,
            filter=filter,
            filters=filters,
            date_field=date_field,
            from_value=from_,
            to_value=to,
        )
        return CountResponse(
            module=result["label"],
            count=result["count"],
            execution_time_ms=_elapsed_ms(start),
        )
    except CRMServiceError as exc:
        return _error_response(exc)


@router.post(
    "/count",
    response_model=CountResponse,
    summary="Count CRM module records (POST)",
)
async def post_count(payload: CountRequest) -> CountResponse:
    start = time.perf_counter()
    try:
        result = await zoho_service.get_count(
            module=payload.module,
            criteria=payload.criteria,
            filter=payload.filter,
            filters=payload.filters,
            date_field=payload.date_field,
            from_value=payload.from_,
            to_value=payload.to,
        )
        return CountResponse(
            module=result["label"],
            count=result["count"],
            execution_time_ms=_elapsed_ms(start),
        )
    except CRMServiceError as exc:
        return _error_response(exc)


# ---------------------------------------------------------------------------
# /activity
# ---------------------------------------------------------------------------

async def _run_activity(payload: Dict[str, Any]) -> ActivityResponse:
    start = time.perf_counter()
    result = await zoho_service.get_activity(**payload)
    return ActivityResponse(
        module=result["module"],
        count=result["count"],
        activities=result["activities"],
        execution_time_ms=_elapsed_ms(start),
    )


@router.get(
    "/activity",
    response_model=ActivityResponse,
    summary="CRM activity report",
    description="Audit-log export of user activity; degrades to per-module "
    "record searches when the OAuth scope is insufficient.",
)
async def get_activity(
    module: Optional[str] = Query("all"),
    user_id: Optional[str] = Query(None),
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=500),
    timezone: str = Query(DEFAULT_TIMEZONE),
) -> ActivityResponse:
    try:
        return await _run_activity(
            {
                "module": module,
                "user_id": user_id,
                "from_value": from_,
                "to_value": to,
                "action": action,
                "limit": limit,
                "timezone_name": timezone,
            }
        )
    except CRMServiceError as exc:
        return _error_response(exc)


@router.post(
    "/activity",
    response_model=ActivityResponse,
    summary="CRM activity report (POST)",
)
async def post_activity(payload: ActivityRequest) -> ActivityResponse:
    try:
        return await _run_activity(
            {
                "module": payload.module,
                "user_id": payload.user_id,
                "from_value": payload.from_,
                "to_value": payload.to,
                "action": payload.action,
                "limit": payload.limit,
                "timezone_name": payload.timezone,
            }
        )
    except CRMServiceError as exc:
        return _error_response(exc)


# ---------------------------------------------------------------------------
# Metadata conveniences for the agent's tool connector
# ---------------------------------------------------------------------------

@router.get(
    "/modules",
    summary="List supported CRM modules",
)
async def list_modules() -> Dict[str, Any]:
    return {
        "success": True,
        "count": len(MODULE_ENDPOINTS),
        "modules": sorted(MODULE_ENDPOINTS.keys()),
    }


@router.get(
    "/users",
    summary="List CRM users",
)
async def list_users() -> Dict[str, Any]:
    try:
        result = await zoho_service.get_users()
        return {"success": True, "count": result["count"], "data": result["data"]}
    except CRMServiceError as exc:
        return _error_response(exc)


# ---------------------------------------------------------------------------
# /assistant (natural-language entry point used by Corporate Studio)
# ---------------------------------------------------------------------------

_MODULE_KEYWORDS: Dict[str, List[str]] = {
    "deals": ["deal", "deals", "opportunit", "pipeline", "revenue", "closed won", "won deal"],
    "leads": ["lead", "leads", "prospect"],
    "contacts": ["contact", "contacts"],
    "accounts": ["account", "accounts", "customer", "company"],
    "tasks": ["task", "tasks"],
    "calls": ["call", "calls", "call log"],
    "events": ["event", "events", "appointment"],
    "meetings": ["meeting", "meetings"],
    "notes": ["note", "notes"],
    "products": ["product", "products"],
    "vendors": ["vendor", "vendors", "supplier"],
    "cases": ["case", "cases", "support ticket"],
    "quotes": ["quote", "quotes", "quotation"],
    "campaigns": ["campaign", "campaigns"],
}

_COUNT_HINTS = (
    "how many",
    "count of",
    "count ",
    "total number",
    "number of",
    "total count",
    "how much revenue",
    "sum of",
    "aggregate",
)


def _resolve_date_range(text: str, timezone_name: str = DEFAULT_TIMEZONE) -> Optional[Dict[str, str]]:
    """Map a relative time phrase to a Zoho-friendly from/to pair."""
    lowered = text.lower()
    tz = safe_tz(timezone_name)
    now = datetime.now(tz)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow = day_start + timedelta(days=1)

    def iso_range(start: datetime, end: datetime) -> Dict[str, str]:
        return {
            "from": start.isoformat(timespec="seconds"),
            "to": end.isoformat(timespec="seconds"),
        }

    if "last 7 days" in lowered or "past 7 days" in lowered:
        return iso_range(now - timedelta(days=7), tomorrow)
    if "last 30 days" in lowered or "past 30 days" in lowered:
        return iso_range(now - timedelta(days=30), tomorrow)
    if "last 90 days" in lowered or "past 90 days" in lowered:
        return iso_range(now - timedelta(days=90), tomorrow)
    if "today" in lowered:
        return iso_range(day_start, tomorrow)
    if "yesterday" in lowered:
        return iso_range(day_start - timedelta(days=1), day_start)
    if "last week" in lowered:
        week_start = day_start - timedelta(days=day_start.weekday() + 7)
        return iso_range(week_start, week_start + timedelta(days=7))
    if "this week" in lowered:
        week_start = day_start - timedelta(days=day_start.weekday())
        return iso_range(week_start, tomorrow)
    if "last month" in lowered:
        first_this_month = day_start.replace(day=1)
        last_month_start = (first_this_month - timedelta(days=1)).replace(day=1)
        return iso_range(last_month_start, first_this_month)
    if "this month" in lowered:
        return iso_range(day_start.replace(day=1), tomorrow)
    if "last quarter" in lowered:
        quarter_month = ((now.month - 1) // 3) * 3 + 1
        first_this_quarter = day_start.replace(month=quarter_month, day=1)
        last_quarter_start = (first_this_quarter - timedelta(days=1)).replace(day=1)
        return iso_range(last_quarter_start, first_this_quarter)
    if "this quarter" in lowered:
        quarter_month = ((now.month - 1) // 3) * 3 + 1
        return iso_range(day_start.replace(month=quarter_month, day=1), tomorrow)
    if "last year" in lowered:
        year_start = day_start.replace(year=now.year - 1, month=1, day=1)
        return iso_range(year_start, day_start.replace(year=now.year, month=1, day=1))
    if "year to date" in lowered or "ytd" in lowered or "this year" in lowered:
        return iso_range(day_start.replace(month=1, day=1), tomorrow)
    return None


def _resolve_assistant_plan(question: str) -> Dict[str, Any]:
    lowered = question.lower()
    intent = "count" if any(hint in lowered for hint in _COUNT_HINTS) else "query"

    asks_for_lead_deal_relationship = (
        "lead" in lowered
        and ("converted" in lowered or "conversion" in lowered)
        and ("closed won" in lowered or "won deal" in lowered or "deal" in lowered)
    )

    module = None
    for candidate, keywords in _MODULE_KEYWORDS.items():
        if any(keyword in lowered for keyword in keywords):
            module = candidate
            break

    date_field = None
    date_range = _resolve_date_range(question)
    if module == "deals" and ("won" in lowered or "closed" in lowered):
        date_field = "Closing_Date"
    elif date_range:
        date_field = "Created_Time"

    filters = None
    limitation = None
    if asks_for_lead_deal_relationship:
        # The exposed fields do not include a lead-origin lookup on Deals.
        limitation = (
            "Zoho CRM cannot represent the lead-to-deal conversion relationship "
            "with the fields currently exposed. I cannot accurately count leads "
            "that became Closed Won deals from this endpoint."
        )
    elif module == "deals" and ("won" in lowered or "closed" in lowered):
        filters = [{"field": "Stage", "operator": "equals", "value": "Closed Won"}]

    return {
        "intent": intent,
        "module": module,
        "date_field": date_field,
        "date_range": date_range,
        "filters": filters,
        "limitation": limitation,
    }


@router.post(
    "/assistant",
    response_model=AssistantResponse,
    summary="Ask a natural-language CRM question",
    description="Accepts `question` (or `prompt`/`message`), resolves the "
    "intent and module, and returns sanitized CRM data.",
)
async def assistant(payload: AssistantRequest) -> AssistantResponse:
    start = time.perf_counter()
    question = payload.query_text
    if not question:
        return _error_response(
            CRMServiceError("A question is required.", status_code=400, code="QUESTION_REQUIRED")
        )

    plan = _resolve_assistant_plan(question)
    if not plan["module"]:
        return AssistantResponse(
            success=False,
            question=question,
            intent=plan["intent"],
            message="Could not determine a CRM module from the question. "
            "Try mentioning leads, deals, contacts, accounts, tasks, calls, or events.",
            execution_time_ms=_elapsed_ms(start),
        )

    if plan["limitation"]:
        return _error_response(
            CRMServiceError(
                plan["limitation"],
                status_code=400,
                code="LEAD_DEAL_RELATIONSHIP_UNSUPPORTED",
            )
        )

    try:
        common = {
            "filters": plan["filters"],
            "date_field": plan["date_field"],
            "from_value": plan["date_range"]["from"] if plan["date_range"] else None,
            "to_value": plan["date_range"]["to"] if plan["date_range"] else None,
        }

        if plan["intent"] == "count":
            result = await zoho_service.get_count(module=plan["module"], **common)
            return AssistantResponse(
                question=question,
                intent="count",
                module=result["label"],
                count=result["count"],
                message=f"Found {result['count']} {result['label'].lower()} in Zoho CRM.",
                execution_time_ms=_elapsed_ms(start),
            )

        result = await zoho_service.query_module(
            module=plan["module"],
            limit=50,
            page=1,
            **common,
        )
        return AssistantResponse(
            question=question,
            intent="query",
            module=result["label"],
            count=result["count"],
            message=f"Retrieved {len(result['data'])} of {result['count']} matching "
            f"{result['label'].lower()} records.",
            data=result["data"],
            execution_time_ms=_elapsed_ms(start),
        )
    except CRMServiceError as exc:
        return _error_response(exc)


# ---------------------------------------------------------------------------
# Dynamic module path (registered last so it never shadows other routes)
# ---------------------------------------------------------------------------

@router.get(
    "/{module}",
    response_model=QueryResponse,
    summary="Query a CRM module by path (GET /api/crm/{module})",
    description="Convenience alias for ``GET /query?module=...``.",
)
async def module_path(
    module: str,
    fields: Optional[str] = Query(None),
    criteria: Optional[str] = Query(None),
    filter: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(200, ge=1, le=200),
    limit: Optional[int] = Query(None, ge=1, le=200),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query(None),
    date_field: Optional[str] = Query(None),
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
) -> QueryResponse:
    try:
        return await _run_query(
            {
                "module": module,
                "fields": fields,
                "criteria": criteria,
                "filter": filter,
                "page": page,
                "per_page": per_page,
                "limit": limit,
                "sort_by": sort_by,
                "sort_order": sort_order,
                "date_field": date_field,
                "from_value": from_,
                "to_value": to,
            }
        )
    except CRMServiceError as exc:
        return _error_response(exc)



