import logging
import os
import sys
from pathlib import Path
from typing import List

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session, joinedload


PROJECT_ROOT = Path(__file__).resolve().parent.parent

if __package__ in {None, ""}:
    if str(PROJECT_ROOT) not in sys.path:
        sys.path.append(str(PROJECT_ROOT))

# Ensure environment variables from a local .env file are available when running
# the application without Docker. Missing API keys prevented the Yandex map from
# initialising on start.
load_dotenv(PROJECT_ROOT / ".env")

from app import schemas
from app.cache import houses_cache
from app.database import SessionLocal, init_db
from app.models import House
from app.routers import buildings, comments, houses


def configure_logging() -> None:
    log_level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    log_level = getattr(logging, log_level_name, logging.INFO)
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )


configure_logging()

logger = logging.getLogger(__name__)

app = FastAPI(title="FlatDrawer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

app.include_router(houses.router)
app.include_router(comments.router)
app.include_router(buildings.router)


@app.on_event("startup")
def on_startup() -> None:
    logger.info("Starting FlatDrawer application")
    init_db()
    db = SessionLocal()
    try:
        logger.debug("Preloading houses cache during startup")
        preload_houses_cache(db)
    finally:
        db.close()
        logger.debug("Database session closed after startup preload")


def preload_houses_cache(db: Session) -> None:
    logger.debug("Loading houses from the database to warm the cache")
    houses: List[House] = (
        db.query(House)
        .options(joinedload(House.comments))
        .order_by(House.created_at.desc())
        .all()
    )
    serialized = [schemas.HouseRead.from_orm(house) for house in houses]
    houses_cache.set("all", serialized)
    logger.info("Preloaded %d houses into cache", len(serialized))


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> HTMLResponse:
    yandex_maps_api_key = os.getenv("YANDEX_MAPS_API_KEY", "")
    logger.debug("Rendering index page. API key present: %s", bool(yandex_maps_api_key))
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "yandex_maps_api_key": yandex_maps_api_key,
        },
    )
