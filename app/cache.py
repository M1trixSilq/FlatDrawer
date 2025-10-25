import time
from threading import RLock
from typing import Any, Optional, Tuple


class TTLCache:
    def __init__(self, ttl: int = 60):
        self.ttl = ttl
        self._store: dict[str, Tuple[float, Any]] = {}
        self._lock = RLock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            item = self._store.get(key)
            if not item:
                return None
            expires_at, value = item
            if expires_at < time.time():
                self._store.pop(key, None)
                return None
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._store[key] = (time.time() + self.ttl, value)

    def delete(self, key: str) -> None:
        with self._lock:
            self._store.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()


def create_default_cache() -> TTLCache:
    return TTLCache(ttl=30)


houses_cache: TTLCache = create_default_cache()