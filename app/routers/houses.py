from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.cache import houses_cache
from app import models, schemas
from app.database import get_db

router = APIRouter(prefix="/api/houses", tags=["houses"])


@router.get("/", response_model=List[schemas.HouseRead])
def read_houses(db: Session = Depends(get_db)) -> List[schemas.HouseRead]:
    cached = houses_cache.get("all")
    if cached is not None:
        return cached

    houses = (
        db.query(models.House)
        .options(joinedload(models.House.comments))
        .order_by(models.House.created_at.desc())
        .all()
    )
    result = [schemas.HouseRead.from_orm(house) for house in houses]
    houses_cache.set("all", result)
    return result


@router.get("/{house_id}", response_model=schemas.HouseRead)
def read_house(house_id: int, db: Session = Depends(get_db)) -> schemas.HouseRead:
    house = (
        db.query(models.House)
        .options(joinedload(models.House.comments))
        .filter(models.House.id == house_id)
        .first()
    )
    if not house:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="House not found")
    return schemas.HouseRead.from_orm(house)


@router.post("/", response_model=schemas.HouseRead, status_code=status.HTTP_201_CREATED)
def create_house(house_in: schemas.HouseCreate, db: Session = Depends(get_db)) -> schemas.HouseRead:
    house = models.House(**house_in.dict())
    db.add(house)
    db.commit()
    db.refresh(house)
    houses_cache.clear()
    db_house = (
        db.query(models.House)
        .options(joinedload(models.House.comments))
        .filter(models.House.id == house.id)
        .first()
    )
    return schemas.HouseRead.from_orm(db_house)


@router.put("/{house_id}", response_model=schemas.HouseRead)
def update_house(house_id: int, house_in: schemas.HouseUpdate, db: Session = Depends(get_db)) -> schemas.HouseRead:
    house = db.query(models.House).filter(models.House.id == house_id).first()
    if not house:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="House not found")

    for field, value in house_in.dict(exclude_unset=True).items():
        setattr(house, field, value)

    db.add(house)
    db.commit()
    db.refresh(house)
    houses_cache.clear()
    db_house = (
        db.query(models.House)
        .options(joinedload(models.House.comments))
        .filter(models.House.id == house.id)
        .first()
    )
    return schemas.HouseRead.from_orm(db_house)


@router.delete("/{house_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_house(house_id: int, db: Session = Depends(get_db)) -> None:
    house = db.query(models.House).filter(models.House.id == house_id).first()
    if not house:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="House not found")

    db.delete(house)
    db.commit()
    houses_cache.clear()