# Interactive process documentation

_Started 2026-05-09 00:31 UTC_

---

## User

Take a look at the attached process doc for my team. The format is the front page is a clickable flow chart where each link is clickable and takes you into a sub page that details that step. I want to turn this into an interactive HTML artifact where the home page is the flow chart and the sub pages are the details of each step with an embedded video inline persisting at the top that will be a screenshare video tutorial of that step. Use the instrata design system to build this artifact.

## Assistant

_[tool: list_files]_

_[tool: invoke_skill]_

_[tool: run_script]_

_[tool: write_file]_

_[tool: snip]_

_[tool: list_files]_

_[tool: read_file]_

_[tool: list_files]_

_[tool: list_files]_

_[tool: copy_files]_

_[tool: snip]_

_[tool: write_file]_

Now I have everything I need. Let me build the interactive process doc as a single-page app with hash routing.

_[tool: snip]_

_[tool: write_file]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Built **Process Doc.html** — clickable flow chart home with two phases (Pre-Sales, 11 steps · Post-Sales, 23 steps grouped into Project Setup, Engineering & Procurement, Project Management, Pre-Install, Install & Commission, Closeout). Each node opens a detail page with a sticky video card on the right (placeholder ready for screenshare tutorials), action item, summary, details, notes, and prev/next step nav.

To plug in real videos, edit `videoUrl` on each step in `steps.js` — happy to wire that to actual `<video>` playback (with localStorage timestamp persistence) once you have the recordings.

