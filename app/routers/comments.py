import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import models, schemas
from app.cache import houses_cache
from app.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/comments", tags=["comments"])


@router.get("/", response_model=List[schemas.CommentRead])
def read_comments(
    house_id: Optional[int] = Query(default=None, description="Filter comments by house"),
    db: Session = Depends(get_db),
) -> List[schemas.CommentRead]:
    logger.debug("Fetching comments for house_id=%s", house_id)
    query = db.query(models.Comment)
    if house_id is not None:
        logger.debug("Filtering comments by house_id=%s", house_id)
        query = query.filter(models.Comment.house_id == house_id)
    query = query.order_by(models.Comment.created_at.desc())
    comments = query.all()
    logger.info("Fetched %d comments", len(comments))
    return [schemas.CommentRead.from_orm(comment) for comment in comments]


@router.post("/", response_model=schemas.CommentRead, status_code=status.HTTP_201_CREATED)
def create_comment(comment_in: schemas.CommentCreate, db: Session = Depends(get_db)) -> schemas.CommentRead:
    logger.info("Creating comment for house_id=%s", comment_in.house_id)
    house = db.query(models.House).filter(models.House.id == comment_in.house_id).first()
    if not house:
        logger.warning("Failed to create comment: house_id=%s not found", comment_in.house_id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="House not found")

    comment = models.Comment(**comment_in.dict())
    db.add(comment)
    db.commit()
    db.refresh(comment)
    houses_cache.clear()
    logger.info("Created comment with id=%s", comment.id)
    return schemas.CommentRead.from_orm(comment)
