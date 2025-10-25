from datetime import datetime
from typing import Any, List, Optional

from pydantic import BaseModel, ConfigDict, Field, validator

from app.models import HouseStatus


class CommentBase(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)
    author: Optional[str] = Field(default=None, max_length=255)


class CommentCreate(CommentBase):
    house_id: int


class CommentRead(CommentBase):
    id: int
    house_id: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class HouseBase(BaseModel):
    address: str = Field(..., min_length=3, max_length=255)
    latitude: float
    longitude: float
    status: HouseStatus = Field(default=HouseStatus.YELLOW)

    @validator("latitude")
    def validate_latitude(cls, value: float) -> float:
        if not -90 <= value <= 90:
            raise ValueError("Latitude must be between -90 and 90")
        return value

    @validator("longitude")
    def validate_longitude(cls, value: float) -> float:
        if not -180 <= value <= 180:
            raise ValueError("Longitude must be between -180 and 180")
        return value


class HouseCreate(HouseBase):
    pass


class HouseUpdate(BaseModel):
    address: Optional[str] = Field(default=None, min_length=3, max_length=255)
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    status: Optional[HouseStatus] = None

    @validator("latitude")
    def validate_latitude(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and not -90 <= value <= 90:
            raise ValueError("Latitude must be between -90 and 90")
        return value

    @validator("longitude")
    def validate_longitude(cls, value: Optional[float]) -> Optional[float]:
        if value is not None and not -180 <= value <= 180:
            raise ValueError("Longitude must be between -180 and 180")
        return value


class HouseRead(HouseBase):
    id: int
    created_at: datetime
    updated_at: datetime
    comments: List[CommentRead] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class BuildingGeometry(BaseModel):
    type: str = Field(..., pattern=r"^(Polygon|MultiPolygon)$")
    coordinates: Any


class BuildingRecognitionResponse(BaseModel):
    geometry: Optional[BuildingGeometry]
    address: Optional[str]
