"""Fixture 08 — Optional + Union (PEP 604) + None defaults."""

from typing import Optional, Union


def lookup_user(id: str, default: Optional[dict[str, str]] = None) -> Optional[dict[str, str]]:
    if not id:
        return default
    return {"id": id, "name": "demo"}


def parse_count(raw: Union[str, int, None]) -> int:
    if raw is None:
        return 0
    if isinstance(raw, int):
        return raw
    return int(raw)


def maybe_name(user: dict[str, str] | None) -> str | None:
    if user is None:
        return None
    return user.get("name")
