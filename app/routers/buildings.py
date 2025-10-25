import logging

from fastapi import APIRouter, HTTPException, Query

from app import schemas
from app.services import building_detector

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/buildings", tags=["buildings"])


@router.get("/resolve", response_model=schemas.BuildingRecognitionResponse)
async def resolve_building(
    lat: float = Query(..., ge=-90.0, le=90.0, description="Latitude of the point"),
    lon: float = Query(..., ge=-180.0, le=180.0, description="Longitude of the point"),
) -> schemas.BuildingRecognitionResponse:
    """Resolve a building footprint and human-readable address for the provided point."""

    try:
        geometry, address = await building_detector.resolve_building_geometry(lat, lon)
    except Exception as exc:  # noqa: BLE001 - broad to convert into HTTP error
        logger.exception("Failed to resolve building geometry")
        raise HTTPException(status_code=502, detail="Failed to resolve building geometry") from exc

    if geometry is None:
        raise HTTPException(status_code=404, detail="Building geometry not found for the specified point")

    return schemas.BuildingRecognitionResponse(geometry=geometry, address=address)
