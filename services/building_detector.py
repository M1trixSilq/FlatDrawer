import logging
from typing import Any, Dict, Iterable, List, Optional, Tuple

import httpx

from app.services import yandex_maps

logger = logging.getLogger(__name__)

OVERPASS_API_URL = "https://overpass-api.de/api/interpreter"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
OVERPASS_QUERY_TEMPLATE = (
    "[out:json][timeout:25];"
    "("  # start union
    "way[\"building\"](around:30,{lat},{lon});"
    "relation[\"building\"](around:30,{lat},{lon});"
    ");"
    "out geom;"
)


class BuildingRecognitionError(RuntimeError):
    """Raised when building recognition fails."""


async def resolve_building_geometry(lat: float, lon: float) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Fetch building geometry and a human-readable address for the point."""

    geometries = await _fetch_overpass_geometries(lat, lon)
    selected_geometry: Optional[Dict[str, Any]] = None

    for geometry in geometries:
        if _geometry_contains_point(geometry, (lat, lon)):
            selected_geometry = geometry
            break

    if selected_geometry is None and geometries:
        selected_geometry = geometries[0]

    address = await _reverse_geocode(lat, lon)

    return selected_geometry, address


async def _fetch_overpass_geometries(lat: float, lon: float) -> List[Dict[str, Any]]:
    query = OVERPASS_QUERY_TEMPLATE.format(lat=lat, lon=lon)
    logger.debug("Requesting Overpass data for coordinates lat=%s lon=%s", lat, lon)

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(OVERPASS_API_URL, content=query)

    response.raise_for_status()
    payload = response.json()
    elements = payload.get("elements", []) if isinstance(payload, dict) else []

    geometries: List[Dict[str, Any]] = []
    for element in elements:
        geometry = _convert_overpass_element(element)
        if geometry is not None:
            geometries.append(geometry)

    logger.debug("Resolved %d geometries from Overpass", len(geometries))
    return geometries


async def _reverse_geocode(lat: float, lon: float) -> Optional[str]:
    address = await yandex_maps.reverse_geocode(lat, lon)
    if address:
        return address

    return await _reverse_geocode_nominatim(lat, lon)


async def _reverse_geocode_nominatim(lat: float, lon: float) -> Optional[str]:
    headers = {"User-Agent": "FlatDrawer/1.0 (contact@flatdrawer.local)"}
    params = {
        "format": "jsonv2",
        "lat": f"{lat:.7f}",
        "lon": f"{lon:.7f}",
        "zoom": 18,
        "addressdetails": 1,
    }

    try:
        async with httpx.AsyncClient(timeout=15, headers=headers) as client:
            response = await client.get(NOMINATIM_URL, params=params)
        response.raise_for_status()
        data = response.json()
    except httpx.HTTPError as exc:
        logger.warning(
            "Nominatim reverse geocoding failed for lat=%s lon=%s: %s",
            lat,
            lon,
            exc,
        )
        return None

    if isinstance(data, dict):
        return data.get("display_name") or None
    return None


def _convert_overpass_element(element: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    element_type = element.get("type")
    if element_type == "way":
        ring = _extract_ring_from_geometry(element.get("geometry", []))
        if ring:
            return {"type": "Polygon", "coordinates": [ring]}
        return None

    if element_type == "relation":
        members = element.get("members", [])
        outer_rings: List[List[Tuple[float, float]]] = []
        inner_rings: List[List[Tuple[float, float]]] = []

        for member in members:
            if member.get("type") != "way":
                continue
            ring = _extract_ring_from_geometry(member.get("geometry", []))
            if not ring:
                continue
            role = member.get("role")
            if role == "inner":
                inner_rings.append(ring)
            else:
                outer_rings.append(ring)

        if not outer_rings:
            return None

        polygons: List[List[List[Tuple[float, float]]]] = []
        remaining_inners = inner_rings.copy()

        for outer in outer_rings:
            outer_with_holes: List[List[Tuple[float, float]]] = [outer]
            assigned_indexes: List[int] = []
            for idx, inner in enumerate(remaining_inners):
                if _ring_contains_point(outer, inner[0]):
                    outer_with_holes.append(inner)
                    assigned_indexes.append(idx)
            for index in reversed(assigned_indexes):
                remaining_inners.pop(index)
            polygons.append(outer_with_holes)

        if len(polygons) == 1:
            return {"type": "Polygon", "coordinates": polygons[0]}
        return {"type": "MultiPolygon", "coordinates": polygons}

    return None


def _extract_ring_from_geometry(nodes: Iterable[Dict[str, Any]]) -> Optional[List[Tuple[float, float]]]:
    coordinates: List[Tuple[float, float]] = []
    for node in nodes or []:
        lat = node.get("lat")
        lon = node.get("lon")
        if lat is None or lon is None:
            continue
        coordinates.append((float(lat), float(lon)))

    if len(coordinates) < 3:
        return None

    if coordinates[0] != coordinates[-1]:
        coordinates.append(coordinates[0])

    if len(coordinates) < 4:
        return None

    return coordinates


def _ring_contains_point(ring: List[Tuple[float, float]], point: Tuple[float, float]) -> bool:
    return _is_point_in_ring(ring, point)


def _geometry_contains_point(geometry: Dict[str, Any], point: Tuple[float, float]) -> bool:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon":
        return _polygon_contains_point(coordinates, point)
    if geometry_type == "MultiPolygon":
        for polygon in coordinates or []:
            if _polygon_contains_point(polygon, point):
                return True
    return False


def _polygon_contains_point(polygon: Any, point: Tuple[float, float]) -> bool:
    if not isinstance(polygon, list) or not polygon:
        return False

    outer = polygon[0]
    if not _is_point_in_ring(outer, point):
        return False

    for hole in polygon[1:]:
        if _is_point_in_ring(hole, point):
            return False

    return True


def _is_point_in_ring(ring: Iterable[Tuple[float, float]], point: Tuple[float, float]) -> bool:
    target_lat, target_lon = point
    inside = False
    ring_points = list(ring)
    if len(ring_points) < 3:
        return False

    for i in range(len(ring_points)):
        j = (i - 1) % len(ring_points)
        lat_i, lon_i = ring_points[i]
        lat_j, lon_j = ring_points[j]

        if _is_point_on_segment(point, ring_points[i], ring_points[j]):
            return True

        intersects = (lat_i > target_lat) != (lat_j > target_lat) and (
            target_lon
            < (lon_j - lon_i) * (target_lat - lat_i) / (lat_j - lat_i or 1e-12)
            + lon_i
        )
        if intersects:
            inside = not inside

    return inside


def _is_point_on_segment(
    point: Tuple[float, float],
    start: Tuple[float, float],
    end: Tuple[float, float],
    tolerance: float = 1e-9,
) -> bool:
    (px, py), (sx, sy), (ex, ey) = point, start, end

    cross = (py - sy) * (ex - sx) - (px - sx) * (ey - sy)
    if abs(cross) > tolerance:
        return False

    dot = (px - sx) * (px - ex) + (py - sy) * (py - ey)
    if dot > tolerance:
        return False

    return True
