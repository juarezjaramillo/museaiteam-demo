from email_validator import is_valid_email


def test_valid_simple():
    assert is_valid_email("user@example.com")


def test_plus_addressing():
    assert is_valid_email("user+tag@example.com")


def test_subdomain():
    assert is_valid_email("user@mail.sub.example.co.uk")


def test_empty_string():
    assert is_valid_email("") is False


def test_none():
    assert is_valid_email(None) is False


def test_missing_at():
    assert is_valid_email("userexample.com") is False


def test_missing_dot():
    assert is_valid_email("user@example") is False


def test_spaces_rejected():
    assert is_valid_email("user @example.com") is False
    assert is_valid_email("user@example .com") is False


def test_non_string_rejected():
    assert is_valid_email(123) is False
    assert is_valid_email(["user@example.com"]) is False
