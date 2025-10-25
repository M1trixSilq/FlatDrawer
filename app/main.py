import os
import sys
from pathlib import Path
from typing import List

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session, joinedload


if __package__ in {None, ""}:
    project_root = Path(__file__).resolve().parent.parent
    if str(project_root) not in sys.path:
        sys.path.append(str(project_root))

from app import schemas
from app.cache import houses_cache
from app.database import SessionLocal, init_db
from app.models import House
from app.routers import comments, houses

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


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    db = SessionLocal()
    try:
        preload_houses_cache(db)
    finally:
        db.close()


def preload_houses_cache(db: Session) -> None:
    houses: List[House] = (
        db.query(House)
        .options(joinedload(House.comments))
        .order_by(House.created_at.desc())
        .all()
    )
    serialized = [schemas.HouseRead.from_orm(house) for house in houses]
    houses_cache.set("all", serialized)


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> HTMLResponse:
    yandex_maps_api_key = os.getenv("YANDEX_MAPS_API_KEY", "")
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "yandex_maps_api_key": yandex_maps_api_key,
            "has_api_key": bool(yandex_maps_api_key),
        },
    )