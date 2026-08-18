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

plan2 = _resolve_assistant_plan("Show me the leads created this month")
check("assistant plan: query intent", plan2["intent"] == "query")
check("assistant plan: leads module", plan2["module"] == "leads")
check("assistant plan: Created_Time range", plan2["date_field"] == "Created_Time" and plan2["date_range"] is not None)

print()
if failures:
    print(f"SMOKE_TEST_FAILED: {len(failures)} failure(s): {failures}")
    sys.exit(1)
print("SMOKE_TEST_OK")
