"""AV pre-sales triage of a lead's bid documents, run on Claude Managed Agents (DECISIONS D-20).

Setup (once, `leadfinder triage setup`, also done lazily on first use):
  - upload Skills/av-triage.skill (or Skills/av-triage/) to the Skills API; a changed SKILL.md
    becomes a new skill version,
  - create a cloud environment with no network access,
  - create an agent (claude-opus-5-5, built-in file/bash tools, web tools off) with the skill.
  IDs live in the lf_secret table (key triage_agent).

Per triage:
  - upload every file in the lead's document folder (unpacked zips are skipped; their contents
    go instead) and mount them read-only at /mnt/session/uploads/PROJECTS/<Project>/,
  - start a session with a dollar cap, telling the agent the facts the lead finder already knows
    (due date, location, nearest office distance, GC, trade, size),
  - poll the session's events until the turn ends (resumable after a restart: the session id is
    recorded first), deny any tool call that waits for approval (nobody is watching),
  - download triage-report.md into <triage_output_dir>/<Project>/Wiki/ (triage-report-v2.md etc.
    when one exists, as the skill specifies), create the standard output tree, record the rating,
    size tier, cost and summary in the lead folder's _leadfinder.json,
  - delete the uploaded copies from the Files API.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from sqlalchemy.orm import Session

from leadfinder import documents as D
from leadfinder.db.models import Opportunity
from leadfinder.settings import DATA_DIR, ROOT, get_settings, redact, register_secret

log = logging.getLogger(__name__)

# None: agent/skill ids are kept in the database (lf_secret 'triage_agent'). Tests point this
# at a file instead.
STATE_PATH: Path | None = None
STATE_KEY = "triage_agent"
SKILL_DIR = ROOT / "Skills"
SKILL_NAME = "av-triage"
MODEL = "claude-opus-5-5"
MAX_SESSION_FILES = 999
POLL_SECONDS = 10.0
MAX_WAIT_SECONDS = 90 * 60
OUTPUT_TREE = ["Wiki/Rooms", "Specifications/Sections", "Drawings/External", "Drawings/Internal", "Estimate",
               "Scope of Work", "RFI Log", "Proposal", "Submittals", "As-Builts"]
REPORT = "triage-report.md"
MA_BETA = "managed-agents-2026-04-01"
DONE_REASONS = {"end_turn"}

# Nobody watches these sessions; this replaces the skill's Cowork folder convention and its
# chat step with paths in the sandbox. The skill itself is unchanged.
SYSTEM = """You run Instrata's av-triage skill unattended for the AV Lead Finder. Use the av-triage skill for every task.

Paths in this sandbox replace the skill's folder convention:
- The project's documents are mounted read-only under /mnt/session/uploads/PROJECTS/<Project Name>/. That folder is the input; read all of it, as the skill says.
- Write the report to exactly /mnt/session/outputs/triage-report.md, in the skill's report format. Write nothing else to /mnt/session/outputs/. Don't create the output folder tree; the host creates it and files the report.
- Scratch work goes in /workspace.

Nobody can answer questions during the run. Where the skill would ask, decide, and record the assumption in RISKS AND NOTES. The sandbox has no internet access; work only from the documents and the lead facts in the request.

Your final message is the short chat summary the skill describes: rating, size tier, bid due, RFI due, and the two or three findings that most affect the decision."""


class TriageError(Exception):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def make_client():
    import anthropic

    key = get_settings().anthropic_api_key
    if not key:
        raise TriageError("ANTHROPIC_API_KEY is not set in .env")
    register_secret(key)
    return anthropic.Anthropic(api_key=key, max_retries=4)


# ---------------------------------------------------------------- the skill

def skill_files(skill_dir: Path | None = None) -> list[tuple[str, bytes, str]]:
    """The skill's files as (path, bytes, mime) under one top-level `av-triage/` folder, from
    Skills/av-triage.skill (a zip, as exported) or a Skills/av-triage/ folder."""
    skill_dir = skill_dir or SKILL_DIR
    out: list[tuple[str, bytes, str]] = []
    packed = skill_dir / f"{SKILL_NAME}.skill"
    folder = skill_dir / SKILL_NAME
    if packed.is_file():
        with zipfile.ZipFile(packed) as zf:
            for info in zf.infolist():
                name = info.filename.replace("\\", "/")
                if info.is_dir() or ".." in name.split("/") or name.startswith("/"):
                    continue
                rel = name.split("/", 1)[1] if name.startswith(f"{SKILL_NAME}/") else name
                out.append((f"{SKILL_NAME}/{rel}", zf.read(info), _mime(rel)))
    elif (folder / "SKILL.md").is_file():
        for p in sorted(folder.rglob("*")):
            if p.is_file():
                rel = p.relative_to(folder).as_posix()
                out.append((f"{SKILL_NAME}/{rel}", p.read_bytes(), _mime(rel)))
    if not any(path == f"{SKILL_NAME}/SKILL.md" for path, _, _ in out):
        raise TriageError(f"no {SKILL_NAME} skill with a SKILL.md found in {skill_dir}")
    return sorted(out)


def _mime(name: str) -> str:
    return {"md": "text/markdown", "py": "text/x-python", "json": "application/json",
            "txt": "text/plain"}.get(name.rsplit(".", 1)[-1].lower(), "application/octet-stream")


def _digest(files: list[tuple[str, bytes, str]]) -> str:
    h = hashlib.sha256()
    for path, data, _ in files:
        h.update(path.encode() + b"\0" + data + b"\0")
    return h.hexdigest()


# ---------------------------------------------------------------- setup

def load_state() -> dict:
    if STATE_PATH is None:
        from leadfinder import kv
        data = kv.get_secret(STATE_KEY)
        return data if isinstance(data, dict) else {}
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    if STATE_PATH is None:
        from leadfinder import kv
        kv.set_secret(STATE_KEY, state)
        return
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_name(STATE_PATH.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, STATE_PATH)


def _agent_config(skill_id: str) -> dict:
    return {
        "name": "AV Lead Finder triage",
        "description": "Runs the av-triage skill on a lead's bid documents.",
        "model": MODEL,
        "system": SYSTEM,
        "skills": [{"type": "custom", "skill_id": skill_id, "version": "latest"}],
        "tools": [{
            "type": "agent_toolset_20260401",
            # always_allow is acceptable only because the sandbox has no network, no
            # credentials and nothing but copies of the bid documents (D-20).
            "default_config": {"enabled": True, "permission_policy": {"type": "always_allow"}},
            "configs": [{"name": "web_fetch", "enabled": False}, {"name": "web_search", "enabled": False}],
        }],
        "metadata": {"app": "leadfinder", "purpose": "av-triage"},
    }


def setup(client=None, log_fn: Callable[[str], None] = lambda m: None) -> dict:
    """Create or update the skill, environment and agent. Idempotent: run again after editing
    the skill or upgrading the app."""
    client = client or make_client()
    state = load_state()
    if state.get("key") != key_fingerprint():  # new key (or first run of this check): re-verify
        state = _verify_ids(client, state, log_fn)
        state["key"] = key_fingerprint()
    files = skill_files()
    digest = _digest(files)

    if not state.get("skill_id"):
        existing = _find_skill(client)
        if existing:  # uploaded before (another machine, or a lost state file): add a version
            client.skills.versions.create(existing, files=files)
            state.update(skill_id=existing, skill_digest=digest)
            log_fn(f"Found skill {SKILL_NAME} ({existing}); uploaded the current SKILL.md as a new version")
        else:
            skill = client.skills.create(files=files, display_name=SKILL_NAME)
            state.update(skill_id=skill.id, skill_digest=digest)
            log_fn(f"Uploaded skill {SKILL_NAME}: {skill.id}")
    elif state.get("skill_digest") != digest:
        ver = client.skills.versions.create(state["skill_id"], files=files)
        state["skill_digest"] = digest
        log_fn(f"Skill changed; uploaded new version {getattr(ver, 'id', '')}")
    else:
        log_fn(f"Skill unchanged ({state['skill_id']})")
    save_state(state)

    if not state.get("environment_id"):
        env = client.beta.environments.create(
            name="leadfinder-triage",
            description="AV Lead Finder triage: no network access.",
            config={"type": "cloud", "networking": {"type": "limited"}},
        )
        state["environment_id"] = env.id
        log_fn(f"Created environment {env.id} (no network)")
        save_state(state)

    cfg = _agent_config(state["skill_id"])
    cfg_digest = hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()
    if not state.get("agent_id"):
        agent = client.beta.agents.create(**cfg)
        state.update(agent_id=agent.id, agent_version=agent.version, agent_digest=cfg_digest)
        log_fn(f"Created agent {agent.id} v{agent.version}")
    elif state.get("agent_digest") != cfg_digest:
        agent = client.beta.agents.update(state["agent_id"], version=state.get("agent_version"), **cfg)
        state.update(agent_version=agent.version, agent_digest=cfg_digest)
        log_fn(f"Updated agent {agent.id} to v{agent.version}")
    else:
        log_fn(f"Agent unchanged ({state['agent_id']} v{state.get('agent_version')})")
    save_state(state)
    return state


def _find_skill(client) -> str | None:
    try:
        for sk in client.skills.list(source="custom"):
            if SKILL_NAME in (_get(sk, "display_name"), _get(sk, "display_title"), _get(sk, "name")):
                return sk.id
    except Exception as exc:
        log.warning("skill lookup failed", extra={"error": redact(_err(exc))})
    return None


def key_fingerprint() -> str:
    """A one-way hash of the API key: tells us the key changed without storing the key."""
    return hashlib.sha256(get_settings().anthropic_api_key.encode()).hexdigest()[:16]


def _verify_ids(client, state: dict, log_fn: Callable[[str], None]) -> dict:
    """Drop saved IDs the current key can't see (a key from another org or workspace)."""
    checks = {"skill_id": lambda i: client.skills.retrieve(i),
              "environment_id": lambda i: client.beta.environments.retrieve(i),
              "agent_id": lambda i: client.beta.agents.retrieve(i)}
    for field, fetch in checks.items():
        if not state.get(field):
            continue
        try:
            fetch(state[field])
        except Exception as exc:
            if getattr(exc, "status_code", None) not in (403, 404):
                raise
            log_fn(f"{field.split('_')[0].capitalize()} {state[field]} isn't visible to this API key; creating a new one")
            state.pop(field)
            state.pop({"skill_id": "skill_digest", "agent_id": "agent_digest"}.get(field, ""), None)
            if field == "agent_id":
                state.pop("agent_version", None)
    if not state.get("skill_id"):  # a new agent must point at the new skill
        for f in ("agent_id", "agent_version", "agent_digest"):
            state.pop(f, None)
    return state


def ensure_setup(client) -> dict:
    state = load_state()
    if (state.get("agent_id") and state.get("environment_id") and state.get("key") == key_fingerprint()
            and state.get("skill_digest") == _digest(skill_files())):
        return state
    return setup(client)


# ---------------------------------------------------------------- one triage

def project_name(opp: Opportunity) -> str:
    return D.safe_name(opp.title, fallback="Untitled project", limit=80)


def output_dir(opp: Opportunity) -> Path:
    root = Path(get_settings().triage_output_dir or (DATA_DIR / "CLAUDE OUTPUTS"))
    return root / project_name(opp)


def input_files(folder: Path) -> list[D.DocFile]:
    """What goes to the sandbox: every file except zips that were unpacked (their contents are
    already listed) and anything over the Files API limit."""
    return [f for f in D.list_files(folder) if not (f.is_zip and f.unpacked)]


def lead_facts(session: Session, opp: Opportunity) -> str:
    x = opp.extra if isinstance(opp.extra, dict) else {}
    near = sorted((d for d in opp.distances if d.office.active), key=lambda d: d.distance_miles)
    loc = ", ".join(v for v in [opp.loc_street, opp.loc_city, opp.loc_state, opp.loc_zip] if v)
    rows = [
        ("Lead finder source", f"{opp.source_id} ({opp.url or 'no link'})"),
        ("Title", opp.title),
        ("Solicitation / number", opp.solicitation_number),
        ("Owner / agency", opp.agency_name if opp.source_id != "buildingconnected" else x.get("owner")),
        ("Inviting GC", x.get("gc") if opp.source_id == "buildingconnected" else None),
        ("Invited trade", x.get("trade")),
        ("Architect / engineer", " / ".join(v for v in [x.get("architect"), x.get("engineer")] if v) or None),
        ("Project size", f"{x['project_sqft']:,.0f} sq ft" if x.get("project_sqft") else None),
        ("Response due (source record)", opp.response_due_at.isoformat() if opp.response_due_at else None),
        ("Job walk (source record)", x.get("job_walk_at")),
        ("RFIs due (source record)", x.get("rfis_due_at")),
        ("Job site (source record)", loc or None),
        ("Nearest Instrata office", f"{near[0].office.name}, {near[0].distance_miles:.0f} miles (straight line)" if near else None),
    ]
    return "\n".join(f"- {k}: {v}" for k, v in rows if v)


@dataclass
class Job:
    stage: str = "starting"
    session_id: str | None = None
    started_at: str = ""


JOBS: dict[str, Job] = {}
_lock = threading.Lock()


def claim(opp_id: str) -> Job | None:
    with _lock:
        if opp_id in JOBS:
            return None
        JOBS[opp_id] = job = Job(started_at=_now())
        return job


def release(opp_id: str) -> None:
    with _lock:
        JOBS.pop(opp_id, None)


def _record(folder: Path, run_id: str, **fields: Any) -> dict:
    with D._lock:
        m = D.load_manifest(folder)
        runs = m.setdefault("triage", [])
        run = next((r for r in runs if r.get("id") == run_id), None)
        if run is None:
            run = {"id": run_id}
            runs.append(run)
        run.update({k: v for k, v in fields.items()})
        D.save_manifest(folder, m)
        return dict(run)


def runs(folder: Path | None) -> list[dict]:
    return list(reversed(D.load_manifest(folder).get("triage", []))) if folder else []


def needs_nda_ok(opp: Opportunity) -> bool:
    x = opp.extra if isinstance(opp.extra, dict) else {}
    return bool(x.get("nda_required"))


def start(session: Session, opp: Opportunity, client=None, nda_ok: bool = False, job: Job | None = None,
          budget_usd: float | None = None) -> dict:
    """Upload the documents and start a session. Returns the run record (status 'running')."""
    if needs_nda_ok(opp) and not nda_ok:
        raise TriageError("This invite requires an NDA. Confirm the NDA allows sending the documents to Anthropic first.")
    folder = D.lead_folder(opp)
    files = input_files(folder) if folder else []
    if not files:
        raise TriageError("No documents to triage yet.")
    too_big = [f.rel for f in files if f.size > D.MAX_DOWNLOAD_BYTES]
    if too_big:
        raise TriageError(f"Over the 500 MB per-file limit: {', '.join(too_big[:3])}")
    if len(files) > MAX_SESSION_FILES:
        raise TriageError(f"{len(files):,} files is over the {MAX_SESSION_FILES} files a session can mount; "
                          "remove what isn't needed and rescan.")
    client = client or make_client()
    job = job or Job()
    state = ensure_setup(client)
    project = project_name(opp)
    run_id = "t" + uuid.uuid4().hex[:12]
    budget = budget_usd if budget_usd is not None else get_settings().triage_budget_usd
    _record(folder, run_id, status="uploading", started_at=_now(), project=project, files=len(files),
            budget_usd=budget, uploaded=[])

    uploaded: list[str] = []
    resources = []
    try:
        for i, f in enumerate(files, 1):
            job.stage = f"uploading {i} of {len(files)}"
            with open(folder / f.rel, "rb") as fh:
                meta = client.files.upload(file=(Path(f.rel).name, fh))
            uploaded.append(meta.id)
            resources.append({"type": "file", "file_id": meta.id, "mount_path": f"/PROJECTS/{project}/{f.rel}"})
        _record(folder, run_id, uploaded=uploaded)
        job.stage = "starting session"
        prompt = (f"Triage the project in /mnt/session/uploads/PROJECTS/{project}/ "
                  f"({len(files)} files).\n\nWhat the lead finder already knows (from the source listing; "
                  f"the documents win where they disagree):\n{lead_facts(session, opp)}")
        sess = client.beta.sessions.create(
            agent={"type": "agent", "id": state["agent_id"], "version": state["agent_version"]},
            environment_id=state["environment_id"],
            title=f"Triage: {opp.title[:200]}",
            resources=resources,
            budget={"type": "limit", "max_list_cost": {"amount": str(int(round(budget * 100))), "currency": "USD"}},
            metadata={"opportunity_id": opp.id, "source": opp.source_id},
            initial_events=[{"type": "user.message", "content": [{"type": "text", "text": prompt}]}],
        )
    except Exception as exc:
        _cleanup(client, uploaded)
        run = _record(folder, run_id, status="failed", error=redact(_err(exc)), finished_at=_now(), uploaded=[])
        raise TriageError(run["error"]) from exc
    job.session_id = sess.id
    job.stage = "reading documents"
    return _record(folder, run_id, status="running", session_id=sess.id)


def _err(exc: Exception) -> str:
    msg = getattr(exc, "message", None) or str(exc) or exc.__class__.__name__
    return msg[:500]


def _cleanup(client, file_ids: list[str]) -> None:
    for fid in file_ids:
        try:
            client.files.delete(fid)
        except Exception as exc:  # already gone, or a transient error: storage only
            log.warning("triage upload cleanup failed", extra={"file_id": fid, "error": redact(_err(exc))})


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def wait(opp: Opportunity, run: dict, client=None, job: Job | None = None,
         sleep: Callable[[float], None] = time.sleep, max_wait: float = MAX_WAIT_SECONDS) -> dict:
    """Poll the session until the turn ends; then collect the report. Safe to call again for a
    run left 'running' by a restart."""
    client = client or make_client()
    folder = D.lead_folder(opp)
    sid = run["session_id"]
    seen: set[str] = set()
    summary: list[str] = []
    outcome = None
    deadline = time.monotonic() + max_wait
    while outcome is None:
        for ev in client.beta.sessions.events.list(sid, order="asc", limit=200):
            eid = _get(ev, "id")
            if eid in seen:
                continue
            seen.add(eid)
            et = _get(ev, "type")
            if et == "agent.message":
                text = "".join(_get(b, "text", "") for b in (_get(ev, "content") or []) if _get(b, "type") == "text")
                if text.strip():
                    summary = [text.strip()]  # keep the last message: the skill's chat summary
            elif et in ("agent.tool_use", "agent.mcp_tool_use") and _get(ev, "evaluated_permission") == "ask":
                client.beta.sessions.events.send(sid, events=[{"type": "user.tool_confirmation",
                                                               "tool_use_id": eid, "result": "deny"}])
            elif et == "agent.tool_use" and job is not None:
                job.stage = f"working ({_get(ev, 'name', 'tool')})"
            elif et == "session.error":
                log.warning("triage session error", extra={"session": sid, "error": str(_get(ev, "error"))[:300]})
            elif et == "session.status_idle":
                reason = _get(_get(ev, "stop_reason"), "type")
                if reason != "requires_action":
                    outcome = reason or "idle"
            elif et == "session.status_terminated":
                outcome = "terminated"
        if outcome is None:
            if time.monotonic() > deadline:
                outcome = "timeout"
                break
            sleep(POLL_SECONDS)
    if job is not None:
        job.stage = "collecting report"
    return finish(opp, run, outcome, " ".join(summary), client, folder)


def parse_report(text: str) -> dict:
    def grab(pattern: str) -> str | None:
        m = re.search(pattern, text, re.I | re.M)
        return m.group(1).strip() if m else None
    rating = grab(r"^\s*Rating:\s*(GREEN|YELLOW|RED)\b")
    return {
        "rating": rating.upper() if rating else None,
        "tier": (grab(r"^\s*Project Size:\s*(SMALL|MEDIUM|LARGE|EXTRA LARGE)\b") or "").upper() or None,
        "estimate": grab(r"^\s*Estimate Range:\s*(.+)$"),
        "bid_due": grab(r"^\s*Bid Due:\s*(.+)$"),
        "rfi_due": grab(r"^\s*RFI / Questions Due:\s*(.+)$"),
    }


def finish(opp: Opportunity, run: dict, outcome: str, summary: str, client, folder: Path) -> dict:
    sid = run["session_id"]
    report_text = None
    for attempt in range(4):  # outputs are indexed a moment after the session goes idle
        files = list(client.beta.files.list(scope_id=sid, betas=[MA_BETA]))
        reports = [f for f in files if _get(f, "filename", "").endswith(".md")]
        if reports:
            pick = next((f for f in reports if _get(f, "filename") == REPORT), reports[0])
            report_text = client.files.download(pick.id).read().decode("utf-8", errors="replace")
            break
        if outcome not in DONE_REASONS:
            break
        time.sleep(2.0 if attempt else 1.0)
    cost = None
    try:
        usage = _get(client.beta.sessions.retrieve(sid), "usage")
        lc = _get(usage, "list_cost")
        if lc is not None:
            cost = int(_get(lc, "amount")) / 100
    except Exception as exc:
        log.warning("triage cost lookup failed", extra={"session": sid, "error": redact(_err(exc))})

    fields: dict[str, Any] = {"finished_at": _now(), "stop_reason": outcome, "cost_usd": cost,
                              "summary": summary[:4000] or None}
    if report_text:
        out = output_dir(opp)
        for sub in OUTPUT_TREE:
            (out / sub).mkdir(parents=True, exist_ok=True)
        target = out / "Wiki" / REPORT
        n = 2
        while target.exists():
            target = out / "Wiki" / f"triage-report-v{n}.md"
            n += 1
        target.write_text(report_text, encoding="utf-8")
        fields.update(status="done", report=str(target), **parse_report(report_text))
    else:
        fields.update(status="failed", error={
            "budget_reached": "Stopped at the budget cap before writing a report.",
            "timeout": "Still running after 90 minutes; see the session in the Console.",
        }.get(outcome, f"The session ended ({outcome}) without writing a report."))
    _cleanup(client, run.get("uploaded") or [])
    fields["uploaded"] = []
    return _record(folder, run["id"], **fields)


# ---------------------------------------------------------------- background + resume

def start_background(opp_id: str, nda_ok: bool = False, session_factory=None, client_factory=make_client) -> bool:
    job = claim(opp_id)
    if job is None:
        return False

    def work() -> None:
        from leadfinder.db.session import SessionLocal
        s = (session_factory or SessionLocal)()
        try:
            opp = s.get(Opportunity, opp_id)
            client = client_factory()
            run = start(s, opp, client, nda_ok=nda_ok, job=job)
            wait(opp, run, client, job=job)
        except TriageError as exc:
            log.warning("triage not started", extra={"opp": opp_id, "error": str(exc)})
        except Exception:
            log.exception("triage failed", extra={"opp": opp_id})
            folder = D.lead_folder(s.get(Opportunity, opp_id))
            last = runs(folder)[:1]
            if last and last[0].get("status") in ("uploading", "running"):
                _record(folder, last[0]["id"], status="failed", finished_at=_now(),
                        error="Unexpected error while waiting; use Check again to resume.")
        finally:
            s.close()
            release(opp_id)

    threading.Thread(target=work, daemon=True, name=f"triage-{opp_id[:8]}").start()
    return True


def resume_background(opp_id: str, session_factory=None, client_factory=make_client) -> bool:
    """Pick up the latest unfinished run (after a restart or an error while waiting)."""
    job = claim(opp_id)
    if job is None:
        return False

    def work() -> None:
        from leadfinder.db.session import SessionLocal
        s = (session_factory or SessionLocal)()
        try:
            opp = s.get(Opportunity, opp_id)
            latest = runs(D.lead_folder(opp))[:1]
            run = latest[0] if latest and latest[0].get("status") == "running" and latest[0].get("session_id") else None
            if run:  # never re-collect a finished run: that would file a duplicate report
                job.session_id = run["session_id"]
                wait(opp, run, client_factory(), job=job)
        except Exception:
            log.exception("triage resume failed", extra={"opp": opp_id})
        finally:
            s.close()
            release(opp_id)

    threading.Thread(target=work, daemon=True, name=f"triage-resume-{opp_id[:8]}").start()
    return True


def resume_interrupted(root: Path | None = None, resume=None) -> list[str]:
    """At startup: pick up runs a restart cut off. The session kept going on Anthropic's side,
    so waiting again just collects the report. A run stopped mid-upload never started; mark it."""
    resume = resume or resume_background
    resumed = []
    for folder in D.iter_folders(root):
        last = runs(folder)[:1]
        if not last or last[0].get("status") not in ("running", "uploading"):
            continue
        opp_id = D.load_manifest(folder).get("opportunity_id")
        if last[0].get("status") == "running" and last[0].get("session_id") and opp_id:
            if resume(opp_id):
                resumed.append(opp_id)
        else:
            _record(folder, last[0]["id"], status="failed", finished_at=_now(),
                    error="The app stopped while uploading the documents; run triage again.")
    return resumed


def configured() -> bool:
    try:
        return bool(get_settings().anthropic_api_key) and bool(skill_files())
    except TriageError:
        return False
