"""Fixture 12 — TypedDict + Required / NotRequired."""

from typing import NotRequired, Required, TypedDict


class AlertEvent(TypedDict):
    id: Required[str]
    severity: Required[str]
    message: str
    fingerprint: NotRequired[str]


def coerce_event(raw: dict[str, object]) -> AlertEvent:
    return {
        "id": str(raw["id"]),
        "severity": str(raw.get("severity", "info")),
        "message": str(raw.get("message", "")),
    }
