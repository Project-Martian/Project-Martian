"""Project Martian static publication and same-origin Bedrock/MCP API."""
import logging
import os
import threading
import time
from collections import deque
from pathlib import Path
from urllib.parse import urlsplit

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.staticfiles import StaticFiles

from server.assistant import MODEL_ID, answer_question
from server.mcp_records import BY_ID
from server.models import AskInput

ROOT = Path(__file__).resolve().parent.parent
ENABLED = os.getenv("MARTIAN_ASK_ENABLED", "true").lower() == "true"
HOSTS = os.getenv("MARTIAN_ASK_ALLOWED_HOSTS", "127.0.0.1,localhost,projectmartian.ai,www.projectmartian.ai").split(",")
CAPACITY = int(os.getenv("MARTIAN_ASK_CONCURRENCY", "2"))
HOURLY_LIMIT = int(os.getenv("MARTIAN_ASK_REQUESTS_PER_HOUR", "300"))
if CAPACITY < 1 or HOURLY_LIMIT < 1:
    raise ValueError("Ask limits must be positive")
SLOTS = threading.BoundedSemaphore(CAPACITY)
RATE_LOCK = threading.Lock()
ADMISSIONS = deque()
LOGGER = logging.getLogger("project_martian.ask")


class PublicHostMiddleware(TrustedHostMiddleware):
    async def __call__(self, scope, receive, send):
        # ALB health probes use a target IP as Host. This route never calls AWS.
        if scope.get("path") == "/healthz":
            await self.app(scope, receive, send)
        else:
            await super().__call__(scope, receive, send)


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(PublicHostMiddleware, allowed_hosts=HOSTS)


@app.middleware("http")
async def response_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else "no-cache"
    return response


@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.get("/api/config")
def public_config():
    return {"enabled": ENABLED, "provider": "Amazon Bedrock", "model_id": MODEL_ID,
            "model_name": "Kimi K2.5" if MODEL_ID == "moonshotai.kimi-k2.5" else MODEL_ID}


@app.post("/api/ask")
async def ask(request: Request):
    if not ENABLED: raise HTTPException(503, "Ask is not enabled on this deployment.")
    # No cross-origin browser access; no browser-held AWS credential or direct Bedrock request.
    origin = request.headers.get("origin")
    if origin:
        try:
            parsed = urlsplit(origin)
            valid_origin = parsed.netloc == request.headers.get("host") and parsed.scheme in ("http", "https")
        except ValueError:
            valid_origin = False
        if not valid_origin: raise HTTPException(403, "Use Ask on the Project Martian website.")
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(415, "Send a JSON question.")
    payload = bytearray()
    async for chunk in request.stream():
        payload.extend(chunk)
        if len(payload) > 65536: raise HTTPException(413, "Question request is too large.")
    try:
        body = AskInput.model_validate_json(payload)
        body.question = body.question.strip()
        if not body.question: raise ValueError("Empty question")
        if any(i not in BY_ID for turn in body.history for i in turn.record_ids):
            raise ValueError("Invalid history")
    except (ValueError, ValidationError):
        raise HTTPException(400, "Send a question of 1–900 characters and at most six valid history turns.") from None
    if not SLOTS.acquire(blocking=False): raise HTTPException(429, "Ask is busy. Please try again shortly.")
    try:
        with RATE_LOCK:
            now = time.monotonic()
            while ADMISSIONS and ADMISSIONS[0] <= now - 3600: ADMISSIONS.popleft()
            if len(ADMISSIONS) >= HOURLY_LIMIT: raise HTTPException(429, "Ask has reached its hourly request limit.")
            ADMISSIONS.append(now)
        return await answer_question(body)
    except (ClientError, BotoCoreError) as error:
        code = error.response["Error"]["Code"] if isinstance(error, ClientError) else type(error).__name__
        LOGGER.warning("Bedrock request failed: %s", code)
        return JSONResponse({"detail": "The AI service is unavailable. Please try again later."}, status_code=503)
    except (ValueError, KeyError) as error:
        LOGGER.warning("Ask response failed validation: %s", type(error).__name__)
        return JSONResponse({"detail": "The AI response could not be validated. Please try again later."}, status_code=502)
    finally:
        SLOTS.release()


# Explicit public assets only: server code, configuration and credentials cannot be served.
for directory in ("css", "js", "data", "assets"):
    app.mount("/" + directory, StaticFiles(directory=ROOT / directory), name=directory)


@app.get("/")
@app.get("/index.html")
def index():
    return FileResponse(ROOT / "index.html")


@app.get("/project-martian-standalone.html")
def standalone():
    return FileResponse(ROOT / "project-martian-standalone.html")
