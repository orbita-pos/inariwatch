"""Fixture 11 — module-level constants with Final."""

from typing import Final

MAX_RETRIES: Final[int] = 5
DEFAULT_TIMEOUT_SECONDS: Final[float] = 30.0
SERVICE_NAME: Final[str] = "inariwatch-py-extractor"

# Plain UPPER_CASE without Final — convention says constant.
PI = 3.14159


def retry_count() -> int:
    return MAX_RETRIES
