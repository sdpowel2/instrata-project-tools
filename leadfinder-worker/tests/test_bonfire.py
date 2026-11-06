import json
from datetime import date
from pathlib import Path

import httpx
import pytest
import respx

from leadfinder.adapters.base import DateWindow
from leadfinder.adapters.bonfire import OPEN_PATH, BonfireAdapter, Target
from leadfinder.http import CallBudget, Client

FIX = Path(__file__).parent / "fixtures" / "bonfire"
WINDOW = DateWindow(date(2026, 11, 1), date(2026, 11, 3))
DATA = json.loads((FIX / "open_projects_synthetic.json").read_text(encoding="utf-8"))


def targets():
    return [
        Target("t1", "cityone", "City One", "1 Main St", "Raleigh", "NC", "27610", 35.77, -78.58),
        Target("t2", "citytwo", "City Two", None, "Durham", "NC", None),
    ]


def robots(text, status=200):
    return httpx.Response(status, text=text, headers={"content-type": "text/plain"})


@respx.mock
def test_robots_disallow_logs_per_agency_error_and_fetches_nothing():
    for slug in ("cityone", "citytwo"):
        respx.get(f"https://{slug}.bonfirehub.com/robots.txt").mock(return_value=robots("User-agent: *\nDisallow: /"))
    api = respx.get(url__regex=r".*" + OPEN_PATH).mock(return_value=httpx.Response(200, json=DATA))
    a = BonfireAdapter(Client(), targets())
    assert list(a.fetch(WINDOW, CallBudget(None), None)) == []
    assert api.call_count == 0
    assert [e.slug for e in a.errors] == ["cityone", "citytwo"]
    assert "robots.txt disallows" in a.errors[0].error


@respx.mock
def test_allowed_parses_and_one_agency_failure_does_not_stop_others():
    respx.get("https://cityone.bonfirehub.com/robots.txt").mock(return_value=robots("", 404))
    respx.get("https://citytwo.bonfirehub.com/robots.txt").mock(return_value=robots("User-agent: *\nAllow: /"))
    respx.get("https://cityone.bonfirehub.com" + OPEN_PATH).mock(return_value=httpx.Response(200, json=DATA))
    respx.get("https://citytwo.bonfirehub.com" + OPEN_PATH).mock(return_value=httpx.Response(500))
    a = BonfireAdapter(Client(), targets())
    items = list(a.fetch(WINDOW, CallBudget(None), None))
    assert sorted(i.source_record_id for i in items) == ["cityone:101", "cityone:102", "cityone:103"]
    assert [e.slug for e in a.errors] == ["citytwo"]
    d = a.normalize(next(i for i in items if i.source_record_id == "cityone:101"))
    assert d.title == "Council Chamber Audio Visual System Replacement"
    assert d.solicitation_number == "RFP 2026-044"
    assert d.agency_name == "City One" and d.sub_agency == "General Services"
    assert d.fallback_basis == "agency_address" and d.fallback_latlon == (35.77, -78.58)
    assert d.url == "https://cityone.bonfirehub.com/opportunities/101"
    assert d.response_due_at_raw == "2026-12-10 14:00:00"


@respx.mock
def test_throttle_between_requests_same_host(monkeypatch):
    import leadfinder.http as h
    slept = []
    monkeypatch.setattr(h, "sleep", slept.append)
    respx.get("https://cityone.bonfirehub.com/robots.txt").mock(return_value=robots("", 404))
    respx.get("https://cityone.bonfirehub.com" + OPEN_PATH).mock(return_value=httpx.Response(200, json=DATA))
    a = BonfireAdapter(Client(min_interval_per_host=2.0), targets()[:1])
    list(a.fetch(WINDOW, CallBudget(None), None))
    assert slept and 0 < slept[0] <= 2.0


@pytest.mark.live
def test_live_robots_still_disallows():
    """Re-check compliance status of one Bonfire host (robots.txt only)."""
    from leadfinder.robots import RobotsCache
    assert RobotsCache(Client()).allowed("https://charlottenc.bonfirehub.com" + OPEN_PATH) is False
