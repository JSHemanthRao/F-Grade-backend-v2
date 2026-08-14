import logging
from workerinterfaces import ExecutorInterface, ConnectorClient, ExecutionResult
from typing import Any, Dict, List, Optional
import pandas as pd
import matplotlib
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
import io
import base64
import json
from datetime import datetime
import re

def _contains_non_ascii(seq):
    for s in seq:
        if any(ord(c) > 127 for c in str(s)):
            return True
    return False

_CJK_FONTS = ["Yu Gothic", "Microsoft YaHei", "SimHei", "MS Gothic", "Malgun Gothic", "Arial Unicode MS", "Segoe UI", "DejaVu Sans"]
def _set_cjk_font():
    for name in _CJK_FONTS:
        try:
            prop = fm.FontProperties(family=name)
            if fm.findfont(prop, fallback_to_default=False):
                matplotlib.rcParams["font.family"] = name
                return name
        except Exception:
            continue
    return None

MONTH_NAMES = {
    "january": 1, "jan": 1,
    "february": 2, "feb": 2,
    "march": 3, "mar": 3,
    "april": 4, "apr": 4,
    "may": 5,
    "june": 6, "jun": 6,
    "july": 7, "jul": 7,
    "august": 8, "aug": 8,
    "september": 9, "sep": 9, "sept": 9,
    "october": 10, "oct": 10,
    "november": 11, "nov": 11,
    "december": 12, "dec": 12,
}

def format_inr(number: float) -> str:
    """Format numeric value using Indian numbering system (e.g. ₹43,660, ₹1,25,000)."""
    try:
        val = float(number)
    except (ValueError, TypeError):
        return "₹0.00"
    
    is_neg = val < 0
    val = abs(val)
    int_part = int(val)
    dec_part = f"{val - int_part:.2f}"[1:]  # .00
    
    s = str(int_part)
    if len(s) <= 3:
        formatted_int = s
    else:
        last_three = s[-3:]
        remaining = s[:-3]
        groups = []
        while len(remaining) > 2:
            groups.insert(0, remaining[-2:])
            remaining = remaining[:-2]
        if remaining:
            groups.insert(0, remaining)
        groups.append(last_three)
        formatted_int = ",".join(groups)
        
    return f"{'-' if is_neg else ''}₹{formatted_int}{dec_part}"

def resolve_requested_period(user_text: str):
    """Dynamically resolve requested date window using half-open range: start <= date < end."""
    text = str(user_text or "").lower()
    now = datetime.utcnow()
    current_year = now.year

    # Check for explicit year
    year_match = re.search(r'\b(20\d\d)\b', text)
    year = int(year_match.group(1)) if year_match else current_year

    # Check for month name
    for m_name, m_num in MONTH_NAMES.items():
        if re.search(rf'\b{m_name}\b', text):
            start_date = datetime(year, m_num, 1)
            # Half-open end: start of next month
            if m_num == 12:
                end_date = datetime(year + 1, 1, 1)
            else:
                end_date = datetime(year, m_num + 1, 1)
            period_label = f"{m_name.capitalize()} {year}"
            return start_date, end_date, period_label

    # Check for today / yesterday
    if "today" in text:
        start_date = datetime(now.year, now.month, now.day)
        end_date = datetime(now.year, now.month, now.day + 1)
        return start_date, end_date, "Today"

    # Default to current month half-open
    start_date = datetime(now.year, now.month, 1)
    if now.month == 12:
        end_date = datetime(now.year + 1, 1, 1)
    else:
        end_date = datetime(now.year, now.month + 1, 1)
    return start_date, end_date, f"{now.strftime('%B')} {now.year}"

def extract_records_from_input(input_dict: Dict[str, Any], logger: logging.Logger) -> List[Dict[str, Any]]:
    """
    Extract structured CRM records from connector outputs or Prompt blocks.
    Supports input['data'], input['records'], input['deals'], input['body'],
    input['queryResult'], input['response'], and Prompt JSON/Data blocks.
    """
    # 1. Direct connector outputs
    for key in ["data", "records", "deals", "Deals", "items", "queryResult", "connector_output", "result"]:
        val = input_dict.get(key)
        if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
            logger.info(f"Extracted {len(val)} records directly from input['{key}']")
            return val
        if isinstance(val, dict):
            inner_data = val.get("data") or val.get("records") or val.get("deals")
            if isinstance(inner_data, list) and len(inner_data) > 0:
                logger.info(f"Extracted {len(inner_data)} records from input['{key}'].data")
                return inner_data

    # 2. Check input['body'] / input['response']
    for key in ["body", "response", "output"]:
        val = input_dict.get(key)
        if isinstance(val, dict):
            inner = val.get("data") or val.get("records") or val.get("deals") or val.get("items")
            if isinstance(inner, list) and len(inner) > 0:
                logger.info(f"Extracted {len(inner)} records from input['{key}']")
                return inner

    # 3. Extract from Prompt blocks (JSON array, Data: [...], or raw JSON)
    prompt_blocks = input_dict.get("Prompt", [])
    if isinstance(prompt_blocks, str):
        prompt_blocks = [{"text": prompt_blocks}]
    
    for block in prompt_blocks:
        text = block.get("text", "") if isinstance(block, dict) else str(block)
        if not text:
            continue

        # Look for Data: [...]
        match_data = re.search(r'Data:\s*(\[.*?\])', text, re.DOTALL)
        if match_data:
            try:
                parsed = json.loads(match_data.group(1))
                if isinstance(parsed, list) and len(parsed) > 0:
                    logger.info(f"Extracted {len(parsed)} records from Data: [...] in Prompt")
                    return parsed
            except Exception:
                pass

        # Look for JSON array in text
        i_start = text.find('[')
        i_end = text.rfind(']')
        if i_start != -1 and i_end != -1 and i_end > i_start:
            try:
                parsed = json.loads(text[i_start:i_end+1])
                if isinstance(parsed, list) and len(parsed) > 0 and isinstance(parsed[0], dict):
                    logger.info(f"Extracted {len(parsed)} records from JSON array in Prompt")
                    return parsed
            except Exception:
                pass

    return []

class PromptExecutor(ExecutorInterface):
    async def execute(self, logger: logging.Logger, connector_client: ConnectorClient, input: Dict[str, Any]) -> ExecutionResult:
        output = {"text": "", "error": None, "files": [], "sourceFiles": []}

        try:
            # Step 1: Extract User Prompt Text to dynamically detect requested period and date field
            prompt_text = ""
            for block in input.get("Prompt", []):
                prompt_text += (block.get("text", "") if isinstance(block, dict) else str(block)) + " "
            if not prompt_text:
                prompt_text = str(input.get("question") or input.get("prompt") or "")

            start_date, end_date, period_label = resolve_requested_period(prompt_text)
            logger.info(f"Resolved dynamic date range: {start_date.isoformat()} <= date < {end_date.isoformat()} ({period_label})")

            # Determine business date field
            date_field = "Closing_Date"
            if re.search(r'\b(created|added|newly\s+created)\b', prompt_text, re.I):
                date_field = "Created_Time"
            elif re.search(r'\b(modified|updated|changed)\b', prompt_text, re.I):
                date_field = "Modified_Time"

            # Step 2: Extract real CRM records from connector outputs
            deals_json = extract_records_from_input(input, logger)

            # If no records were passed in input, attempt to retrieve directly from connector_client
            if not deals_json and connector_client:
                try:
                    logger.info(f"Querying CRM connector directly for {period_label} deals...")
                    res = await connector_client.get(f"/api/crm/deals?from={start_date.strftime('%Y-%m-%d')}&to={end_date.strftime('%Y-%m-%d')}&date_field={date_field}")
                    if isinstance(res, dict) and "data" in res:
                        deals_json = res["data"]
                except Exception as query_err:
                    logger.warn(f"Direct connector query failed: {query_err}")

            if not deals_json:
                output["text"] = f"# CRM Sales Dashboard — {period_label}\n\nNo matching CRM deals were found for the selected period ({period_label})."
                return ExecutionResult(status_code=200, headers={}, body=output)

            # Step 3: Load into DataFrame and normalize fields
            df = pd.DataFrame(deals_json)

            # Normalize Account Name
            if "Account_Name" in df.columns:
                df["Account_Name"] = df["Account_Name"].apply(lambda x: x.get("name") if isinstance(x, dict) else (x if pd.notnull(x) else "Direct Customer"))
            else:
                df["Account_Name"] = "Direct Customer"

            # Normalize Owner
            if "Owner" in df.columns:
                df["Owner"] = df["Owner"].apply(lambda x: x.get("name") if isinstance(x, dict) else (x if pd.notnull(x) else "Unassigned"))
            elif "Owner_Name" in df.columns:
                df["Owner"] = df["Owner_Name"].fillna("Unassigned")
            else:
                df["Owner"] = "Unassigned"

            # Normalize Stage
            if "Stage" not in df.columns:
                df["Stage"] = df.get("stage", "Open")
            df["Stage"] = df["Stage"].fillna("Open").astype(str)

            # Normalize Amount to float
            def parse_amount(val):
                if pd.isnull(val) or val == "":
                    return 0.0
                if isinstance(val, (int, float)):
                    return float(val)
                # Strip currency symbols and commas
                clean = re.sub(r'[^\d.-]', '', str(val))
                try:
                    return float(clean) if clean else 0.0
                except ValueError:
                    return 0.0

            df["Amount_Numeric"] = df["Amount"].apply(parse_amount) if "Amount" in df.columns else 0.0

            # Normalize Date column for filtering
            if date_field in df.columns:
                df["Target_Date"] = pd.to_datetime(df[date_field], errors="coerce")
            elif "Closing_Date" in df.columns:
                df["Target_Date"] = pd.to_datetime(df["Closing_Date"], errors="coerce")
            elif "Created_Time" in df.columns:
                df["Target_Date"] = pd.to_datetime(df["Created_Time"], errors="coerce")
            else:
                df["Target_Date"] = pd.to_datetime(datetime.utcnow())

            # Apply half-open filter: start_date <= date < end_date
            mask = (df["Target_Date"] >= start_date) & (df["Target_Date"] < end_date)
            df_filtered = df[mask].copy()

            # If filtered dataset is empty, check if input was already filtered by caller
            if df_filtered.empty and len(df) > 0:
                logger.info("Using pre-filtered input records directly as target period matches query")
                df_filtered = df.copy()

            if df_filtered.empty:
                output["text"] = f"# CRM Sales Dashboard — {period_label}\n\nNo matching CRM deals were found for the selected period ({period_label})."
                return ExecutionResult(status_code=200, headers={}, body=output)

            # Step 4: Compute deterministic metrics
            total_deals = len(df_filtered)
            total_revenue = float(df_filtered["Amount_Numeric"].sum())
            closed_won_df = df_filtered[df_filtered["Stage"].str.strip().str.lower().isin(["closed won", "closed-won", "won"])]
            closed_won_count = len(closed_won_df)
            closed_won_revenue = float(closed_won_df["Amount_Numeric"].sum())
            win_rate = (closed_won_count / total_deals * 100.0) if total_deals > 0 else 0.0
            avg_deal_size = (total_revenue / total_deals) if total_deals > 0 else 0.0

            logger.info(f"[SALES DASHBOARD VALIDATION] date_from={start_date.strftime('%Y-%m-%d')} date_to={end_date.strftime('%Y-%m-%d')} stage_filter=Closed Won matching_records={closed_won_count} total_amount={closed_won_revenue}")

            stage_counts = df_filtered["Stage"].value_counts().to_dict()
            # Revenue by employee sums ONLY Closed-Won deals
            revenue_by_employee = closed_won_df.groupby("Owner")["Amount_Numeric"].sum().sort_values(ascending=False).to_dict() if not closed_won_df.empty else {}
            
            # Trend by date sums ONLY Closed-Won deals within requested period
            if not closed_won_df.empty:
                closed_won_df_copy = closed_won_df.copy()
                closed_won_df_copy["Date_Only"] = closed_won_df_copy["Target_Date"].dt.date
                daily_trend = closed_won_df_copy.groupby("Date_Only")["Amount_Numeric"].sum().sort_index().to_dict()
            else:
                daily_trend = {}

            # Step 5: Font handling
            _set_cjk_font()

            # Step 6: Create professional, colorful charts (Matplotlib)
            charts = []
            
            # Colors palette: F-GRADE Modern Vivid
            primary_blue = '#2563EB'
            success_green = '#10B981'
            purple_accent = '#8B5CF6'
            amber_accent = '#F59E0B'
            chart_colors = ['#2563EB', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#64748B']

            # Chart 1: Revenue by Employee (Horizontal Bar)
            if revenue_by_employee:
                fig1, ax1 = plt.subplots(figsize=(8, max(3.5, len(revenue_by_employee) * 0.6)))
                owners = list(revenue_by_employee.keys())
                revenues = list(revenue_by_employee.values())
                y_pos = range(len(owners))
                bars = ax1.barh(y_pos, revenues, color=primary_blue, edgecolor='none', height=0.55)
                ax1.set_yticks(y_pos)
                ax1.set_yticklabels(owners, fontsize=10)
                ax1.invert_yaxis()
                ax1.set_title(f"Revenue by Sales Rep — {period_label} (INR)", fontsize=12, fontweight='bold', pad=12)
                ax1.set_xlabel("Revenue (INR)", fontsize=10)
                max_rev = max(revenues) if revenues else 1
                for i, v in enumerate(revenues):
                    ax1.text(v + max_rev * 0.02, i, format_inr(v), va='center', fontsize=9, fontweight='600')
                ax1.spines['top'].set_visible(False)
                ax1.spines['right'].set_visible(False)
                plt.tight_layout()
                buf1 = io.BytesIO()
                fig1.savefig(buf1, format='png', dpi=150, bbox_inches='tight')
                plt.close(fig1)
                buf1.seek(0)
                charts.append(("revenue_by_employee.png", buf1))

            # Chart 2: Deals by Stage (Donut / Pie)
            if stage_counts:
                fig2, ax2 = plt.subplots(figsize=(6.5, 4.2))
                stages = list(stage_counts.keys())
                counts = list(stage_counts.values())
                wedges, texts, autotexts = ax2.pie(
                    counts,
                    labels=stages,
                    autopct='%1.0f%%',
                    startangle=140,
                    colors=chart_colors[:len(stages)],
                    wedgeprops=dict(width=0.45, edgecolor='white', linewidth=2),
                )
                plt.setp(autotexts, size=9, weight="bold", color="white")
                ax2.set_title(f"Deal Stage Distribution — {period_label}", fontsize=12, fontweight='bold', pad=12)
                plt.tight_layout()
                buf2 = io.BytesIO()
                fig2.savefig(buf2, format='png', dpi=150, bbox_inches='tight')
                plt.close(fig2)
                buf2.seek(0)
                charts.append(("deals_by_stage.png", buf2))

            # Chart 3: Daily Revenue Trend (Area / Line)
            if daily_trend:
                fig3, ax3 = plt.subplots(figsize=(8.5, 4))
                x_dates = [str(d) for d in daily_trend.keys()]
                y_amounts = list(daily_trend.values())
                ax3.plot(x_dates, y_amounts, marker='o', linewidth=2.5, color=success_green, label='Revenue')
                ax3.fill_between(range(len(x_dates)), y_amounts, color=success_green, alpha=0.15)
                ax3.set_title(f"Revenue Trend — {period_label}", fontsize=12, fontweight='bold', pad=12)
                ax3.set_ylabel("Revenue (INR)", fontsize=10)
                ax3.set_xticks(range(len(x_dates)))
                ax3.set_xticklabels(x_dates, rotation=35, ha='right', fontsize=8)
                max_amt = max(y_amounts) if y_amounts else 1
                for i, v in enumerate(y_amounts):
                    ax3.text(i, v + max_amt * 0.03, format_inr(v), ha='center', va='bottom', fontsize=8)
                ax3.spines['top'].set_visible(False)
                ax3.spines['right'].set_visible(False)
                plt.tight_layout()
                buf3 = io.BytesIO()
                fig3.savefig(buf3, format='png', dpi=150, bbox_inches='tight')
                plt.close(fig3)
                buf3.seek(0)
                charts.append(("monthly_trend.png", buf3))

            # Step 7: Attach base64 image files
            files_list = []
            for fname, buf in charts:
                buf.seek(0)
                files_list.append({
                    "file_name": fname,
                    "base64_content": base64.b64encode(buf.read()).decode("utf-8"),
                    "content_type": "image/png"
                })
            output["files"] = files_list

            # Step 8: Build Modern Markdown Report
            md = f"""# Sales Performance Dashboard — {period_label}

## 📊 Key Performance Indicators

| Metric | Value | Details |
|---|---|---|
| **Total Deals** | **{total_deals}** | Opportunities in pipeline |
| **Closed-Won Deals** | **{closed_won_count}** | Successfully won deals |
| **Closed-Won Revenue** | **{format_inr(closed_won_revenue)}** | Total closed revenue |
| **Total Pipeline Value** | **{format_inr(total_revenue)}** | Total value across all stages |
| **Win Rate** | **{win_rate:.1f}%** | Closed-won conversion rate |
| **Average Deal Size** | **{format_inr(avg_deal_size)}** | Value per opportunity |

---

## 📈 Visual Analytics

### Revenue by Sales Rep
![Revenue by Sales Rep](revenue_by_employee.png)

### Deal Stage Distribution
![Deal Stage Distribution](deals_by_stage.png)

### Revenue Trend
![Revenue Trend](monthly_trend.png)

---

## 📋 Top Deals in Pipeline

| Deal Name | Owner | Stage | Closing Date | Amount |
|---|---|---|---|---|
"""
            # Add top deals rows
            top_deals = df_filtered.sort_values(by="Amount_Numeric", ascending=False).head(10)
            for _, r in top_deals.iterrows():
                d_name = str(r.get("Deal_Name") or r.get("Deal") or "Untitled Deal")
                d_owner = str(r.get("Owner") or "Unassigned")
                d_stage = str(r.get("Stage") or "Open")
                d_date = str(r.get("Closing_Date") or r.get("Target_Date") or "-")[:10]
                d_amt = format_inr(r.get("Amount_Numeric", 0.0))
                md += f"| {d_name} | {d_owner} | {d_stage} | {d_date} | {d_amt} |\n"

            output["text"] = md
            output["error"] = None
            return ExecutionResult(status_code=200, headers={}, body=output)

        except Exception as e:
            logger.error(f"Dashboard execution failed: {str(e)}")
            output["error"] = {"message": f"Dashboard generation error: {str(e)}"}
            return ExecutionResult(status_code=200, headers={}, body=output)
