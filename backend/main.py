"""
Insight Backend — Cloud Run Service
====================================
Single endpoint: POST /summarise
Receives derived chart statistics from the frontend (never raw data),
calls the Gemini API, and returns a structured AI summary.

Environment variables required:
  GEMINI_API_KEY   — your Google AI Studio API key
  ALLOWED_ORIGIN   — frontend origin for CORS, e.g. https://nctjinn.github.io
                     defaults to * (open) for local dev; lock this in production.
"""

import os
import json
import logging
from typing import Optional

import google.generativeai as genai
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# ── App ────────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Insight API",
    version="1.0.0",
    docs_url="/docs",       # disable in prod if desired: docs_url=None
    redoc_url=None,
)

# ── CORS ───────────────────────────────────────────────────────────────────────
# In production set ALLOWED_ORIGIN to your exact GitHub Pages URL.
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN] if ALLOWED_ORIGIN != "*" else ["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# ── Gemini client ──────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    log.warning("GEMINI_API_KEY not set — /summarise will return 503.")

def get_model():
    """Initialise the Gemini model. Called per-request so key changes take effect."""
    if not GEMINI_API_KEY:
        return None
    genai.configure(api_key=GEMINI_API_KEY)
    return genai.GenerativeModel(
        model_name="gemini-flash-latest",
        system_instruction=SYSTEM_PROMPT,
        generation_config={
            "temperature": 0.1,
            "response_mime_type": "application/json",
        },
    )

# ── System prompt ──────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """
You are a data analyst assistant for the Insight dashboard application.
You receive derived statistics (never raw data) for a single chart and return
a concise, insightful summary.

OUTPUT FORMAT — respond with valid JSON only, matching this exact schema:
{
  "summary": "<2–3 sentence plain-English analysis. Maximum 60 words.>",
  "trend": "upward" | "downward" | "stable" | "mixed",
  "highlights": ["<short highlight>", "<short highlight>"]
}

RULES:
- summary must be 60 words or fewer.
- highlights: exactly 2 items, each under 10 words.
- Never invent data not present in the statistics.
- Output the JSON object only — no markdown, no code fences, no extra text.
"""

# ── Request / Response models ──────────────────────────────────────────────────
class NumericStats(BaseModel):
    mean:         float
    median:       float
    std:          float
    min:          float
    max:          float
    trend:        str                           # upward | downward | stable
    growth_rate:  Optional[float] = None
    peak_index:   Optional[int]   = None
    trough_index: Optional[int]   = None
    row_count:    Optional[int]   = None

class SummariseRequest(BaseModel):
    chart_title:          str   = Field(..., description="Title of the chart being summarised")
    chart_type:           str   = Field(..., description="line | bar | area | donut")
    x_column:             str   = Field(..., description="Name of the x-axis column")
    y_column:             str   = Field(..., description="Name of the y-axis column")
    y_stats:              NumericStats = Field(..., description="Derived stats for the y-axis column")
    x_sample:             Optional[list]  = Field(None, description="Up to 20 representative x-axis labels")
    custom_instructions:  Optional[str]   = Field(None, description="Extra domain-specific instructions loaded from a ./prompts/ file on the frontend")

class SummariseResponse(BaseModel):
    summary:    str
    trend:      str
    highlights: list[str]
    model:      str          # which Gemini model was used
    cached:     bool = False # reserved for future response caching

# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    """Cloud Run health check — always returns 200."""
    return {"status": "ok", "gemini_key_set": bool(GEMINI_API_KEY)}


@app.post("/summarise", response_model=SummariseResponse)
async def summarise(req: SummariseRequest):
    """
    Receive derived chart stats, call Gemini, return structured summary.
    Raw data never reaches this endpoint — only statistics.
    """
    model = get_model()
    if not model:
        raise HTTPException(
            status_code=503,
            detail="GEMINI_API_KEY is not configured on the server."
        )

    # Build the prompt from derived stats — never includes raw row data
    prompt = build_prompt(req)
    log.info("Summarise request: chart='%s' y='%s' trend=%s",
             req.chart_title, req.y_column, req.y_stats.trend)

    try:
        response = model.generate_content(prompt)
        raw_text = response.text.strip()
        log.info("Gemini raw response length: %d chars", len(raw_text))
    except Exception as exc:
        log.error("Gemini API error: %s", exc)
        raise HTTPException(status_code=502, detail=f"Gemini API error: {exc}")

    # Parse JSON response
    try:
        parsed = parse_gemini_response(raw_text)
    except ValueError as exc:
        log.error("Failed to parse Gemini response: %s\nRaw: %s", exc, raw_text)
        raise HTTPException(
            status_code=502,
            detail=f"Gemini returned malformed JSON: {exc}"
        )

    return SummariseResponse(
        summary    = parsed["summary"],
        trend      = parsed.get("trend", req.y_stats.trend),
        highlights = parsed.get("highlights", []),
        model      = "gemini-flash-latest",
    )


# ── Helpers ────────────────────────────────────────────────────────────────────

def build_prompt(req: SummariseRequest) -> str:
    """
    Construct the user-turn prompt from derived stats.
    Only statistical summaries are included — no raw row values.
    If the frontend loaded a template-specific prompt file, its contents
    are appended as domain-specific instructions for the AI.
    """
    s = req.y_stats
    lines = [
        f"Chart title:  {req.chart_title}",
        f"Chart type:   {req.chart_type}",
        f"X-axis:       {req.x_column}",
        f"Y-axis:       {req.y_column}",
        "",
        "Y-axis statistics:",
        f"  Mean:        {s.mean:.4f}",
        f"  Median:      {s.median:.4f}",
        f"  Std dev:     {s.std:.4f}",
        f"  Min:         {s.min}",
        f"  Max:         {s.max}",
        f"  Trend:       {s.trend}",
    ]

    if s.growth_rate is not None:
        lines.append(f"  Growth rate: {s.growth_rate:.2f}%")
    if s.row_count is not None:
        lines.append(f"  Row count:   {s.row_count}")

    if req.x_sample:
        sample = req.x_sample[:20]   # cap at 20 labels
        lines.append(f"\nX-axis label sample: {json.dumps(sample)}")

    if req.custom_instructions:
        instructions = req.custom_instructions.strip()
        if instructions:
            lines.append("\n── Domain-specific instructions ──")
            lines.append(instructions)
            log.info("Prompt augmented with custom instructions (%d chars)", len(instructions))

    lines.append("\nReturn the JSON summary as specified in your instructions.")
    return "\n".join(lines)

import re
import json

def parse_gemini_response(text: str) -> dict:
    """
    Extracts and parses JSON from Gemini's response. 
    Handles markdown fences, leading/trailing text, and minor truncations.
    """
    original_text = text
    
    # 1. Try to find the first '{' and the last '}' to extract only the JSON object.
    # This ignores any "Sure, here is the JSON:" preamble or trailing markdown fences.
    match = re.search(r"(\{.*\}|\[.*\])", text, re.DOTALL)
    if match:
        text = match.group(0)
    
    # 2. Attempt a standard load
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # 3. If standard load fails, try the repair logic for truncated responses
        repaired_text = _attempt_json_repair(text)
        try:
            data = json.loads(repaired_text)
            log.info("Successfully repaired Gemini JSON output.")
            return data
        except json.JSONDecodeError as exc:
            # Log the full raw text so you can debug it in Cloud Run logs
            log.error(f"Critical JSON Failure. Raw output: {original_text}")
            raise ValueError(f"JSON decode error at {exc.lineno}:{exc.colno}: {exc.msg}")

    # 4. Final Validation of keys
    required = {"summary", "trend", "highlights"}
    missing = required - data.keys()
    if missing:
        raise ValueError(f"Missing keys in Gemini response: {missing}")

    return data


def _attempt_json_repair(text: str) -> str:
    """
    Best-effort repair of truncated JSON from Gemini.
    Tries progressively truncating to the last complete top-level value.
    """
    # Already valid — return as-is
    try:
        json.loads(text)
        return text
    except json.JSONDecodeError:
        pass

    # Try trimming to the last closing brace
    last_brace = text.rfind("}")
    if last_brace != -1:
        candidate = text[: last_brace + 1]
        try:
            json.loads(candidate)
            log.warning("Repaired truncated Gemini JSON by trimming to last '}'")
            return candidate
        except json.JSONDecodeError:
            pass

    # No repair possible — return original and let caller raise
    return text


# ── Dev server entrypoint ──────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True)