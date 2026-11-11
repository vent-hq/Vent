"""Turning LiveKit SDK objects into plain JSON values."""

from __future__ import annotations

from typing import Any, Dict


def to_jsonable(value: Any, depth: int = 0, ancestors: tuple = ()) -> Any:
    """Make SDK objects JSON-safe. Containers nested deeper than 8 levels, and
    references back to an enclosing object (cycles), become None."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, BaseException):
        return {"type": type(value).__name__, "message": str(value)}
    if depth > 8 or any(value is a for a in ancestors):
        return None
    inner = ancestors + (value,)
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(v, depth + 1, inner) for v in value]
    if isinstance(value, dict):
        return {str(k): to_jsonable(v, depth + 1, inner) for k, v in value.items()}
    if hasattr(value, "model_dump"):
        return to_jsonable(value.model_dump(), depth + 1, inner)
    if hasattr(value, "to_dict"):
        return to_jsonable(value.to_dict(), depth + 1, inner)
    if hasattr(value, "__dict__"):
        return to_jsonable(fields(value), depth + 1, inner)
    return str(value)


def fields(obj: Any) -> Dict[str, Any]:
    """The public fields of an SDK object or dict, one level deep."""
    if isinstance(obj, dict):
        return dict(obj)
    if hasattr(obj, "__dict__"):
        return {k: v for k, v in vars(obj).items() if not k.startswith("_")}
    return {}


def field(obj: Any, name: str) -> Any:
    """One field of an SDK object or dict; None when it's missing."""
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def compact(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}
