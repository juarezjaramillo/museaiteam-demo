"""Tests for 40-word announcement guard."""

import time

import guard


def make_words(n):
    return " ".join(["word"] * n)


def test_39_words_pass():
    assert guard.is_valid_announcement(make_words(39)) is True


def test_40_words_pass():
    assert guard.is_valid_announcement(make_words(40)) is True


def test_41_words_fail():
    assert guard.is_valid_announcement(make_words(41)) is False


def test_empty_fails():
    assert guard.is_valid_announcement("") is False


def test_whitespace_only_fails():
    assert guard.is_valid_announcement("   \n\t  ") is False


def test_none_fails():
    assert guard.is_valid_announcement(None) is False


def test_compliant_9_word_announcement():
    assert len(guard.COMPLIANT_ANNOUNCEMENT.split()) == 9
    assert guard.is_valid_announcement(guard.COMPLIANT_ANNOUNCEMENT) is True
    assert guard.enforce_announcement(guard.COMPLIANT_ANNOUNCEMENT) == guard.COMPLIANT_ANNOUNCEMENT


def test_enforce_blocks_41_words():
    try:
        guard.enforce_announcement(make_words(41))
        assert False, "should have raised"
    except ValueError as exc:
        assert "41 words" in str(exc)


def test_fast_under_5ms_zero_deps():
    text = make_words(40)
    start = time.perf_counter()
    for _ in range(10):
        guard.is_valid_announcement(text)
    elapsed_ms = (time.perf_counter() - start) * 1000 / 10
    assert elapsed_ms < 5
