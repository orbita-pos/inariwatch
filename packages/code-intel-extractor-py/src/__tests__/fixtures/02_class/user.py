"""Fixture 02 — class with methods + private helper."""


class User:
    """A user record."""

    def __init__(self, name: str, age: int) -> None:
        self.name = name
        self.age = age
        self._token: str | None = None

    def is_adult(self) -> bool:
        return self.age >= 18

    def _generate_token(self) -> str:
        return f"tok-{self.name}"

    def login(self) -> str:
        self._token = self._generate_token()
        return self._token


u = User("alice", 30)
adult = u.is_adult()
tok = u.login()
