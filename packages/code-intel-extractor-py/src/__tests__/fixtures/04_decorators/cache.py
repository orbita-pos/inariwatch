"""Fixture 04 — @property, @staticmethod, @classmethod, @lru_cache."""

from functools import lru_cache


class Counter:
    _value: int

    def __init__(self) -> None:
        self._value = 0

    @property
    def value(self) -> int:
        return self._value

    @value.setter
    def value(self, v: int) -> None:
        self._value = v

    @staticmethod
    def zero() -> int:
        return 0

    @classmethod
    def starting_at(cls, v: int) -> "Counter":
        c = cls()
        c.value = v
        return c


@lru_cache(maxsize=128)
def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
