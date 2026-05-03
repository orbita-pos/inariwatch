"""Fixture 06 — TypeVar generics + Iterable + Callable."""

from typing import Callable, Iterable, TypeVar

T = TypeVar("T")
R = TypeVar("R")


def first(items: Iterable[T]) -> T | None:
    for item in items:
        return item
    return None


def map_all(items: Iterable[T], fn: Callable[[T], R]) -> list[R]:
    return [fn(x) for x in items]


def double(n: int) -> int:
    return n * 2


total: list[int] = map_all([1, 2, 3], double)
