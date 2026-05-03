"""Fixture 13 — abstract base class with @abstractmethod."""

from abc import ABC, abstractmethod


class Storage(ABC):
    """Abstract storage backend."""

    @abstractmethod
    def read(self, key: str) -> bytes:
        """Read bytes for `key`. Implementations may raise KeyError."""
        ...

    @abstractmethod
    def write(self, key: str, value: bytes) -> None:
        ...

    def exists(self, key: str) -> bool:
        try:
            self.read(key)
        except KeyError:
            return False
        return True


class InMemoryStorage(Storage):
    def __init__(self) -> None:
        self._data: dict[str, bytes] = {}

    def read(self, key: str) -> bytes:
        return self._data[key]

    def write(self, key: str, value: bytes) -> None:
        self._data[key] = value
