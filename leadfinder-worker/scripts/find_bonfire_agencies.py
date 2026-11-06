"""Test candidate Bonfire agency slugs: a slug is valid if its portal URL answers
(200, or a redirect to its login page).

Compliance: robots.txt is checked first for each host. If it disallows the portal
path, the slug is reported as `robots-disallowed` and NOT requested further.

Usage: python scripts/find_bonfire_agencies.py slug1 slug2 ...
"""
from __future__ import annotations

import sys

from leadfinder.http import Client, HttpError
from leadfinder.robots import RobotsCache


def main(slugs: list[str]) -> int:
    with Client(min_interval_per_host=2.0) as client:
        robots = RobotsCache(client)
        for slug in slugs:
            base = f"https://{slug}.bonfirehub.com"
            try:
                if not robots.allowed(base + "/portal/"):
                    print(f"{slug:<25} robots-disallowed (not probed)")
                    continue
                r = client.get(base + "/portal/")
                print(f"{slug:<25} valid ({r.status_code})")
            except HttpError as exc:
                print(f"{slug:<25} invalid ({exc.status or 'unreachable'})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
