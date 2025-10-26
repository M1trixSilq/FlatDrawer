"""Utilities for interacting with Yandex Maps services."""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

YANDEX_GEOCODER_URL = "https://geocode-maps.yandex.ru/1.x"
YANDEX_MAPS_API_KEY = os.getenv("YANDEX_MAPS_API_KEY", "")


def _extract_address(payload: Dict[str, Any]) -> Optional[str]:
    collection = (
        payload.get("response", {})
        .get("GeoObjectCollection", {})
        .get("featureMember", [])
    )
    if not collection:
        return None

    geo_object = collection[0].get("GeoObject")
    if not isinstance(geo_object, dict):
        return None

    metadata = (
        geo_object.get("metaDataProperty", {})
        .get("GeocoderMetaData", {})
    )
    if not isinstance(metadata, dict):
        return None

    return (
        metadata.get("text")
        or metadata.get("Address", {}).get("formatted")
        or None
    )


async def reverse_geocode(lat: float, lon: float) -> Optional[str]:
    """Resolve a human-readable address from Yandex Maps for the coordinates."""

    params = {
        "format": "json",
        "kind": "house",
        "results": 1,
        "lang": "ru_RU",
        "sco": "latlong",
        "geocode": f"{lon},{lat}",
    }
    if YANDEX_MAPS_API_KEY:
        params["apikey"] = YANDEX_MAPS_API_KEY
    headers = {
        "User-Agent": "FlatDrawer/1.0 (contact@flatdrawer.local)",
        "Accept-Language": "ru,en;q=0.5",
    }

    try:
        async with httpx.AsyncClient(timeout=10, headers=headers) as client:
            response = await client.get(YANDEX_GEOCODER_URL, params=params)
        response.raise_for_status()
    except httpx.HTTPError as exc:  # pragma: no cover - network failure
        logger.warning(
            "Yandex Maps reverse geocoding failed for lat=%s lon=%s: %s",
            lat,
            lon,
            exc,
        )
        return None

    try:
        data = response.json()
    except ValueError:  # pragma: no cover - malformed JSON
        logger.warning(
            "Yandex Maps returned invalid JSON for lat=%s lon=%s",
            lat,
            lon,
        )
        return None

    if not isinstance(data, dict):
        return None

    return _extract_address(data)

