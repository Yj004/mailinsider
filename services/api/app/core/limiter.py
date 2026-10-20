import time
from collections import defaultdict
from threading import Lock


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, list[float]] = defaultdict(list)
        self._lock = Lock()

    def allow(self, key: str, limit: int, window_seconds: int) -> bool:
        now = time.time()
        with self._lock:
            recent = [stamp for stamp in self._hits[key] if now - stamp < window_seconds]
            if len(recent) >= limit:
                self._hits[key] = recent
                return False
            recent.append(now)
            self._hits[key] = recent
            return True


limiter = RateLimiter()
