import logging
import os
from contextlib import contextmanager
from typing import Generator

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

logger = logging.getLogger(__name__)

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./flatdrawer.db")

engine_options = {}
if DATABASE_URL.startswith("sqlite"):
    engine_options.update({
        "connect_args": {"check_same_thread": False}
    })

logger.info("Initializing database engine for %s", DATABASE_URL)
engine = create_engine(DATABASE_URL, **engine_options)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db() -> Generator:
    db = SessionLocal()
    logger.debug("Database session opened")
    try:
        yield db
    finally:
        db.close()
        logger.debug("Database session closed")


@contextmanager
def session_scope() -> Generator:
    session = SessionLocal()
    logger.debug("Session scope started")
    try:
        yield session
        session.commit()
        logger.debug("Session scope committed")
    except Exception:
        session.rollback()
        logger.exception("Session scope rolled back due to exception")
        raise
    finally:
        session.close()
        logger.debug("Session scope closed")


def init_db() -> None:
    from app import models  # noqa: F401 - ensure models are imported

    logger.info("Ensuring all database tables are created")
    Base.metadata.create_all(bind=engine)

