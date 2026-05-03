"""Fixture 01 — simple typed function."""


def add(a: int, b: int) -> int:
    """Return the sum of a and b."""
    return a + b


def greet(name: str = "world") -> str:
    return f"hello {name}"


x: int = add(1, 2)
y: str = greet()
