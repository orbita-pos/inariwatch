"""Fixture 10 — package __init__ that re-exports + sets __all__."""

from .helpers import shout, whisper

__all__ = ["shout", "whisper", "exclaim"]


def exclaim(text: str) -> str:
    return f"{text}!!!"
