from leadfinder.db.models import GeocodeCache
from leadfinder.pipeline.geocode import Address, Geocoder, normalize_place_name
from leadfinder.pipeline.normalize import normalized_address


def test_place_name_suffixes():
    assert normalize_place_name("Raleigh city") == "raleigh"
    assert normalize_place_name("Cary town") == "cary"
    assert normalize_place_name("Dale City CDP") == "dale city"
    assert normalize_place_name("St. Michaels town") == "st michaels"


def test_precedence_census_cache_wins(seeded):
    s = seeded
    s.add(GeocodeCache(normalized_address=normalized_address("100 Main St", "Durham", "NC", "27701"),
                       lat=36.0, lon=-78.9, method="census_address", matched_address="100 MAIN ST"))
    s.flush()
    r, basis, _ = Geocoder(s, online=False).locate(Address("100 Main St", "Durham", "NC", "27701"), "place_of_performance")
    assert (r.method, basis) == ("census_address", "place_of_performance")


def test_precedence_zip_then_city(seeded):
    g = Geocoder(seeded, online=False)
    r, basis, _ = g.locate(Address(None, "Raleigh", "NC", "27610-0001"), "place_of_performance")
    assert r.method == "zip_centroid" and basis == "place_of_performance"
    r, _, _ = g.locate(Address(None, "Durham", "North Carolina", None), "place_of_performance")
    assert r.method == "city_centroid"


def test_precedence_fallback_then_none(seeded):
    g = Geocoder(seeded, online=False)
    r, basis, _ = g.locate(Address(None, "Nowhere", "NC", None), "place_of_performance",
                           Address(None, "Norfolk", "VA", None), "contracting_office")
    assert r.method == "city_centroid" and basis == "contracting_office"
    r, basis, used = g.locate(Address(None, "Nowhere", "NC", None), "place_of_performance")
    assert r.method == "none" and basis == "none" and used.state == "NC"


def test_cached_miss_is_not_requeried(seeded):
    s = seeded
    s.add(GeocodeCache(normalized_address=normalized_address("1 Nope Rd", "Raleigh", "NC", "27610"),
                       lat=None, lon=None, method="none"))
    s.flush()
    assert not Geocoder(s, online=False).census(Address("1 Nope Rd", "Raleigh", "NC", "27610")).ok
