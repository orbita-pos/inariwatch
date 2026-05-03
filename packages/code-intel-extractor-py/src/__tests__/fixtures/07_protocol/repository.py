"""Fixture 07 — Protocol + structural subtyping."""

from typing import Protocol


class Repository(Protocol):
    """Anything with these two methods is a Repository."""

    def get(self, id: str) -> dict[str, object]: ...
    def save(self, record: dict[str, object]) -> None: ...


class InMemoryRepo:
    def __init__(self) -> None:
        self._data: dict[str, dict[str, object]] = {}

    def get(self, id: str) -> dict[str, object]:
        return self._data[id]

    def save(self, record: dict[str, object]) -> None:
        rid = str(record["id"])
        self._data[rid] = record


def use_repo(repo: Repository, rid: str) -> dict[str, object]:
    return repo.get(rid)


repo: Repository = InMemoryRepo()
