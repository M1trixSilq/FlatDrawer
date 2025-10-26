import logging
import time
from threading import RLock
from typing import Any, Optional, Tuple


class TTLCache:
    def __init__(self, ttl: int = 60):
        self.ttl = ttl
        self._store: dict[str, Tuple[float, Any]] = {}
        self._lock = RLock()
        self._logger = logging.getLogger(self.__class__.__name__)

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            item = self._store.get(key)
            if not item:
                self._logger.debug("Cache miss for key '%s'", key)
                return None
            expires_at, value = item
            if expires_at < time.time():
                self._store.pop(key, None)
                self._logger.debug("Cache expired for key '%s'", key)
                return None
            self._logger.debug("Cache hit for key '%s'", key)
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._store[key] = (time.time() + self.ttl, value)
            self._logger.debug("Cache set for key '%s' with ttl %s", key, self.ttl)

    def delete(self, key: str) -> None:
        with self._lock:
            self._store.pop(key, None)
            self._logger.debug("Cache delete for key '%s'", key)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()
            self._logger.debug("Cache cleared")


def create_default_cache() -> TTLCache:
    return TTLCache(ttl=30)


houses_cache: TTLCache = create_default_cache()
