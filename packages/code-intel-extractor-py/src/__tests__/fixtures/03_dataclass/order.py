"""Fixture 03 — dataclass with field defaults + factory."""

from dataclasses import dataclass, field


@dataclass
class Order:
    id: str
    quantity: int
    items: list[str] = field(default_factory=list)
    note: str = ""


def make_order(id: str, quantity: int) -> Order:
    return Order(id=id, quantity=quantity)


o = make_order("o-1", 3)
