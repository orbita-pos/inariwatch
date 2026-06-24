"""Fixture 14 — custom exceptions + raise + try/except.

The extractor should pick up:
- `ValidationError` and `NotFoundError` as classes
- `validate_user` raises `ValidationError`
- docstring `:raises:` and `Raises:` markers
"""


class ValidationError(ValueError):
    """Raised when a record fails validation."""


class NotFoundError(LookupError):
    pass


def validate_user(name: str) -> None:
    """Validate a user name.

    :raises ValidationError: if the name is empty.
    """
    if not name:
        raise ValidationError("name is required")


def find_user(id: str) -> dict[str, str]:
    """Look up a user by id.

    Raises:
        NotFoundError: if the user does not exist.
    """
    if not id:
        raise NotFoundError(f"user {id!r} not found")
    return {"id": id, "name": "demo"}
