"""robots.txt checks, fetched once per host per run."""
from __future__ import annotations

import logging
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

from leadfinder.http import Client, HttpError

log = logging.getLogger(__name__)

UA_TOKEN = "AV-Lead-Finder"


class RobotsCache:
    def __init__(self, client: Client):
        self.client = client
        self._parsers: dict[str, RobotFileParser | None] = {}

    def allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        host = f"{parts.scheme}://{parts.netloc}"
        if host not in self._parsers:
            self._parsers[host] = self._load(host)
        rp = self._parsers[host]
        if rp is None:  # no robots.txt (404) -> allowed
            return True
        return rp.can_fetch(UA_TOKEN, url)

    def _load(self, host: str) -> RobotFileParser | None:
        rp = RobotFileParser()
        try:
            resp = self.client.get(f"{host}/robots.txt")
        except HttpError as exc:
            if exc.status in (404, 410):
                return None
            # Unreachable robots.txt: be conservative and treat as disallow-all.
            log.warning("robots.txt unavailable; treating as disallowed", extra={"host": host, "error": str(exc)})
            rp.parse(["User-agent: *", "Disallow: /"])
            return rp
        ctype = resp.headers.get("content-type", "")
        if "html" in ctype.lower():  # SPA served HTML instead of robots.txt -> no rules published
            return None
        rp.parse(resp.text.splitlines())
        return rp
