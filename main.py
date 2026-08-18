"""
main.py
-------
FastAPI application entry point for the Corporate Studio AI middleware.

Run locally::

    uvicorn main:app --reload

Deploy on Render (port injected by the platform)::

    uvicorn main:app --host 0.0.0.0 --port $PORT
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import config
from routers.agent_router import router as agent_router
from services.crm_service import zoho_service


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Open the shared httpx client on startup, close it on shutdown."""
    await zoho_service.start()
    yield
    await zoho_service.close()


app = FastAPI(
    title=config.APP_NAME,
    description=(
        "FastAPI middleware between the Corporate Studio AI agent and Zoho CRM. "
        "Routes are mounted under /api/crm; every record is sanitized into "
        "lightweight flat JSON before it reaches the agent."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# CORS: default is allow-all (fine for internal middleware). Pin down via the
# CORS_ORIGINS environment variable (comma-separated) for production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=len(config.CORS_ORIGINS) == 1 and config.CORS_ORIGINS[0] != "*",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agent_router, prefix="/api/crm")


@app.get("/", tags=["health"])
@app.get("/health", tags=["health"])
@app.get("/api/health", tags=["health"])
async def health() -> dict:
    """Liveness probe — always reachable, even when Zoho is down."""
    return {"status": "ok"}
