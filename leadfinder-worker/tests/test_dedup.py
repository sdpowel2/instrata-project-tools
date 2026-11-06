from datetime import datetime, timedelta, timezone

from leadfinder.db.models import Opportunity
from leadfinder.pipeline.dedup import content_hash, group_key, is_cross_source_duplicate, link_cross_source

DUE = datetime(2026, 12, 1, 19, 0, tzinfo=timezone.utc)


def test_group_key_uses_solicitation_number():
    a = group_key("sam_gov", "DEPT OF THE NAVY", "N00189-26-Q-0001", "AV upgrade", DUE)
    b = group_key("sam_gov", "Dept of the Navy", "n00189-26-q-0001", "AV upgrade (amended)", DUE + timedelta(days=5))
    assert a == b


def test_group_key_without_solicitation_uses_title_and_due():
    a = group_key("bonfire", "Wake County", None, "Courthouse AV Upgrade", DUE)
    b = group_key("bonfire", "Wake County", None, "Courthouse  AV upgrade", DUE)
    c = group_key("bonfire", "Wake County", None, "Courthouse AV Upgrade", DUE + timedelta(days=2))
    assert a == b != c


def test_content_hash_changes_with_due_date():
    loc = ("", "Raleigh", "NC", "27610")
    assert content_hash("t", DUE, "open", "rfp", loc) != content_hash("t", DUE + timedelta(hours=1), "open", "rfp", loc)
    assert content_hash("t", DUE, "open", "rfp", loc) == content_hash("t", DUE, "open", "rfp", loc)


def _opp(source, title, agency="Wake County", state="NC", due=DUE, rid=None):
    return Opportunity(source_id=source, source_record_id=rid or f"{source}-{title}", group_key="g", title=title,
                       agency_name=agency, loc_state=state, response_due_at=due, content_hash="h",
                       first_seen_at=datetime(2026, 11, 1, tzinfo=timezone.utc))


def test_cross_source_rules():
    a = _opp("bonfire", "Courthouse Audio Visual Upgrade")
    assert is_cross_source_duplicate(a, _opp("email_alerts", "Audio Visual Upgrade - Courthouse", due=DUE + timedelta(hours=20)))
    assert not is_cross_source_duplicate(a, _opp("email_alerts", "Courthouse Audio Visual Upgrade", state="VA"))
    assert not is_cross_source_duplicate(a, _opp("email_alerts", "Courthouse Audio Visual Upgrade", agency="Durham County Schools"))
    assert not is_cross_source_duplicate(a, _opp("email_alerts", "Courthouse Audio Visual Upgrade", due=DUE + timedelta(days=2)))
    assert not is_cross_source_duplicate(a, _opp("email_alerts", "Library Roof Replacement"))
    assert not is_cross_source_duplicate(a, _opp("bonfire", "Courthouse Audio Visual Upgrade", rid="other"))


def test_link_prefers_more_structured_source(seeded):
    s = seeded
    email = _opp("email_alerts", "Courthouse Audio Visual Upgrade")
    s.add(email)
    s.flush()
    portal = _opp("bonfire", "Courthouse Audio-Visual Upgrade")
    s.add(portal)
    s.flush()
    link_cross_source(s, portal)
    assert email.duplicate_of == portal.id and portal.duplicate_of is None
