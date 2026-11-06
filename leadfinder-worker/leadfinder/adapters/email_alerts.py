"""Vendor-alert email adapter (optional source).

Input: a folder of .eml files (testing / manual drop) or an IMAP mailbox (host, user,
app password from env). One parser per sender domain, with a generic fallback that
extracts title, agency, due date and the first portal link. Low-confidence parses get
status `unknown`. Email bodies are never logged.
"""
from __future__ import annotations

import email
import email.policy
import hashlib
import imaplib
import logging
import re
from datetime import timedelta
from email.message import EmailMessage
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Iterator

from leadfinder.adapters.base import AddressDraft, DateWindow, OpportunityDraft, RawItem
from leadfinder.adapters.sam_gov import strip_html
from leadfinder.http import CallBudget
from leadfinder.pipeline.normalize import STATE_CODES, VALID_CODES
from leadfinder.settings import ROOT, get_settings

log = logging.getLogger(__name__)

_SUBJECT_PREFIX = re.compile(
    r"^\s*((re|fw|fwd)\s*:\s*|\[?(new|bid|rfp|rfq|ifb|itb|solicitation|opportunity|notification|alert)[^:\-]{0,40}[:\-]\s*)+",
    re.IGNORECASE)
_URL = re.compile(r"https?://[^\s<>\"')\]]+")
_SKIP_URL = re.compile(r"unsubscribe|optout|opt-out|preferences|privacy|mailto:|\.(png|jpg|gif)(\?|$)", re.IGNORECASE)


def _field(text: str, *labels: str) -> str | None:
    for lab in labels:
        m = re.search(rf"(?im)^\s*{lab}\s*[:#]\s*(.+?)\s*$", text)
        if m:
            return m.group(1).strip()
    return None


def _city_state(text: str | None) -> tuple[str | None, str | None]:
    if not text:
        return None, None
    # Capitalised city words on one line, then a state code or full state name.
    pat = r"\b([A-Z][A-Za-z.'\-]+(?:[ ][A-Z][A-Za-z.'\-]+){0,3}),[ ]*([A-Z]{2}\b|[A-Z][a-z]+(?:[ ][A-Z][a-z]+)?)"
    for m in re.finditer(pat, text):
        city, st = m.group(1).strip(), m.group(2).strip()
        code = st if st in VALID_CODES else STATE_CODES.get(st.lower())
        if code:
            return city, code
    return None, None


def body_text(msg: EmailMessage) -> str:
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    content = part.get_content()
    return strip_html(content) if part.get_content_type() == "text/html" else content


def generic_parser(msg: EmailMessage, text: str) -> dict[str, Any]:
    subject = str(msg.get("Subject", "") or "")
    title = _field(text, "Title", "Bid Title", "Project Title", "Solicitation Title", "Opportunity") \
        or _SUBJECT_PREFIX.sub("", subject).strip() or subject
    display_name = parseaddr(str(msg.get("From", "")))[0]
    agency = _field(text, "Agency", "Issuing Agency", "Organization", "Organisation", "Buyer Organization",
                    "Purchasing Agency", "Entity") or display_name or None
    due = _field(text, "Due Date", "Closing Date", "Close Date", "Bid Due", "Bids Due", "Response Due",
                 "Proposal Due", "Due")
    sol = _field(text, "Solicitation Number", "Solicitation #", "Bid Number", "Bid #", "Reference Number",
                 "Reference", "RFP Number", "RFQ Number", "IFB Number")
    loc = _field(text, "Location", "Agency Location", "City/State")
    city, state = _city_state(loc) if loc else _city_state(agency)
    if not state and not loc:
        city, state = _city_state(text)  # last resort: first "City, ST" in the body
    if not state:
        state = (_field(text, "State") or "").upper() or None
        state = state if state in VALID_CODES else STATE_CODES.get((state or "").lower())
    link = next((u.rstrip(".,;") for u in _URL.findall(text) if not _SKIP_URL.search(u)), None)
    confident = bool(title and due and link)
    return {"title": title, "agency": agency, "due": due, "solicitation": sol, "city": city, "state": state,
            "url": link, "type": _field(text, "Type", "Bid Type", "Solicitation Type"), "confident": confident}


# Sender-domain parsers. Add one when a real alert format arrives; fall back to generic.
PARSERS: dict[str, Callable[[EmailMessage, str], dict[str, Any]]] = {}


def parser_for(sender_domain: str) -> Callable[[EmailMessage, str], dict[str, Any]]:
    d = sender_domain.lower()
    for dom, fn in PARSERS.items():
        if d == dom or d.endswith("." + dom):
            return fn
    return generic_parser


class EmailAlertsAdapter:
    source_id = "email_alerts"

    def __init__(self, eml_folder: Path | None = None, imap: tuple[str, str, str] | None = None,
                 mailbox: str = "INBOX"):
        self.eml_folder = eml_folder
        self.imap = imap
        self.mailbox = mailbox

    @classmethod
    def from_config(cls, cfg: dict) -> "EmailAlertsAdapter":
        st = get_settings()
        if st.imap_host and st.imap_user and st.imap_password:
            return cls(imap=(st.imap_host, st.imap_user, st.imap_password), mailbox=cfg.get("mailbox", "INBOX"))
        folder = cfg.get("eml_folder", "data/email_inbox")
        return cls(eml_folder=(ROOT / folder) if not Path(folder).is_absolute() else Path(folder))

    # ------------------------------------------------------------------ fetch
    def _messages(self, window: DateWindow) -> Iterator[bytes]:
        if self.imap:
            host, user, pw = self.imap
            with imaplib.IMAP4_SSL(host) as conn:
                conn.login(user, pw)
                conn.select(self.mailbox, readonly=True)
                since = window.posted_from.strftime("%d-%b-%Y")
                before = (window.posted_to + timedelta(days=1)).strftime("%d-%b-%Y")
                typ, data = conn.search(None, "SINCE", since, "BEFORE", before)
                for num in (data[0] or b"").split():
                    typ, parts = conn.fetch(num, "(RFC822)")
                    for p in parts:
                        if isinstance(p, tuple):
                            yield p[1]
        elif self.eml_folder and self.eml_folder.exists():
            for path in sorted(self.eml_folder.glob("*.eml")):
                yield path.read_bytes()

    def fetch(self, window: DateWindow, budget: CallBudget, cursor: dict | None) -> Iterator[RawItem]:
        for raw_bytes in self._messages(window):
            msg = email.message_from_bytes(raw_bytes, policy=email.policy.default)
            try:
                sent = parsedate_to_datetime(str(msg.get("Date")))
            except (TypeError, ValueError):
                sent = None
            if self.eml_folder and sent is not None and not (window.posted_from <= sent.date() <= window.posted_to):
                continue
            mid = str(msg.get("Message-ID") or "").strip() or "sha256:" + hashlib.sha256(raw_bytes).hexdigest()
            text = body_text(msg)
            sender = parseaddr(str(msg.get("From", "")))[1]
            payload = {"message_id": mid, "from": sender, "subject": str(msg.get("Subject", "")),
                       "date": sent.isoformat() if sent else None, "body": text[:20000]}
            yield RawItem(source_record_id=mid, payload=payload)

    # -------------------------------------------------------------- normalize
    def normalize(self, raw: RawItem) -> OpportunityDraft:
        p = raw.payload if isinstance(raw.payload, dict) else {}
        msg = EmailMessage()
        msg["Subject"] = p.get("subject", "")
        msg["From"] = p.get("from", "")
        domain = (p.get("from") or "").rsplit("@", 1)[-1]
        parsed = parser_for(domain)(msg, p.get("body") or "")
        return OpportunityDraft(
            source_id=self.source_id,
            source_record_id=raw.source_record_id,
            solicitation_number=parsed.get("solicitation"),
            title=parsed.get("title") or p.get("subject") or "(untitled)",
            description=(p.get("body") or "")[:4000] or None,
            agency_name=parsed.get("agency"),
            notice_type_raw=parsed.get("type"),
            posted_at_raw=p.get("date"),
            response_due_at_raw=parsed.get("due"),
            active=True if parsed.get("confident") else None,
            status_hint=None if parsed.get("confident") else "unknown",
            url=parsed.get("url"),
            location=AddressDraft(city=parsed.get("city"), state=parsed.get("state")),
            location_basis="agency_address",
            state_hint=parsed.get("state"),
        )
