"""Temporary smoke test for the FastAPI middleware (deleted after validation)."""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi.testclient import TestClient

from main import app
from schemas.crm_schema import sanitize_record, CRMRecord
from services.crm_service import build_criteria, normalize_module_key

failures = []


def check(name, condition, extra=""):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name} {extra}")
    if not condition:
        failures.append(name)


with TestClient(app) as client:
    # 1. Health
    r = client.get("/health")
    check("GET /health", r.status_code == 200 and r.json() == {"status": "ok"}, r.text)
    r = client.get("/")
    check("GET /", r.status_code == 200 and r.json()["status"] == "ok")

    # 2. Modules
    r = client.get("/api/crm/modules")
    check("GET /api/crm/modules", r.status_code == 200 and r.json()["count"] == 25)
    check("modules contain deals", "deals" in r.json()["modules"])

    # 3. Unknown module -> 400 JSON error
    r = client.get("/api/crm/query", params={"module": "bogus-module"})
    check(
        "GET /query unknown module -> 400",
        r.status_code == 400 and r.json()["success"] is False,
        r.text,
    )

    # 4. Assistant without question -> 400
    r = client.post("/api/crm/assistant", json={})
    check(
        "POST /assistant no question -> 400",
        r.status_code == 400 and r.json()["error"]["code"] == "QUESTION_REQUIRED",
        r.text,
    )

    # 5. POST /query unknown module -> 400
    r = client.post("/api/crm/query", json={"module": "nope"})
    check("POST /query unknown module -> 400", r.status_code == 400, r.text)

    # 6. GET /query validation (negative page rejected by pydantic ge=1)
    r = client.get("/api/crm/query", params={"module": "deals", "page": 0})
    check("GET /query bad page -> 422", r.status_code == 422, r.text)

# 7. Sanitization unit checks
raw = {
    "id": "1001",
    "$state": "irreversible",
    "$review_process": {"x": 1},
    "First_Name": "Ada",
    "Last_Name": "Lovelace",
    "Owner": {"name": "Alan T.", "id": "999", "email": "alan@corp.com"},
    "Account_Name": {"name": "Analytical Engines", "id": "77"},
    "Created_By": {"name": "Charles B.", "id": "5", "email": "c@corp.com"},
    "Tags": ["a", "b"],
    "Email_Opt_Out": False,
    "id": "1001",
}
clean = sanitize_record(raw)
check("sanitize drops $state", "$state" not in clean)
check("sanitize drops $review_process", "$review_process" not in clean)
check("sanitize keeps id", clean.get("id") == "1001")
check("sanitize flattens Owner", clean.get("Owner") == "Alan T.")
check("sanitize flattens Account_Name", clean.get("Account_Name") == "Analytical Engines")
check("sanitize keeps scalar bool", clean.get("Email_Opt_Out") is False)

record = CRMRecord(**clean)
dump = record.model_dump()
check("CRMRecord serializes flat", dump.get("First_Name") == "Ada" and dump.get("Owner") == "Alan T.")

# 8. Criteria builder unit checks
crit = build_criteria(
    criteria="(Stage:equals:Closed Won)",
    filter={"Owner": "123"},
    date_field="Closing_Date",
    from_value="2026-08-01",
    to_value="2026-09-01",
)
check(
    "build_criteria merges parts",
    "(Stage:equals:Closed Won)" in crit
    and "(Owner:equals:123)" in crit
    and "(Closing_Date:greater_equal:2026-08-01T00:00:00+05:30)" in crit,
    crit,
)

# 8b. Owner-name filters resolve to Zoho user IDs before the CRM search runs.
from services.crm_service import ZohoCRMService

async def run_owner_resolution_check():
    service = ZohoCRMService()
    seen = []

    async def fake_request(method, url_path, params=None, json_body=None):
        seen.append((method, url_path, params, json_body))
        if url_path == "/crm/v8/users":
            return {"users": [{"id": "user-42", "first_name": "Laya", "last_name": "K"}]}
        if url_path == "/crm/v8/Deals/search":
            assert "Owner:equals:user-42" in (params or {}).get("criteria", "")
            return {"data": [{"id": "d-1", "Deal_Name": "Test deal"}], "info": {"count": 1}}
        raise AssertionError(f"unexpected request: {method} {url_path}")

    service._request = fake_request
    result = await service.query_module(
        "deals",
        fields="Deal_Name,Stage",
        filters=[
            {"field": "Stage", "operator": "equals", "value": "Closed Won"},
            {"field": "Owner", "operator": "equals", "value": "Laya"},
        ],
        page=1,
        per_page=10,
    )
    query_criteria = next((params.get("criteria") for _, _, params, _ in seen if params and "criteria" in params), "")
    check("owner filter resolves to Zoho user ID", result["data"][0]["id"] == "d-1" and result["count"] == 1, result)
    check("final criteria uses resolved user id", "Owner:equals:user-42" in query_criteria and "Owner:equals:Laya" not in query_criteria, query_criteria)
    check("owner lookup calls users API before CRM query", any(url == "/crm/v8/users" for _, url, _, _ in seen), seen)

import asyncio
asyncio.run(run_owner_resolution_check())

async def run_ambiguous_owner_check():
    service = ZohoCRMService()

    async def fake_request(method, url_path, params=None, json_body=None):
        return {
            "users": [
                {"id": "user-1", "first_name": "Alex", "last_name": "K"},
                {"id": "user-2", "first_name": "Alex", "last_name": "P"},
            ]
        }

    service._request = fake_request
    try:
        await service._resolve_owner_value("Alex")
    except Exception as exc:
        check("ambiguous owner returns explicit error", getattr(exc, "code", None) == "OWNER_AMBIGUOUS", exc)
    else:
        check("ambiguous owner returns explicit error", False)

asyncio.run(run_ambiguous_owner_check())

async def run_aggregate_count_check():
    service = ZohoCRMService()
    seen = []

    async def fake_request(method, url_path, params=None, json_body=None):
        seen.append((method, url_path, params, json_body))
        if url_path == "/crm/v8/coql":
            assert json_body["select_query"].startswith("select count(id) as count from Deals")
            assert "Stage = 'Closed Won'" in json_body["select_query"]
            return {"data": [{"count": 7}]}
        raise AssertionError(f"unexpected request: {method} {url_path}")

    service._request = fake_request
    result = await service.get_aggregate_count(
        "deals",
        filters=[{"field": "Stage", "operator": "equals", "value": "Closed Won"}],
    )
    check("aggregate count uses COQL", result["count"] == 7 and len(seen) == 1, seen)

asyncio.run(run_aggregate_count_check())

async def run_aggregate_analysis_check():
    service = ZohoCRMService()
    seen = []

    async def fake_request(method, url_path, params=None, json_body=None):
        seen.append(json_body["select_query"])
        return {"data": [{"Owner": {"name": "Laya"}, "value": 125000}]}

    service._request = fake_request
    result = await service.get_aggregate(
        "deals",
        operation="sum",
        field="Amount",
        group_by="Owner",
        filters=[{"field": "Stage", "operator": "equals", "value": "Closed Won"}],
    )
    check(
        "grouped aggregate uses server-side sum",
        result["rows"][0]["value"] == 125000
        and "sum(Amount) as value" in seen[0]
        and "group by Owner" in seen[0]
        and "Stage = 'Closed Won'" in seen[0],
        seen,
    )

asyncio.run(run_aggregate_analysis_check())

async def run_lead_conversion_metrics_check():
    service = ZohoCRMService()
    seen = []

    async def fake_request(method, url_path, params=None, json_body=None):
        seen.append(json_body["select_query"])
        if "from Leads" in json_body["select_query"]:
            return {"data": [{"count": 20}]}
        if "from Deals" in json_body["select_query"]:
            return {"data": [{"count": 5}]}
        raise AssertionError(f"unexpected COQL: {json_body}")

    service._request = fake_request
    metrics = await service.get_lead_conversion_metrics(
        from_value="2026-08-01T00:00:00+05:30",
        to_value="2026-08-25T00:00:00+05:30",
    )
    check(
        "lead conversion metric uses two COQL counts",
        metrics == {
            "leads_created": 20,
            "converted_deals": 5,
            "conversion_rate": 25.0,
            "date_range": {
                "from": "2026-08-01T00:00:00+05:30",
                "to": "2026-08-25T00:00:00+05:30",
            },
        }
        and len(seen) == 2
        and "Created_Time >= '2026-08-01T00:00:00+05:30'" in seen[0]
        and "Lead_Conversion_Time >= '2026-08-01T00:00:00+05:30'" in seen[1]
        and all("Converted" not in query for query in seen),
        seen,
    )

asyncio.run(run_lead_conversion_metrics_check())

async def run_zero_lead_metric_check():
    service = ZohoCRMService()

    async def fake_request(method, url_path, params=None, json_body=None):
        if "from Leads" in json_body["select_query"]:
            return {"data": [{"count": 0}]}
        return {"data": [{"count": 2}]}

    service._request = fake_request
    metrics = await service.get_lead_conversion_metrics(
        from_value="2026-08-01T00:00:00+05:30",
        to_value="2026-08-25T00:00:00+05:30",
    )
    check("zero leads return a zero conversion rate", metrics["conversion_rate"] == 0.0, metrics)

asyncio.run(run_zero_lead_metric_check())

async def run_assistant_metric_route_check():
    from routers import agent_router

    original_metric_method = agent_router.zoho_service.get_lead_conversion_metrics
    original_query_method = agent_router.zoho_service.query_module

    async def fake_metric_method(*, from_value, to_value):
        return {
            "leads_created": 20,
            "converted_deals": 5,
            "conversion_rate": 25.0,
            "date_range": {"from": from_value, "to": to_value},
        }

    async def unexpected_record_query(**_kwargs):
        raise AssertionError("metric request must not retrieve records")

    agent_router.zoho_service.get_lead_conversion_metrics = fake_metric_method
    agent_router.zoho_service.query_module = unexpected_record_query
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/crm/assistant",
                json={"question": "count leads created this month and how many converted to deals"},
            )
        body = response.json()
        check(
            "exact lead conversion request returns structured metric",
            response.status_code == 200
            and body["leads_created"] == 20
            and body["converted_deals"] == 5
            and body["conversion_rate"] == 25.0
            and body["date_range"]["from"].endswith("T00:00:00+05:30")
            and body["date_range"]["to"].endswith("T00:00:00+05:30"),
            body,
        )
    finally:
        agent_router.zoho_service.get_lead_conversion_metrics = original_metric_method
        agent_router.zoho_service.query_module = original_query_method

asyncio.run(run_assistant_metric_route_check())

# 9. Module normalization
check("normalize aliases opportunity -> deals", normalize_module_key("opportunity") == "deals")
check("normalize sales order -> sales-orders", normalize_module_key("sales order") == "sales-orders")

# 10. Assistant NL resolution (no CRM call)
from routers.agent_router import _resolve_assistant_plan

plan = _resolve_assistant_plan("How many deals were closed this month?")
check("assistant plan: count intent", plan["intent"] == "count")
check("assistant plan: deals module", plan["module"] == "deals")
check("assistant plan: Closing_Date field", plan["date_field"] == "Closing_Date")
check("assistant plan: date range resolved", plan["date_range"] is not None)
check(
    "assistant plan: Closed Won filter",
    plan["filters"] == [{"field": "Stage", "operator": "equals", "value": "Closed Won"}],
    plan["filters"],
)
check("assistant plan: no Converted filter", all(item["field"] != "Converted" for item in plan["filters"]), plan["filters"])
check("assistant plan: metric path", plan["metric"] is True)

conversion_plan = _resolve_assistant_plan("Count how many leads converted into Closed Won deals this month")
check(
    "assistant plan: unsupported lead-deal relationship",
    conversion_plan["limitation"] is not None and conversion_plan["filters"] is None,
    conversion_plan,
)

rate_plan = _resolve_assistant_plan("Tell me the lead to deal conversion rate this month")
check(
    "assistant plan: conversion rate limitation",
    rate_plan["lead_conversion_metric"] is True and rate_plan["limitation"] is None,
    rate_plan,
)

combined_plan = _resolve_assistant_plan("Count leads created this month and how many converted to deals")
check(
    "assistant plan: lead conversion metric",
    combined_plan["lead_conversion_metric"] is True and combined_plan["limitation"] is None,
    combined_plan,
)

converted_leads_plan = _resolve_assistant_plan("How many converted leads this month?")
check(
    "assistant plan: converted leads metric",
    converted_leads_plan["lead_conversion_metric"] is True
    and converted_leads_plan["limitation"] is None,
    converted_leads_plan,
)

plan2 = _resolve_assistant_plan("Show me the leads created this month")
check("assistant plan: query intent", plan2["intent"] == "query")
check("assistant plan: leads module", plan2["module"] == "leads")
check("assistant plan: Created_Time range", plan2["date_field"] == "Created_Time" and plan2["date_range"] is not None)

owner_plan = _resolve_assistant_plan("Give me Closed Won deals owned by Laya last month")
check(
    "assistant plan: owner and stage filters",
    owner_plan["filters"] == [
        {"field": "Stage", "operator": "equals", "value": "Closed Won"},
        {"field": "Owner", "operator": "equals", "value": "laya"},
    ],
    owner_plan,
)

aggregate_plan = _resolve_assistant_plan("Total Closed Won revenue this month")
check(
    "assistant plan: revenue aggregate",
    aggregate_plan["intent"] == "aggregate"
    and aggregate_plan["aggregate_operation"] == "sum"
    and aggregate_plan["aggregate_field"] == "Amount",
    aggregate_plan,
)

print()
if failures:
    print(f"SMOKE_TEST_FAILED: {len(failures)} failure(s): {failures}")
    sys.exit(1)
print("SMOKE_TEST_OK")
