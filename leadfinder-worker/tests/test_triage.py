"""Triage via Claude Managed Agents (D-20), against a fake API client: no network, no cost."""
import io
import json
import zipfile
from types import SimpleNamespace as NS

import pytest

from leadfinder import documents as D
from leadfinder import triage as T
from leadfinder.settings import get_settings

SKILL_MD = b"---\nname: av-triage\ndescription: test\n---\n# AV Pre-Sales Triage\n"
REPORT = """PROJECT TRIAGE: Audio Visual System Upgrade
PIPELINE CANDIDACY
Rating:   YELLOW
KEY DATES
Bid Due:              2026-11-20 14:00 ET
RFI / Questions Due:  2026-11-10
PROJECT SIZE ESTIMATE  (pre-sales estimate only - not a proposal)
Project Size:   MEDIUM
Estimate Range: $140K - $210K
"""


class FakeClient:
    """Just enough of anthropic.Anthropic for triage.py, recording every call."""

    def __init__(self, events=None, report=REPORT, cost_cents="312"):
        self.calls = []
        self.uploaded = {}
        self.deleted = []
        self.sent = []
        self._events = events if events is not None else [
            NS(id="e1", type="agent.tool_use", name="read", evaluated_permission="allow"),
            NS(id="e2", type="agent.tool_use", name="bash", evaluated_permission="ask"),
            NS(id="e3", type="agent.message", content=[NS(type="text", text="YELLOW, MEDIUM. Bid due Nov 20.")]),
            NS(id="e4", type="session.status_idle", stop_reason=NS(type="end_turn")),
        ]
        self._report = report
        self._cost = cost_cents
        c = self
        self.skills = NS(
            create=lambda **kw: (c.calls.append(("skills.create", kw)), NS(id="skill_1", latest_version_id="v1"))[1],
            list=lambda **kw: [],
            versions=NS(create=lambda sid, **kw: (c.calls.append(("skills.versions.create", sid)), NS(id="skver_2"))[1]),
        )
        self.files = NS(upload=self._upload, delete=lambda fid: c.deleted.append(fid),
                        download=lambda fid: io.BytesIO(c._report.encode()))
        self.beta = NS(
            environments=NS(create=lambda **kw: (c.calls.append(("env.create", kw)), NS(id="env_1"))[1]),
            agents=NS(create=lambda **kw: (c.calls.append(("agents.create", kw)), NS(id="agent_1", version=1))[1],
                      update=lambda aid, **kw: (c.calls.append(("agents.update", kw)), NS(id=aid, version=2))[1]),
            sessions=NS(create=self._session, retrieve=lambda sid: NS(usage=NS(list_cost=NS(amount=c._cost, currency="USD"))),
                        events=NS(list=lambda sid, **kw: list(c._events),
                                  send=lambda sid, events: c.sent.extend(events))),
            files=NS(list=lambda **kw: [NS(id="out_1", filename="triage-report.md")] if c._report else []),
        )

    def _upload(self, file):
        name, fh = file
        fid = f"file_{len(self.uploaded) + 1}"
        self.uploaded[fid] = (name, fh.read())
        return NS(id=fid)

    def _session(self, **kw):
        self.calls.append(("sessions.create", kw))
        return NS(id="sesn_1")


@pytest.fixture
def triage_env(tmp_path, monkeypatch):
    skills = tmp_path / "Skills"
    skills.mkdir()
    with zipfile.ZipFile(skills / "av-triage.skill", "w") as zf:
        zf.writestr("av-triage/SKILL.md", SKILL_MD)
    monkeypatch.setattr(T, "SKILL_DIR", skills)
    monkeypatch.setattr(T, "STATE_PATH", tmp_path / "triage_agent.json")
    monkeypatch.setattr(T, "POLL_SECONDS", 0)
    monkeypatch.setattr(T.time, "sleep", lambda s: None)
    st = get_settings()
    monkeypatch.setattr(st, "anthropic_api_key", "sk-ant-test-0000000000")
    monkeypatch.setattr(st, "triage_output_dir", str(tmp_path / "CLAUDE OUTPUTS"))
    monkeypatch.setattr(st, "triage_budget_usd", 10.0)
    monkeypatch.setattr(D, "DOCS_DIR", tmp_path / "documents")
    return tmp_path


@pytest.fixture
def lead(av_lead, triage_env):
    _, s, opp = av_lead
    folder = D.lead_folder(opp, create=True)
    (folder / "Spec 27 41 00.pdf").write_bytes(b"%PDF spec")
    z = folder / "Drawings.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("T-101.pdf", b"%PDF t101")
    z.write_bytes(buf.getvalue())
    D.unpack_zip(z, folder)
    return s, opp, folder


from tests.test_documents import av_lead  # noqa: E402,F401  (reuse the SAM lead fixture)


def test_skill_files_from_export_and_folder(tmp_path, monkeypatch):
    d = tmp_path / "Skills"
    d.mkdir()
    with zipfile.ZipFile(d / "av-triage.skill", "w") as zf:
        zf.writestr("SKILL.md", SKILL_MD)  # no top folder: still filed under av-triage/
        zf.writestr("../evil.md", b"x")
    assert [p for p, _, _ in T.skill_files(d)] == ["av-triage/SKILL.md"]
    (d / "av-triage.skill").unlink()
    with pytest.raises(T.TriageError):
        T.skill_files(d)
    (d / "av-triage").mkdir()
    (d / "av-triage" / "SKILL.md").write_bytes(SKILL_MD)
    assert T.skill_files(d)[0][2] == "text/markdown"


def test_setup_is_idempotent_and_versions_changes(triage_env):
    c = FakeClient()
    st = T.setup(c)
    assert (st["skill_id"], st["environment_id"], st["agent_id"]) == ("skill_1", "env_1", "agent_1")
    agent_kw = next(kw for name, kw in c.calls if name == "agents.create")
    assert agent_kw["model"] == "claude-opus-5-5"
    assert agent_kw["skills"] == [{"type": "custom", "skill_id": "skill_1", "version": "latest"}]
    web = {x["name"]: x["enabled"] for x in agent_kw["tools"][0]["configs"]}
    assert web == {"web_fetch": False, "web_search": False}
    env_kw = next(kw for name, kw in c.calls if name == "env.create")
    assert env_kw["config"]["networking"] == {"type": "limited"}  # no hosts, no package managers

    c2 = FakeClient()
    T.setup(c2)
    assert c2.calls == []  # nothing changed: nothing created

    with zipfile.ZipFile(T.SKILL_DIR / "av-triage.skill", "w") as zf:
        zf.writestr("av-triage/SKILL.md", SKILL_MD + b"\nNew rule.\n")
    c3 = FakeClient()
    T.setup(c3)
    assert [n for n, _ in c3.calls] == ["skills.versions.create"]


def test_triage_end_to_end(lead):
    s, opp, folder = lead
    c = FakeClient()
    run = T.start(s, opp, c)
    assert run["status"] == "running" and run["session_id"] == "sesn_1"

    sess_kw = next(kw for name, kw in c.calls if name == "sessions.create")
    project = T.project_name(opp)
    mounts = sorted(r["mount_path"] for r in sess_kw["resources"])
    assert mounts == [f"/PROJECTS/{project}/Drawings/T-101.pdf", f"/PROJECTS/{project}/Spec 27 41 00.pdf"]
    assert sess_kw["budget"] == {"type": "limit", "max_list_cost": {"amount": "1000", "currency": "USD"}}
    prompt = sess_kw["initial_events"][0]["content"][0]["text"]
    assert f"/mnt/session/uploads/PROJECTS/{project}/" in prompt and "Nearest Instrata office" in prompt

    done = T.wait(opp, run, c)
    assert done["status"] == "done" and done["rating"] == "YELLOW" and done["tier"] == "MEDIUM"
    assert done["estimate"] == "$140K - $210K" and done["bid_due"].startswith("2026-11-20")
    assert done["cost_usd"] == 3.12 and done["summary"].startswith("YELLOW")
    assert c.sent == [{"type": "user.tool_confirmation", "tool_use_id": "e2", "result": "deny"}]
    assert sorted(c.deleted) == sorted(c.uploaded)  # uploaded copies removed

    out = T.output_dir(opp)
    assert (out / "Wiki" / "triage-report.md").read_text(encoding="utf-8") == REPORT
    for sub in T.OUTPUT_TREE:
        assert (out / sub).is_dir()
    assert T.runs(folder)[0]["report"].endswith("triage-report.md")

    T.wait(opp, T.start(s, opp, FakeClient()), FakeClient())  # re-triage: kept side by side
    assert (out / "Wiki" / "triage-report-v2.md").exists()
    assert len(T.runs(folder)) == 2


def test_budget_reached_is_reported(lead):
    s, opp, folder = lead
    c = FakeClient(events=[NS(id="e1", type="session.status_idle", stop_reason=NS(type="budget_reached"))], report="")
    done = T.wait(opp, T.start(s, opp, c), c)
    assert done["status"] == "failed" and "budget cap" in done["error"]
    assert c.deleted


def test_nda_and_empty_folder_gates(lead, triage_env):
    s, opp, folder = lead
    opp.extra = {**(opp.extra or {}), "nda_required": True}
    with pytest.raises(T.TriageError, match="NDA"):
        T.start(s, opp, FakeClient())
    assert T.start(s, opp, FakeClient(), nda_ok=True)["status"] == "running"
    for f in list(folder.rglob("*")):
        if f.is_file() and f.name != D.MANIFEST:
            f.unlink()
    with pytest.raises(T.TriageError, match="No documents"):
        T.start(s, opp, FakeClient(), nda_ok=True)


def test_parse_report_missing_fields():
    assert T.parse_report("nothing here") == {"rating": None, "tier": None, "estimate": None,
                                              "bid_due": None, "rfi_due": None}


def test_resume_interrupted_after_restart(lead):
    s, opp, folder = lead
    T.wait(opp, T.start(s, opp, FakeClient()), FakeClient())  # an older finished run
    called = []
    assert T.resume_interrupted(resume=lambda oid: called.append(oid) or True) == []  # nothing in flight

    T.start(s, opp, FakeClient())  # cut off by a restart while waiting
    assert T.resume_interrupted(resume=lambda oid: called.append(oid) or True) == [opp.id]

    T._record(folder, T.runs(folder)[0]["id"], status="uploading", session_id=None)  # cut off mid-upload
    assert T.resume_interrupted(resume=lambda oid: called.append(oid) or True) == []
    assert called == [opp.id] and T.runs(folder)[0]["status"] == "failed"


def test_new_api_key_recreates_resources_it_cannot_see(triage_env, monkeypatch):
    T.setup(FakeClient())
    assert T.load_state()["key"] == T.key_fingerprint()

    class NotFound(Exception):
        status_code = 404

    def gone(*a, **kw):
        raise NotFound("not found")

    monkeypatch.setattr(get_settings(), "anthropic_api_key", "sk-ant-other-org-1111111111")
    c = FakeClient()
    c.skills.retrieve = c.beta.environments.retrieve = c.beta.agents.retrieve = gone
    c.skills.create = lambda **kw: (c.calls.append(("skills.create", kw)), NS(id="skill_org"))[1]
    c.beta.agents.create = lambda **kw: (c.calls.append(("agents.create", kw)), NS(id="agent_org", version=1))[1]
    st = T.ensure_setup(c)
    assert [n for n, _ in c.calls] == ["skills.create", "env.create", "agents.create"]
    assert (st["skill_id"], st["agent_id"]) == ("skill_org", "agent_org")
    assert st["key"] == T.key_fingerprint() and "sk-ant" not in json.dumps(st)
