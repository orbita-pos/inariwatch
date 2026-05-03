"""Fixture 09 — dynamic imports via importlib + __import__."""

import importlib


def load_plugin(name: str) -> object:
    """Load a plugin module by name. Resolves at runtime — pyright cannot
    statically determine the target."""
    return importlib.import_module(name)


def alias_plugin(name: str) -> object:
    return __import__(name)


def maybe_load(name: str) -> object | None:
    try:
        return importlib.import_module(name)
    except ImportError:
        return None
