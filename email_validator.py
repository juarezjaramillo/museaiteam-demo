"""Permissive email validation helper (stdlib only)."""
import re

__all__ = ["is_valid_email"]

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_valid_email(value: object) -> bool:
    """Return True if value looks like an email address."""
    if not isinstance(value, str):
        return False
    if not value:
        return False
    return bool(_EMAIL_RE.match(value))
