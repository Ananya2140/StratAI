import os
import sqlite3
import io
import re
import json
import requests
from typing import Optional
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd
import numpy as np

app = FastAPI(title="StratAI Core OS")

origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "strat_ai.db"
REGISTRY_PATH = "active_file_registry.txt"

# ---------------------------------------------------------------------------
# Ollama configuration -- replaces the previous google-genai client. Every
# call site that used to hit Gemini now goes through _call_ollama() below,
# which talks to the local Ollama server's /api/generate endpoint.
# ---------------------------------------------------------------------------
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")


class LoginRequest(BaseModel):
    username: str
    password: str


class CustomMeasureRequest(BaseModel):
    formula: str
    measure_name: str


class AskQuestionRequest(BaseModel):
    question: str
    history: list = []


class CustomChartRequest(BaseModel):
    chart_type: str                    # 'line' | 'bar' | 'pie' | 'scatter'
    x_column: str                       # for 'line'/'scatter' this is the (numeric) column to plot
    y_column: Optional[str] = None       # numeric metric; omit for bar/pie to get a plain count
    agg: Optional[str] = 'mean'         # 'mean' | 'sum' | 'count' | 'max' | 'min' -- used by bar/pie


_VALID_CHART_TYPES = {'line', 'bar', 'pie', 'scatter'}
_VALID_AGGS = {'mean', 'sum', 'count', 'max', 'min'}


def _call_ollama(prompt, timeout=120):
    """Sends a prompt to the local Ollama server and returns the generated
    text. Raises RuntimeError on any failure so callers can decide how to
    fall back (never surfaces a raw exception to the end user)."""
    try:
        response = requests.post(
            f"{OLLAMA_HOST}/api/generate",
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
            },
            timeout=timeout,
        )
        response.raise_for_status()
        data = response.json()
        return data.get("response", "").strip()
    except requests.exceptions.ConnectionError as e:
        raise RuntimeError(
            f"Could not reach Ollama at {OLLAMA_HOST}. Is it running? (ollama serve)"
        ) from e
    except Exception as e:
        raise RuntimeError(f"Ollama request failed: {e}") from e


@app.post("/api/auth/login")
async def login_gate(req: LoginRequest):
    if req.username == "admin@stratai.com" and req.password == "12345":
        return {"status": 200, "token": "session_jwt_cached_key_stratai", "user": "Executive Administrator"}
    raise HTTPException(status_code=401, detail="Invalid credentials.")


@app.post("/api/upload")
async def upload_any_dataset(file: UploadFile = File(...)):
    if not file.filename.endswith('.csv'):
        raise HTTPException(status_code=400, detail="Invalid file type.")
    try:
        contents = await file.read()
        df = pd.read_csv(io.BytesIO(contents))
        df.columns = [c.strip().replace(' ', '_') for c in df.columns]

        conn = sqlite3.connect(DB_PATH)
        df.to_sql("customers", conn, if_exists="replace", index=False)
        conn.close()

        with open(REGISTRY_PATH, "w") as f:
            f.write(file.filename)

        return {"status": 200, "columns": list(df.columns)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/dataset/purge")
async def purge_active_dataset():
    try:
        if os.path.exists(REGISTRY_PATH):
            os.remove(REGISTRY_PATH)
        if os.path.exists(DB_PATH):
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute("DROP TABLE IF EXISTS customers")
            conn.commit()
            conn.close()
        return {"status": 200, "detail": "Active database tables successfully purged."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Shared helper functions used across summary + insights endpoints so that
# column selection logic (what counts as an identifier, a usable numeric
# metric, or a usable category) is IDENTICAL everywhere and works the same
# way no matter what CSV the user uploads.
# ---------------------------------------------------------------------------

def _get_active_filename():
    if os.path.exists(REGISTRY_PATH):
        with open(REGISTRY_PATH, "r") as f:
            return f.read().strip()
    return "None Loaded"


def _derive_table_name(active_filename):
    """Turns 'coursera.csv' into 'coursera' for use inside DAX-style formula
    strings. Falls back to a generic name when nothing is loaded."""
    if not active_filename or active_filename == "None Loaded":
        return "Dataset"
    name = os.path.splitext(active_filename)[0].strip()
    name = re.sub(r"[^A-Za-z0-9_ ]", "", name)
    return name if name else "Dataset"


def _is_identifier_column(df, col, total_rows):
    """Flags pandas index leftovers (e.g. 'Unnamed: 0') and pure ID columns
    (every value unique) so they never get selected as a meaningful metric."""
    if re.match(r"^unnamed", col, re.IGNORECASE):
        return True
    if total_rows > 1 and df[col].nunique(dropna=True) == total_rows:
        return True
    return False


def _looks_like_url(df, col):
    """Flags columns whose values are mostly links (e.g. image banners),
    which make useless / unreadable pie-chart legends."""
    sample = df[col].dropna().astype(str).head(20)
    if sample.empty:
        return False
    # Non-capturing group (?:...) instead of a capturing group -- str.contains
    # only needs a match/no-match, so a capturing group here just trips
    # pandas' "This pattern has match groups" UserWarning for no benefit.
    url_like = sample.str.contains(r'^(?:https?://|www\.)', regex=True, na=False)
    return url_like.mean() > 0.5


def _rank_numeric_columns(df, numeric_cols, total_rows):
    """Ranks numeric columns by coefficient of variation (signal strength),
    excluding identifier-like columns. Used for BOTH the KPI scorecards and
    the auto-charts, so the same column never gets treated differently in
    different parts of the app."""
    ranked = []
    for col in numeric_cols:
        if _is_identifier_column(df, col, total_rows):
            continue
        mean, std = df[col].mean(), df[col].std()
        if pd.isna(mean) or mean == 0:
            continue
        cv = abs(std / mean) if pd.notna(std) else 0
        ranked.append((col, cv))
    ranked.sort(key=lambda x: x[1], reverse=True)
    return ranked


def _pick_categorical_column(df, text_cols):
    """Picks the best categorical column for a distribution chart: excludes
    IDs/URLs and prefers a legible number of distinct groups (2-8)."""
    candidates = []
    for col in text_cols:
        if _is_identifier_column(df, col, len(df)) or _looks_like_url(df, col):
            continue
        n = df[col].nunique(dropna=True)
        if n < 2:
            continue
        score = -abs(n - 5)  # sweet spot around ~5 categories
        candidates.append((col, score))
    if not candidates:
        return None
    candidates.sort(key=lambda x: x[1], reverse=True)
    return candidates[0][0]


def _trend_direction(values):
    """Classifies a numeric series as rising / falling / volatile / stable
    for use in the auto-generated explanation text."""
    values = np.asarray(values, dtype=float)
    if len(values) < 3:
        return "stable"
    midpoint = len(values) // 2
    first_half = np.mean(values[:midpoint])
    second_half = np.mean(values[midpoint:])
    if first_half == 0:
        return "volatile"
    pct_change = (second_half - first_half) / abs(first_half)
    std = np.std(values)
    mean_abs = np.mean(np.abs(values)) or 1
    if std / mean_abs > 0.5:
        return "volatile"
    if pct_change > 0.05:
        return "rising"
    if pct_change < -0.05:
        return "falling"
    return "stable"


# Keyword hints used to pick which aggregation (and therefore which DAX-style
# formula) makes the most business sense for a given column name. This keeps
# the "Custom Metric Expression Builder" and the auto-generated KPI cards
# speaking the same formula language for ANY dataset, not just one schema.
_SUM_KEYWORDS = ['total', 'sum', 'amount', 'revenue', 'sales', 'count', 'qty',
                 'quantity', 'units', 'volume', 'orders', 'spend', 'cost']
_MAX_KEYWORDS = ['max', 'peak', 'highest', 'limit', 'capacity']


def _recommend_aggregation(col_name):
    """Returns (pandas_agg_key, dax_function_name) best suited to a column,
    inferred purely from its name/semantics so it generalizes to any CSV."""
    name = col_name.lower()
    if any(k in name for k in _SUM_KEYWORDS):
        return 'sum', 'SUM'
    if any(k in name for k in _MAX_KEYWORDS):
        return 'max', 'MAX'
    return 'mean', 'AVERAGE'


def _build_dataset_context(df, active_filename):
    """Builds a compact, model-friendly statistical profile of WHATEVER
    dataset is currently loaded. This is what lets the AI Boardroom
    Assistant answer free-form questions about any CSV -- instead of
    sending the raw (potentially huge) dataset to the LLM, we send a
    grounded summary: per-column stats/top-values, a cross-tab of the two
    most significant columns, and a small random sample of real rows."""
    total_rows = len(df)
    all_cols = list(df.columns)
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    text_cols = df.select_dtypes(exclude=[np.number]).columns.tolist()

    column_profiles = []
    for col in all_cols:
        profile = {
            "column": col,
            "dtype": "numeric" if col in numeric_cols else "categorical/text",
            "non_null_count": int(df[col].notna().sum()),
            "unique_count": int(df[col].nunique(dropna=True)),
        }
        if col in numeric_cols:
            series = df[col].dropna()
            if not series.empty:
                profile.update({
                    "mean": round(float(series.mean()), 3),
                    "median": round(float(series.median()), 3),
                    "std": round(float(series.std()), 3) if len(series) > 1 else 0.0,
                    "min": round(float(series.min()), 3),
                    "max": round(float(series.max()), 3),
                    "sum": round(float(series.sum()), 3),
                })
        else:
            if not _looks_like_url(df, col) and profile["unique_count"] <= 30:
                counts = df[col].dropna().astype(str).value_counts().head(10)
                profile["top_values"] = {str(k): int(v) for k, v in counts.items()}
            else:
                top = df[col].dropna().astype(str).value_counts().head(5)
                profile["most_common_sample"] = {str(k): int(v) for k, v in top.items()}
        column_profiles.append(profile)

    # A ready-made cross-tab of the most significant numeric x categorical
    # pair (same selection logic used by the auto-charts), so questions like
    # "how does X compare across Y" can be answered precisely.
    ranked_numeric = _rank_numeric_columns(df, numeric_cols, total_rows)
    pie_col = _pick_categorical_column(df, text_cols)
    crosstab = None
    if ranked_numeric and pie_col:
        top_metric = ranked_numeric[0][0]
        grouped = df.groupby(pie_col)[top_metric].agg(['mean', 'count']).round(3).head(10)
        crosstab = {
            "grouped_by": pie_col,
            "metric": top_metric,
            "groups": {str(idx): {"mean": float(row['mean']), "count": int(row['count'])} for idx, row in grouped.iterrows()},
        }

    sample_rows = (
        df.sample(min(8, total_rows), random_state=42).fillna("").to_dict(orient='records')
        if total_rows > 0 else []
    )

    return {
        "active_file": active_filename,
        "total_rows": total_rows,
        "total_columns": len(all_cols),
        "columns": column_profiles,
        "example_cross_tab": crosstab,
        "sample_rows": sample_rows,
    }


def _load_active_dataframe():
    """Central place that loads the active dataset (or None if nothing has
    been uploaded yet). Every endpoint below routes through this so behavior
    stays consistent regardless of what file the user ingested."""
    if not os.path.exists(DB_PATH):
        return None
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='customers'")
    if not cursor.fetchone():
        conn.close()
        return None
    df = pd.read_sql_query("SELECT * FROM customers", conn)
    conn.close()
    return df


# ---------------------------------------------------------------------------
# AI Boardroom Assistant helpers -- lets the assistant answer ANY question
# about the active dataset, not just ones covered by the pre-computed stats
# context. It works in two stages:
#   1. Ask the model whether this question needs an EXACT SQL query, and if
#      so, have it draft one against the live `customers` table.
#   2. Validate + execute that query (read-only, single SELECT only), then
#      feed the real result back in as ground truth alongside the existing
#      stats context before generating the final natural-language answer.
# This keeps qualitative questions ("summarize the patterns") working exactly
# as before, while making precise / filtered / grouped questions actually
# accurate instead of approximate.
# ---------------------------------------------------------------------------

_DISALLOWED_SQL_KEYWORDS = ['insert', 'update', 'delete', 'drop', 'alter', 'create',
                             'attach', 'detach', 'pragma', 'replace', 'vacuum', ';']


def _build_schema_overview(df):
    """Compact schema description (with sample values) for the SQL-planning
    prompt -- kept small on purpose, unlike the full stats context."""
    lines = []
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    for col in df.columns:
        dtype = "numeric" if col in numeric_cols else "text"
        non_null = int(df[col].notna().sum())
        sample_vals = df[col].dropna().astype(str).unique()[:5]
        lines.append(f"- {col} ({dtype}, {non_null} non-null): e.g. {', '.join(sample_vals)}")
    return "\n".join(lines)


def _extract_json_block(text):
    """Pulls a JSON object out of a model response, tolerating stray prose
    or markdown fences around it."""
    if not text:
        return None
    match = re.search(r"\{.*\}", text.strip(), re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except Exception:
        return None


def _is_safe_select_query(sql):
    """Only allows single, read-only SELECT statements against 'customers'.
    This is a basic guardrail suitable for a local single-user tool -- if
    this endpoint is ever exposed beyond localhost, swap this for a real
    read-only DB connection/role instead of keyword blocking."""
    if not sql or not isinstance(sql, str):
        return False
    normalized = sql.strip().rstrip(';').lower()
    if not normalized.startswith('select'):
        return False
    if any(kw in normalized for kw in _DISALLOWED_SQL_KEYWORDS):
        return False
    if 'customers' not in normalized:
        return False
    return True


def _execute_sql_query(sql, max_rows=200):
    normalized = sql.strip().rstrip(';')
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(normalized)
    rows = cursor.fetchmany(max_rows)
    columns = [desc[0] for desc in cursor.description] if cursor.description else []
    conn.close()
    return columns, [dict(row) for row in rows]


@app.get("/api/analytics/summary")
async def get_dynamic_summary():
    active_filename = _get_active_filename()
    table_name = _derive_table_name(active_filename)
    empty_response = {
        "total_records": 0, "numeric_aggregates": {}, "all_columns": [],
        "selected_kpis": [], "column_types": {}, "active_file": active_filename,
    }

    df = _load_active_dataframe()
    if df is None:
        return empty_response

    total_rows = len(df)
    all_cols = list(df.columns)
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    column_types_map = {
        col: "Numerical Metric Vector" if col in numeric_cols else "Categorical / Text Attribute"
        for col in all_cols
    }

    # Same ranking logic used everywhere else in the app -> works identically
    # no matter which columns the uploaded CSV happens to contain.
    ranked_numeric = _rank_numeric_columns(df, numeric_cols, total_rows)
    selected_kpis = [item[0] for item in ranked_numeric[:3]]
    if not selected_kpis and numeric_cols:
        selected_kpis = numeric_cols[:3]

    summary_map = {}
    for col in selected_kpis:
        agg_key, dax_func = _recommend_aggregation(col)
        col_series = df[col].dropna()
        recommended_value = float(col_series.agg(agg_key)) if not col_series.empty else 0.0
        summary_map[col] = {
            "mean": round(float(df[col].mean()), 2) if not df[col].empty else 0.0,
            "sum": round(float(df[col].sum()), 2) if not df[col].empty else 0.0,
            "max": round(float(df[col].max()), 2) if not df[col].empty else 0.0,
            "recommended_agg": agg_key,
            "recommended_label": dax_func,
            "dax_formula": f"{dax_func}('{table_name}'[{col}])",
        }

    return {
        "total_records": total_rows,
        "numeric_aggregates": summary_map,
        "all_columns": all_cols,
        "selected_kpis": selected_kpis,
        "column_types": column_types_map,
        "active_file": active_filename,
    }


@app.get("/api/analytics/dashboard_insights")
async def get_dashboard_insights():
    df = _load_active_dataframe()
    if df is None or df.empty:
        return {}

    total_rows = len(df)
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    text_cols = df.select_dtypes(exclude=[np.number]).columns.tolist()

    ranked_numeric = _rank_numeric_columns(df, numeric_cols, total_rows)

    # ---------- 1. Trend chart: most-variable real metric ----------
    trend_col = ranked_numeric[0][0] if ranked_numeric else (numeric_cols[0] if numeric_cols else None)
    trend_data, trend_explanation = [], "No numeric metric available to plot a trend."
    if trend_col:
        series = df[trend_col].dropna().head(60)
        trend_data = [{"x_val": int(i), "y_val": float(v)} for i, v in series.items()]
        direction = _trend_direction(series.tolist())
        direction_phrase = {
            "rising": "trending upward",
            "falling": "trending downward",
            "volatile": "fluctuating significantly",
            "stable": "holding relatively steady",
        }[direction]
        trend_explanation = (
            f"'{trend_col}' was selected because it shows the highest variability in the dataset, "
            f"making it the most informative metric to track. Across the first {len(series)} records, "
            f"it is {direction_phrase} (avg {round(float(series.mean()), 2)}, "
            f"range {round(float(series.min()), 2)}\u2013{round(float(series.max()), 2)})."
        )

    # ---------- 2. Distribution chart: best categorical breakdown ----------
    pie_col = _pick_categorical_column(df, text_cols)
    pie_data, pie_explanation = [], "No suitable categorical column found for a distribution chart."
    if pie_col:
        counts = df[pie_col].dropna().astype(str).value_counts().head(6)
        pie_data = [{"x_val": str(k), "y_val": int(v)} for k, v in counts.items()]
        top_cat, top_n = counts.index[0], int(counts.iloc[0])
        pct = round(100 * top_n / total_rows, 1)
        pie_explanation = (
            f"'{pie_col}' was chosen because it splits the data into a clear, readable set of groups. "
            f"'{top_cat}' is the largest segment, making up {pct}% of records."
        )

    # ---------- 3. Comparison chart: top metric averaged by top category ----------
    comparison_data, comparison_explanation = [], "Not enough data to build an automatic comparison."
    comparison_metric, comparison_category = None, None
    if trend_col and pie_col:
        comparison_metric, comparison_category = trend_col, pie_col
        grouped = df.groupby(pie_col)[trend_col].mean().sort_values(ascending=False).head(8)
        comparison_data = [
            {"category": str(k), "value": round(float(v), 2)} for k, v in grouped.items()
        ]
        best_cat = grouped.index[0]
        comparison_explanation = (
            f"Automatically comparing average '{trend_col}' across each '{pie_col}' group \u2014 "
            f"these are the two most significant columns detected. '{best_cat}' leads with the highest "
            f"average ({round(float(grouped.iloc[0]), 2)})."
        )

    return {
        "trend_column": trend_col,
        "trend_data": trend_data,
        "trend_explanation": trend_explanation,
        "pie_column": pie_col,
        "pie_data": pie_data,
        "pie_explanation": pie_explanation,
        "comparison_metric": comparison_metric,
        "comparison_category": comparison_category,
        "comparison_data": comparison_data,
        "comparison_explanation": comparison_explanation,
    }


@app.post("/api/analytics/custom_measure")
async def dynamic_dax_parser(req: CustomMeasureRequest):
    if not os.path.exists(DB_PATH):
        raise HTTPException(status_code=400, detail="Database not initialized.")
    match = re.match(r"(SUM|AVERAGE|MAX|MIN)\((.*?)\)", req.formula.strip(), re.IGNORECASE)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid syntax. Use e.g. AVERAGE(Column_Name)")
    func_token = match.group(1).upper()
    target_column = match.group(2).strip()
    sql_func = "AVG" if func_token == "AVERAGE" else func_token

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(customers)")
    columns = [row[1] for row in cursor.fetchall()]
    if target_column not in columns:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Column '{target_column}' missing.")
    try:
        query = f"SELECT {sql_func}([{target_column}]) FROM customers"
        cursor.execute(query)
        computed_result = cursor.fetchone()[0]
        conn.close()
        return {
            "measure_name": req.measure_name,
            "formula_applied": req.formula,
            "result_value": round(float(computed_result), 2) if computed_result is not None else 0.0,
        }
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/analytics/multichart")
async def get_chart_data():
    if not os.path.exists(DB_PATH):
        return []
    summary_node = await get_dynamic_summary()
    target_metrics = summary_node.get("selected_kpis", [])
    conn = sqlite3.connect(DB_PATH)
    df = pd.read_sql_query("SELECT * FROM customers LIMIT 60", conn)
    conn.close()
    if df.empty or not target_metrics:
        return []
    return [
        {"index": idx, **{col: float(row[col]) if not pd.isna(row[col]) else 0.0 for col in target_metrics if col in df.columns}}
        for idx, row in df.iterrows()
    ]


@app.get("/api/analytics/columns_meta")
async def get_columns_meta():
    """Splits the active dataset's columns into numeric vs categorical, for
    the frontend's Custom Chart Builder dropdowns. Same numeric/text split
    logic used everywhere else, so a column is never classified differently
    in different parts of the app."""
    df = _load_active_dataframe()
    if df is None or df.empty:
        return {"numeric_columns": [], "categorical_columns": [], "all_columns": []}
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    all_cols = list(df.columns)
    categorical_cols = [c for c in all_cols if c not in numeric_cols]
    return {
        "numeric_columns": numeric_cols,
        "categorical_columns": categorical_cols,
        "all_columns": all_cols,
    }


@app.post("/api/analytics/custom_chart")
async def build_custom_chart(req: CustomChartRequest):
    """Lets the user pick any column(s) + a chart type and get back
    chart-ready data, instead of being limited to the auto-selected KPIs.
    Mirrors the same grouping/aggregation conventions used by the
    auto-generated dashboard charts, just driven by explicit user choice."""
    df = _load_active_dataframe()
    if df is None or df.empty:
        raise HTTPException(status_code=400, detail="No dataset loaded. Upload a CSV first.")

    chart_type = (req.chart_type or '').lower().strip()
    if chart_type not in _VALID_CHART_TYPES:
        raise HTTPException(status_code=400, detail=f"chart_type must be one of {sorted(_VALID_CHART_TYPES)}.")

    agg = (req.agg or 'mean').lower().strip()
    if agg not in _VALID_AGGS:
        raise HTTPException(status_code=400, detail=f"agg must be one of {sorted(_VALID_AGGS)}.")

    if not req.x_column or req.x_column not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{req.x_column}' not found in dataset.")
    if req.y_column and req.y_column not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{req.y_column}' not found in dataset.")

    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()

    # ---------- LINE: single numeric column plotted over row order ----------
    if chart_type == 'line':
        target_col = req.y_column or req.x_column
        if target_col not in numeric_cols:
            raise HTTPException(status_code=400, detail=f"'{target_col}' must be a numeric column for a line chart.")
        series = df[target_col].dropna().head(200)
        data = [{"x_val": int(i), "y_val": float(v)} for i, v in series.items()]
        return {"chart_type": "line", "label": target_col, "x_axis_label": "Record #", "y_axis_label": target_col, "data": data}

    # ---------- SCATTER: two numeric columns, raw (sampled) points ----------
    if chart_type == 'scatter':
        if not req.y_column:
            raise HTTPException(status_code=400, detail="Scatter chart requires both an X and a Y numeric column.")
        if req.x_column not in numeric_cols or req.y_column not in numeric_cols:
            raise HTTPException(status_code=400, detail="Scatter chart requires two numeric columns.")
        sub = df[[req.x_column, req.y_column]].dropna()
        if len(sub) > 300:
            sub = sub.sample(300, random_state=42)
        data = [{"x_val": float(row[req.x_column]), "y_val": float(row[req.y_column])} for _, row in sub.iterrows()]
        return {
            "chart_type": "scatter",
            "label": f"{req.y_column} vs {req.x_column}",
            "x_axis_label": req.x_column,
            "y_axis_label": req.y_column,
            "data": data,
        }

    # ---------- BAR / PIE: group x_column, aggregate y_column (or count) ----------
    use_count = (not req.y_column) or (req.y_column not in numeric_cols) or (agg == 'count')
    if use_count:
        grouped = df.groupby(req.x_column).size()
        label = f"Count of records by {req.x_column}"
    else:
        grouped = df.groupby(req.x_column)[req.y_column].agg(agg)
        label = f"{agg.capitalize()} {req.y_column} by {req.x_column}"

    grouped = grouped.dropna().sort_values(ascending=False).head(12)

    if chart_type == 'bar':
        data = [{"category": str(k), "value": round(float(v), 3)} for k, v in grouped.items()]
        return {"chart_type": "bar", "label": label, "x_axis_label": req.x_column, "y_axis_label": label, "data": data}
    else:  # pie
        data = [{"x_val": str(k), "y_val": round(float(v), 3)} for k, v in grouped.items()]
        return {"chart_type": "pie", "label": label, "data": data}


@app.get("/api/dataset/preview")
async def get_dataset_preview():
    if not os.path.exists(DB_PATH):
        return []
    conn = sqlite3.connect(DB_PATH)
    df = pd.read_sql_query("SELECT * FROM customers LIMIT 25", conn)
    conn.close()
    return [{"_row_index": idx, **row.to_dict()} for idx, row in df.fillna("").iterrows()]


@app.get("/api/ai/briefing")
async def get_ai_brief():
    summary = await get_dynamic_summary()
    prompt = (
        "Act as an elite corporate advisor. Analyze this summary: "
        f"{summary['numeric_aggregates']}. Provide a health brief report."
    )
    try:
        briefing_text = _call_ollama(prompt)
        return {"briefing": briefing_text}
    except RuntimeError as e:
        return {"briefing": f"### System Notice\n{str(e)}"}


@app.post("/api/ai/ask")
async def ask_dataset_question(req: AskQuestionRequest):
    """AI Boardroom Assistant Q&A endpoint.

    Two-stage pipeline so the assistant can answer ANY question about the
    active dataset, not just ones covered by the pre-computed stats context:

      Stage 1 (SQL planning): ask the model whether this question needs an
      exact figure that requires querying the live table (a filter, a
      group-by on an arbitrary column, a count/sum/avg with conditions, a
      top-N lookup, etc). If so, have it draft a single read-only SELECT.
      That SQL is validated (SELECT-only, references `customers`, no
      dangerous keywords) and executed directly against the SQLite table.

      Stage 2 (answer generation): the final answer is generated using the
      existing statistical context PLUS the real query result (if any) as
      ground truth, so numeric answers are actually correct instead of only
      approximated from the pre-computed summary.

    Purely qualitative questions ("summarize the key patterns") skip the SQL
    step naturally (the model says needs_query: false) and behave exactly as
    before. Both stages now run against the local Ollama model instead of
    Gemini.
    """
    df = _load_active_dataframe()
    if df is None or df.empty:
        raise HTTPException(status_code=400, detail="No dataset loaded. Upload a CSV first.")

    if not req.question or not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    question = req.question.strip()
    active_filename = _get_active_filename()
    schema_overview = _build_schema_overview(df)

    history_text = ""
    if req.history:
        turns = []
        for turn in req.history[-6:]:
            role = "User" if turn.get("role") == "user" else "Assistant"
            turns.append(f"{role}: {turn.get('content', '')}")
        history_text = "\n".join(turns)

    # ---- Stage 1: decide whether an exact SQL query is needed ----
    sql_planning_prompt = (
        "You are a data-analyst assistant working against a SQLite table called `customers` "
        f"(currently loaded file: '{active_filename}'). Schema with sample values:\n\n"
        f"{schema_overview}\n\n"
        + (f"CONVERSATION SO FAR:\n{history_text}\n\n" if history_text else "")
        + f"USER QUESTION: {question}\n\n"
        "Decide whether answering this precisely requires running a SQL query "
        "(sums, counts, averages, filters, top-N, group-by comparisons, specific lookups). "
        "If it's general/qualitative, no query is needed.\n\n"
        "Respond with ONLY a JSON object, no markdown fences, no extra text:\n"
        '{"needs_query": true or false, "sql": "a single valid SQLite SELECT statement against '
        'the customers table, or null"}\n'
        "Rules: SELECT only, must reference `customers`, only real column names from the schema above, "
        "no semicolons, no comments."
    )

    query_columns, query_rows, query_error, sql_used = [], [], None, None
    try:
        plan_text = _call_ollama(sql_planning_prompt)
        plan = _extract_json_block(plan_text)
        if plan and plan.get("needs_query") and plan.get("sql"):
            candidate_sql = plan["sql"]
            if _is_safe_select_query(candidate_sql):
                sql_used = candidate_sql
                try:
                    query_columns, query_rows = _execute_sql_query(sql_used)
                except Exception as e:
                    query_error = str(e)
            else:
                query_error = "Generated query failed safety validation and was discarded."
    except RuntimeError as e:
        query_error = f"Query planning step failed: {e}"

    # ---- Stage 2: answer using the exact query result (if any) + stats context ----
    context = _build_dataset_context(df, active_filename)

    query_block = ""
    if sql_used and not query_error:
        query_block = (
            f"\n\nEXACT QUERY RESULT (ran live against the dataset, treat as ground truth):\n"
            f"SQL: {sql_used}\n"
            f"Columns: {query_columns}\n"
            f"Rows: {json.dumps(query_rows, default=str)[:4000]}\n"
        )
    elif sql_used and query_error:
        query_block = (
            f"\n\nNote: a precise SQL query attempt failed ({query_error}). "
            "Answer as best you can from the statistical context below, and be honest about any limits."
        )

    prompt = (
        "You are the AI Boardroom Assistant embedded inside a business analytics dashboard called StratAI. "
        "A business user has uploaded a dataset and is asking you questions about it in plain English. "
        "Answer using ONLY the statistical context and/or exact query result below -- never invent figures "
        "that aren't derivable from them. If neither source has enough information, say so honestly and "
        "explain what additional data or column would be needed. Keep answers concise and business-friendly, "
        "and cite exact numbers wherever possible.\n\n"
        f"DATASET CONTEXT (JSON):\n{json.dumps(context, default=str)}"
        f"{query_block}\n\n"
        + (f"CONVERSATION SO FAR:\n{history_text}\n\n" if history_text else "")
        + f"USER QUESTION: {question}"
    )

    try:
        answer_text = _call_ollama(prompt)
        result = {"answer": answer_text}
        if sql_used and not query_error:
            result["sql_used"] = sql_used
        return result
    except RuntimeError as e:
        return {"answer": f"### Error\n{str(e)}"}


def _linear_forecast_series(series, forecast_steps=12):
    """Fits a simple linear trend to a numeric series and projects it
    forward. Returns chart-ready points (actual + projected, with the two
    lines meeting at the last real data point) plus the fitted slope."""
    values = series.dropna().reset_index(drop=True)
    n = len(values)
    if n == 0:
        return [], 0.0, 0.0

    x = np.arange(n)
    if n >= 2:
        slope, intercept = np.polyfit(x, values.values.astype(float), 1)
    else:
        slope, intercept = 0.0, float(values.iloc[0])

    chart_points = []
    for i in range(n):
        chart_points.append({"x_val": int(i), "actual": round(float(values.iloc[i]), 3), "projected": None})
    if chart_points:
        # Connect the projected line to the last real point for a continuous chart.
        chart_points[-1]["projected"] = chart_points[-1]["actual"]

    for step in range(1, forecast_steps + 1):
        proj_x = n - 1 + step
        proj_y = slope * proj_x + intercept
        chart_points.append({"x_val": int(proj_x), "actual": None, "projected": round(float(proj_y), 3)})

    return chart_points, float(slope), float(intercept)


def _rule_based_forecast_recommendations(forecast_context):
    """Computes measures and suggestions DIRECTLY from the dataset's own
    statistics -- no external AI call required. This is what the Predictive
    Forecast Engine falls back to if Ollama is unreachable, so the panel
    always gives real, dataset-grounded guidance instead of a placeholder
    notice."""
    trend_col = forecast_context["primary_trend_column"]
    direction = forecast_context["trend_direction"]
    growth_rate = forecast_context["projected_growth_rate_pct"]
    current_avg = forecast_context["current_avg"]
    projected_avg = forecast_context["projected_avg"]
    key_measures = forecast_context.get("key_measures", [])
    breakdown_col = forecast_context.get("breakdown_column")
    breakdown_avgs = forecast_context.get("breakdown_averages") or {}

    direction_phrase = {
        "rising": "trending upward",
        "falling": "trending downward",
        "volatile": "fluctuating significantly",
        "stable": "holding steady",
    }.get(direction, "showing no clear pattern")

    summary = (
        f"### Forecast Summary\n"
        f"'{trend_col}' is currently averaging {current_avg} and is {direction_phrase}. "
        f"The linear projection puts it at roughly {projected_avg} going forward "
        f"({'+' if growth_rate >= 0 else ''}{growth_rate}% relative to the current average)."
    )

    suggestions = []

    if direction == "falling":
        suggestions.append(
            f"'{trend_col}' is declining — investigate what changed around the point it started slipping "
            f"(process, quality, staffing, or capacity shifts) before the projected drop compounds further."
        )
    elif direction == "rising":
        suggestions.append(
            f"'{trend_col}' is improving — identify what's driving the gain and reinforce it (resourcing, "
            f"process changes, etc.) so the trend holds instead of reverting once conditions change."
        )
    elif direction == "volatile":
        suggestions.append(
            f"'{trend_col}' is fluctuating heavily — standardize the underlying process to reduce variance; "
            f"volatility this high makes forecasts unreliable and usually signals an inconsistent workflow."
        )
    else:
        suggestions.append(
            f"'{trend_col}' is flat — this is a stable baseline. If growth is a goal, it will likely need a "
            f"deliberate intervention rather than relying on organic movement."
        )

    if breakdown_col and breakdown_avgs:
        sorted_groups = sorted(breakdown_avgs.items(), key=lambda kv: kv[1])
        lowest_cat, lowest_val = sorted_groups[0]
        highest_cat, highest_val = sorted_groups[-1]
        if lowest_cat != highest_cat:
            suggestions.append(
                f"Within '{breakdown_col}', '{lowest_cat}' underperforms at {lowest_val} average {trend_col} "
                f"versus '{highest_cat}' at {highest_val} — study what the top group does differently and "
                f"apply it to '{lowest_cat}'."
            )

    for m in key_measures:
        if m["metric"] == trend_col:
            continue
        if m["trend"] == "falling" and abs(m["pct_change"]) >= 1:
            suggestions.append(
                f"'{m['metric']}' is also declining ({m['current_value']} → {m['projected_value']}, "
                f"{m['pct_change']}%) — worth reviewing alongside {trend_col} in case the causes overlap."
            )
        elif m["trend"] == "rising" and abs(m["pct_change"]) >= 1:
            suggestions.append(
                f"'{m['metric']}' is climbing ({m['current_value']} → {m['projected_value']}, "
                f"+{m['pct_change']}%) — a positive signal worth investigating and replicating elsewhere."
            )

    if not suggestions:
        suggestions.append("No strong signals detected yet in this dataset — keep monitoring as more data comes in.")

    suggestions_block = "### Suggested Measures\n" + "\n".join(f"- {s}" for s in suggestions)
    footnote = "_Generated directly from the dataset's statistics (Ollama unreachable -- start it with `ollama serve` for richer, narrative-style recommendations)._"

    return f"{summary}\n\n{suggestions_block}\n\n{footnote}"


def _generate_forecast_recommendations(forecast_context):
    """Prefers an AI-narrated version via the local Ollama model, but ALWAYS
    falls back to the deterministic, dataset-grounded version above if Ollama
    is unreachable -- the panel should never just error out and stop there."""
    prompt = (
        "You are a forecasting analyst embedded in a business dashboard called StratAI. Below is a JSON context "
        "derived from a linear-regression projection of this dataset's key trend column, its breakdown by "
        "category, and the top individual metrics with their current vs. projected values. Using ONLY this "
        "context (never invent numbers that aren't in it), write: "
        "1) A short paragraph on what's changing and why it matters, and "
        "2) 3-5 specific, actionable suggestions on what to change, each tied directly to a number in the "
        "context. Keep it concise and business-focused.\n\n"
        f"FORECAST CONTEXT (JSON):\n{json.dumps(forecast_context, default=str)}"
    )
    try:
        return _call_ollama(prompt)
    except RuntimeError:
        # Don't surface a raw error in the UI -- fall back to the deterministic
        # measures so the panel still gives useful, dataset-grounded output.
        return _rule_based_forecast_recommendations(forecast_context)


@app.get("/api/analytics/forecast")
async def get_predictive_forecast():
    df = _load_active_dataframe()
    if df is None or df.empty:
        return {}

    total_rows = len(df)
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    text_cols = df.select_dtypes(exclude=[np.number]).columns.tolist()

    # Same column-selection logic as the Analytics Dashboards charts, so the
    # forecast is built on exactly what the user is already looking at.
    ranked_numeric = _rank_numeric_columns(df, numeric_cols, total_rows)
    if not ranked_numeric:
        return {}
    trend_col = ranked_numeric[0][0]
    pie_col = _pick_categorical_column(df, text_cols)

    series = df[trend_col].dropna().head(60)
    chart_points, slope, intercept = _linear_forecast_series(series, forecast_steps=12)
    direction = _trend_direction(series.tolist())

    current_avg = round(float(series.mean()), 2) if not series.empty else 0.0
    projected_only = [p["projected"] for p in chart_points if p["projected"] is not None and p["actual"] is None]
    projected_avg = round(float(np.mean(projected_only)), 2) if projected_only else current_avg
    growth_rate = round(((projected_avg - current_avg) / current_avg) * 100, 2) if current_avg else 0.0

    # Per-metric measures: top numeric columns, each with its own short-horizon
    # projection, so the panel reads like "what's about to change, and by how much".
    key_measures = []
    for col, _cv in ranked_numeric[:4]:
        col_series = df[col].dropna().head(60)
        if col_series.empty:
            continue
        col_points, _, _ = _linear_forecast_series(col_series, forecast_steps=6)
        col_projected_only = [p["projected"] for p in col_points if p["projected"] is not None and p["actual"] is None]
        cur_avg = float(col_series.mean())
        proj_avg = float(np.mean(col_projected_only)) if col_projected_only else cur_avg
        pct_change = round(((proj_avg - cur_avg) / cur_avg) * 100, 2) if cur_avg else 0.0
        key_measures.append({
            "metric": col,
            "current_value": round(cur_avg, 2),
            "projected_value": round(proj_avg, 2),
            "pct_change": pct_change,
            "trend": _trend_direction(col_series.tolist()),
        })

    comparison_context = None
    if pie_col:
        grouped = df.groupby(pie_col)[trend_col].mean().sort_values(ascending=False).head(6)
        comparison_context = {str(k): round(float(v), 2) for k, v in grouped.items()}

    forecast_context = {
        "primary_trend_column": trend_col,
        "trend_direction": direction,
        "current_avg": current_avg,
        "projected_avg": projected_avg,
        "projected_growth_rate_pct": growth_rate,
        "key_measures": key_measures,
        "breakdown_column": pie_col,
        "breakdown_averages": comparison_context,
    }
    ai_recommendations = _generate_forecast_recommendations(forecast_context)

    return {
        "trend_column": trend_col,
        "forecast_data": chart_points,
        "direction": direction,
        "current_avg": current_avg,
        "projected_avg": projected_avg,
        "growth_rate": growth_rate,
        "key_measures": key_measures,
        "comparison_column": pie_col,
        "comparison_context": comparison_context,
        "ai_recommendations": ai_recommendations,
    }