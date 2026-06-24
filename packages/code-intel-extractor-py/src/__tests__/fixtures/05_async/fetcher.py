"""Fixture 05 — async functions + await + AsyncIterator."""

import asyncio
from typing import AsyncIterator


async def fetch_one(url: str) -> bytes:
    """Fetch a single URL."""
    await asyncio.sleep(0)
    return url.encode()


async def fetch_many(urls: list[str]) -> list[bytes]:
    return await asyncio.gather(*(fetch_one(u) for u in urls))


async def stream(n: int) -> AsyncIterator[int]:
    for i in range(n):
        await asyncio.sleep(0)
        yield i
