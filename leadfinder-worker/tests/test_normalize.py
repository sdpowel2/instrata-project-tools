from datetime import datetime, timezone

import pytest

from leadfinder.pipeline.normalize import clean, normalized_agency, notice_type, parse_datetime, state_code, zip5


def test_clean_collapses_whitespace():
    assert clean("  Video   wall \n upgrade ") == "Video wall upgrade"
    assert clean("   ") is None


@pytest.mark.parametrize("raw,code", [
    ("Virginia", "VA"), ("north carolina", "NC"), ("NJ", "NJ"), ("md", "MD"), ("US-SC", "SC"), ("Narnia", None),
])
def test_state_code(raw, code):
    assert state_code(raw) == code


@pytest.mark.parametrize("raw,z", [("27610-1234", "27610"), ("08619", "08619"), (8619, "08619"), ("", None), (None, None)])
def test_zip5(raw, z):
    assert zip5(raw) == z


def test_parse_datetime_with_offset_converts_to_utc():
    assert parse_datetime("2026-11-20T14:00:00-05:00") == datetime(2026, 11, 20, 19, 0, tzinfo=timezone.utc)


def test_parse_naive_uses_state_zone():
    # Arizona does not observe DST: always UTC-7.
    assert parse_datetime("2026-07-01 10:00", "AZ") == datetime(2026, 7, 1, 17, 0, tzinfo=timezone.utc)
    # Virginia in November is EST (UTC-5).
    assert parse_datetime("2026-11-20 14:00", "VA") == datetime(2026, 11, 20, 19, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize("raw,mapped", [
    ("Solicitation", "solicitation"), ("Presolicitation", "presolicitation"),
    ("Sources Sought", "sources_sought"), ("Combined Synopsis/Solicitation", "combined"),
    ("Special Notice", "special"), ("Award Notice", "award"), ("Request for Proposal", "rfp"),
    ("RFQ", "rfq"), ("Invitation for Bid", "ifb"), ("Something else", "other"), (None, "other"),
])
def test_notice_type(raw, mapped):
    assert notice_type(raw) == mapped


def test_normalized_agency_drops_noise():
    assert normalized_agency("City of Raleigh Purchasing") == normalized_agency("Raleigh")
