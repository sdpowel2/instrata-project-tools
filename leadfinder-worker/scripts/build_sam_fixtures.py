"""Build SAM.gov replay fixtures from the recorded live sample.

Real recorded items are kept verbatim; a few AV-relevant items are derived from them
(same shape, edited values) so the end-to-end test has leads near the offices.
Run: python scripts/build_sam_fixtures.py
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

FIX = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "sam_gov"
live = json.loads((FIX / "live_sample_2026-11-02.json").read_text(encoding="utf-8"))
real = live["opportunitiesData"]


def derive(base: dict, nid: str, **changes) -> dict:
    it = copy.deepcopy(base)
    it.update(changes)
    it["noticeId"] = nid
    it["description"] = f"https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid={nid}"
    it["uiLink"] = f"https://sam.gov/workspace/contract/opp/{nid}/view"
    it["links"] = [{"rel": "self", "href": f"https://api.sam.gov/prod/opportunities/v2/search?noticeid={nid}&limit=1"}]
    return it


av_navy = derive(
    real[1], "a0000000000000000000000000000001",
    title="Audio Visual System Upgrade, Building 1470 Conference Center",
    classificationCode="5836", naicsCodes=["334310"], naicsCode="334310",
    solicitationNumber="N4008527Q0101", responseDeadLine="2026-12-01T14:00:00-05:00",
    fullParentPathName="DEPT OF DEFENSE.DEPT OF THE NAVY.NAVFAC.NAVFAC MID-ATLANTIC",
    placeOfPerformance={"streetAddress": "", "city": {"code": "56000", "name": "Norfolk"},
                        "state": {"code": "VA", "name": "Virginia"}, "zip": "23511",
                        "country": {"code": "USA", "name": "UNITED STATES"}},
    officeAddress={"zipcode": "23511-3095", "city": "NORFOLK", "countryCode": "USA", "state": "VA"},
)
likely_va = derive(
    real[0], "a0000000000000000000000000000002",
    title="Design-Build New Construction Training Center, Fort Gregg-Adams",
    baseType="Presolicitation", type="Presolicitation", classificationCode="Y1AA",
    naicsCodes=["236220"], naicsCode="236220", solicitationNumber="W912DR27R0007",
    responseDeadLine="2026-12-15", fullParentPathName="DEPT OF DEFENSE.DEPT OF THE ARMY.USACE.NAD.BALTIMORE DISTRICT",
    placeOfPerformance={"city": {"name": "Petersburg"}, "state": {"code": "VA"}, "zip": "23801",
                        "country": {"code": "USA"}},
    officeAddress={"zipcode": "21201", "city": "BALTIMORE", "countryCode": "USA", "state": "MD"},
)
# Amendment of av_navy: same solicitation, new noticeId -> same group_key.
av_navy_amend = derive(av_navy, "a0000000000000000000000000000003",
                       title="Audio Visual System Upgrade, Building 1470 Conference Center - Amendment 1",
                       responseDeadLine="2026-12-05T14:00:00-05:00")
# Office-address-only location (no place of performance).
av_az = derive(
    real[2], "a0000000000000000000000000000004", title="Video Teleconferencing Suite Equipment",
    classificationCode="5830", naicsCodes=["334290"], solicitationNumber="FA487727Q0042",
    responseDeadLine="2026-11-30", fullParentPathName="DEPT OF DEFENSE.DEPT OF THE AIR FORCE.ACC.LUKE AFB",
    placeOfPerformance=None,
    officeAddress={"zipcode": "85309", "city": "LUKE AFB", "countryCode": "USA", "state": "AZ"},
)

page = lambda items, total, offset, limit: {"totalRecords": total, "limit": limit, "offset": offset,
                                           "opportunitiesData": items, "links": []}

# Pagination (limit=2): page 1 has 2 real items; page 2 has 1 real item + 1 malformed (no noticeId).
malformed = {"title": "Malformed item - no noticeId", "postedDate": "2026-11-02"}
files = {
    "page_1.json": page(real[:2], 4, 0, 2),
    "page_2.json": page([real[2], malformed], 4, 1, 2),
    "empty_page.json": page([], 0, 0, 1000),
    "e2e_page.json": page(real + [av_navy, likely_va, av_navy_amend, av_az], 7, 0, 1000),
    "noticedesc_av.json": {"description": "<p>Furnish and install <b>Crestron</b> control and a 2x2 video wall in the "
                                          "conference center.&nbsp;See attached SOW.</p>"},
}
for name, data in files.items():
    (FIX / name).write_text(json.dumps(data, indent=1), encoding="utf-8")
    print("wrote", name)
