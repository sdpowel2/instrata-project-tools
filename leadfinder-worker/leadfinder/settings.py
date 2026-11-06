"""Environment-driven settings. Secrets come from env / .env (locally) or Fly secrets."""
from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
# Working files (bid documents, triage outputs, gazetteer cache). On Fly this is the volume
# mounted at /data; locally it defaults to ./data.
DATA_DIR = Path(os.environ.get("LEADFINDER_DATA_DIR") or (ROOT / "data"))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    sam_api_key: str = ""
    database_url: str = f"sqlite:///{(DATA_DIR / 'leadfinder.db').as_posix()}"
    http_user_agent_contact: str = ""
    imap_host: str = ""
    imap_user: str = ""
    imap_password: str = ""
    # Autodesk Platform Services app (BuildingConnected). The refresh token is NOT here:
    # it is obtained by the Connect button and stored in data/aps_token.json.
    aps_client_id: str = ""
    aps_client_secret: str = ""
    aps_callback_url: str = "http://localhost:8000/oauth/callback"
    # Claude API (triage of bid documents, D-20)
    anthropic_api_key: str = ""
    triage_budget_usd: float = 10.0        # hard cap per triage session, at list prices
    triage_output_dir: str = ""            # where CLAUDE OUTPUTS/<Project>/ goes; default data/CLAUDE OUTPUTS
    # Supabase (Project Tools). DATABASE_URL above points at its Postgres; these check the
    # signed-in user's token on the worker's document and /bc/authorize endpoints.
    supabase_url: str = ""
    supabase_anon_key: str = ""
    # HMAC key for the 5-minute document download links. Empty: a random key per process.
    download_signing_key: str = ""
    # Project Tools origin: CORS for /bc/authorize and where the OAuth callback sends people back.
    app_url: str = "http://localhost:5173"
    # This worker's own public URL (the tab calls /bc/authorize on it), e.g. https://instrata-leadfinder.fly.dev
    public_url: str = "http://localhost:8080"
    # Bid documents (SAM attachment downloads, uploads, downloads) and triage need persistent disk
    # for the lead folders. Off where the worker has none (the interim Fly deploy); leads, scoring,
    # offices and reviews work either way.
    documents_enabled: bool = True
    # Daily scheduled run, local hour in America/New_York; negative disables it.
    schedule_hour_et: int = 6

    @property
    def user_agent(self) -> str:
        contact = self.http_user_agent_contact or "unset"
        return f"AV-Lead-Finder/0.1 (Instrata POC; +{contact})"

    @property
    def resolved_database_url(self) -> str:
        # Make relative sqlite paths relative to the repo root, not the CWD.
        url = self.database_url
        # Supabase hands out postgres:// / postgresql:// URLs; SQLAlchemy needs the driver named.
        for scheme in ("postgres://", "postgresql://"):
            if url.startswith(scheme):
                return "postgresql+psycopg://" + url[len(scheme):]
        prefix = "sqlite:///"
        if url.startswith(prefix) and not Path(url[len(prefix):]).is_absolute():
            return prefix + (ROOT / url[len(prefix):]).as_posix()
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()


_extra_secrets: set[str] = set()


def register_secret(value: str | None) -> None:
    """Add a runtime secret (an OAuth access or refresh token) to the redaction list."""
    if value and len(value) >= 8:
        _extra_secrets.add(value)


_TOKENISH = re.compile(
    r"""((?:access_token|refresh_token|client_secret|code)["']?\s*[=:]\s*["']?)[^&\s"',}]+""")
_BEARER = re.compile(r"(Bearer\s+)[A-Za-z0-9._\-~+/=]+")


def redact(text: str | None) -> str | None:
    """Remove the SAM API key, APS client secret, OAuth tokens and any api_key= or
    token-like query/form/JSON values from text."""
    if text is None:
        return None
    st = get_settings()
    db_password = None
    if "://" in st.database_url and "@" in st.database_url:
        creds = st.database_url.split("://", 1)[1].rsplit("@", 1)[0]
        db_password = creds.split(":", 1)[1] if ":" in creds else None
    for key in (st.sam_api_key, st.aps_client_secret, st.anthropic_api_key, st.download_signing_key,
                db_password, *_extra_secrets):
        if key:
            text = text.replace(key, "REDACTED")
    text = re.sub(r"(api_key=)[^&\s\"']+", r"\1REDACTED", text)
    text = _TOKENISH.sub(r"\1REDACTED", text)
    text = re.sub(r"sk-ant-[A-Za-z0-9_\-]{8,}", "sk-ant-REDACTED", text)
    return _BEARER.sub(r"\1REDACTED", text)
