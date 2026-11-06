"""Structured JSON logs with API-key redaction."""
from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone

from leadfinder.settings import redact

_STD = set(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for k, v in record.__dict__.items():
            if k not in _STD and not k.startswith("_"):
                out[k] = v
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return redact(json.dumps(out, default=str))


def setup_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    if any(isinstance(h.formatter, JsonFormatter) for h in root.handlers):
        return
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(JsonFormatter())
    root.handlers[:] = [h]
    root.setLevel(level)
    for noisy in ("httpx", "httpcore", "alembic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
