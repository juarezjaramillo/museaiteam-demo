"""40-word announcement guard for session-run path.

Tactic [1]: stdlib-only length check, zero dependencies.
PM wires `enforce_announcement` as a block before publish.
"""

MAX_WORDS = 40

COMPLIANT_ANNOUNCEMENT = "Team ships guard today keeping announcements short and clear"


def word_count(text):
    """Return word count using str.split, 0 for non-string."""
    if not isinstance(text, str):
        return 0
    return len(text.split())


def is_valid_announcement(text):
    """Return True iff text is a non-empty string with <= 40 words."""
    if not isinstance(text, str):
        return False
    words = text.split()
    if not words:
        return False
    return len(words) <= MAX_WORDS


def enforce_announcement(text):
    """Return text if valid, else raise ValueError (PM block hook)."""
    if not is_valid_announcement(text):
        raise ValueError(
            f"announcement blocked: {word_count(text)} words, max {MAX_WORDS}"
        )
    return text
