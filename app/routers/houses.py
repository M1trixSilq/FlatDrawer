import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.cache import houses_cache
from app import models, schemas
from app.database import get_db
from app.services import building_detector

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/houses", tags=["houses"])


@router.get("/", response_model=List[schemas.HouseRead])
def read_houses(db: Session = Depends(get_db)) -> List[schemas.HouseRead]:
    cached = houses_cache.get("all")
    if cached is not None:
        logger.debug("Returning %d houses from cache", len(cached))
        return cached

    houses = (
        db.query(models.House)
        .options(joinedload(models.House.comments))
        .order_by(models.House.created_at.desc())
        .all()
    )
    logger.info("Fetched %d houses from database", len(houses))
    result = [schemas.HouseRead.from_orm(house) for house in houses]
    houses_cache.set("all", result)
    logger.debug("Stored %d houses in cache", len(result))
    return result


@router.get("/{house_id}", response_model=schemas.HouseRead)
def read_house(house_id: int, db: Session = Depends(get_db)) -> schemas.HouseRead:
    logger.debug("Fetching house with id=%s", house_id)
    house = (
        db.query(models.House)
        .options(joinedload(models.House.comments))
        .filter(models.House.id == house_id)
        .first()
    )
    if not house:
        logger.warning("House with id=%s not found", house_id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="House not found")
    return schemas.HouseRead.from_orm(house)


@router.post("/", response_model=schemas.HouseRead, status_code=status.HTTP_201_CREATED)
async def create_house(
    house_in: schemas.HouseCreate, db: Session = Depends(get_db)
) -> schemas.HouseRead:
    logger.info("Creating new house entry")

    resolved_address = None
    try:
        _, resolved_address = await building_detector.resolve_building_geometry(
            house_in.latitude, house_in.longitude
        )
    except Exception:  # noqa: BLE001 - best effort enrichment
        logger.exception(
            "Failed to resolve address for coordinates lat=%s lon=%s",
            house_in.latitude,
            house_in.longitude,
        )

    house_data = house_in.dict(exclude_unset=True)
    if resolved_address:
        house_data["address"] = resolved_address
        logger.debug("Address resolved automatically: %s", resolved_address)
    else:
        submitted_address = house_data.get("address")
        if submitted_address:
            logger.debug(
                "Using submitted address for lat=%s lon=%s",
                house_in.latitude,
                house_in.longitude,
            )
        else:
            fallback_address = "Адрес не определен"
            house_data["address"] = fallback_address
            logger.debug(
                "Fallback address applied for lat=%s lon=%s", house_in.latitude, house_in.longitude
            )

    house = models.House(**house_data)
    db.add(house)
    db.commit()
    db.refresh(house)
    houses_cache.clear()
    logger.debug("Cache cleared after creating house id=%s", house.id)
    db_house = (
        db.query(models.House)
        .options(joinedload(models.House.comments))
        .filter(models.House.id == house.id)
        .first()
    )
    logger.info("Created house with id=%s", house.id)
    return schemas.HouseRead.from_orm(db_house)


@router.put("/{house_id}", response_model=schemas.HouseRead)
def update_house(house_id: int, house_in: schemas.HouseUpdate, db: Session = Depends(get_db)) -> schemas.HouseRead:
    logger.info("Updating house id=%s", house_id)
    house = db.query(models.House).filter(models.House.id == house_id).first()
    if not house:
        logger.warning("Attempted to update non-existent house id=%s", house_id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="House not found")

    for field, value in house_in.dict(exclude_unset=True).items():
        setattr(house, field, value)

    db.add(house)
    db.commit()
    db.refresh(house)
    houses_cache.clear()
    logger.debug("Cache cleared after updating house id=%s", house.id)
    db_house = (
        db.query(models.House)
        .options(joinedload(models.House.comments))
        .filter(models.House.id == house.id)
        .first()
    )
    logger.info("Updated house id=%s", house.id)
    return schemas.HouseRead.from_orm(db_house)


@router.delete("/{house_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_house(house_id: int, db: Session = Depends(get_db)) -> None:
    logger.info("Deleting house id=%s", house_id)
    house = db.query(models.House).filter(models.House.id == house_id).first()
    if not house:
        logger.warning("Attempted to delete non-existent house id=%s", house_id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="House not found")

    db.delete(house)
    db.commit()
    houses_cache.clear()
    logger.debug("Cache cleared after deleting house id=%s", house_id)
