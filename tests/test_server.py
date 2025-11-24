import pytest

from backend.server import parse_card_input


def test_parse_card_input_valid():
    card = parse_card_input("4242424242424242|12|2028|123")

    assert card == {
        "cc": "4242424242424242",
        "month": "12",
        "year": "2028",
        "cvv": "123",
    }


def test_parse_card_input_invalid_length():
    assert parse_card_input("4242|12|2028|123") is None


def test_parse_card_input_non_numeric():
    assert parse_card_input("4242abcd42424242|12|2028|123") is None


def test_parse_card_input_bad_luhn():
    assert parse_card_input("4242424242424241|12|2028|123") is None
