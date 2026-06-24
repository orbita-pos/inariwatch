"""Fixture 15 — mixed typed and untyped functions in the same module."""


def parse(raw):
    """Untyped — returns whatever the input is."""
    return raw


def parse_int(raw: str) -> int:
    return int(raw)


def render(template, ctx):  # both args untyped
    return template.format(**ctx)


def render_typed(template: str, ctx: dict[str, object]) -> str:
    return template.format(**ctx)


total = parse_int("42") + 1
