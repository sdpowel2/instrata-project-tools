# Sales Process Flow

_Started 2026-05-11 16:54 UTC_

---

## User

Let's back up a bit here. I want to reframe how this looks on the entrance. I want to start re-categorizing some things. Let's make the main page just a Pre-Sales or Post-Sales selection. They should have descriptions that look something like this: "Pre-Sales: From lead generation through contract of a project, the pre-sales process guides you through phases, milestones and deliverables for all projects." and then "Post-Sales: From opening the job through close-out and invoicing, the post-sales process covers all phases, milestones and deliverables for the project through completion." Go ahead and implement that opening page which each side linking to their respective flow that you've already generated as well as those sub-pages. Once we have that, we will refine the pre-sales and post-sales flows.

## Assistant

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now let me add the CSS for the new landing and flow views, and update the routing JS.

_[tool: str_replace_edit]_

Now update the routing and rendering JS to handle pre/post separately.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: snip]_

Now update the detail page's back link to go back to the section flow instead of landing.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

The landing page is now a Pre-Sales / Post-Sales selection with the descriptions you specified. Each card links to its own flow page (`#/pre`, `#/post`), and step details now back-link to their respective flow. The breadcrumb trail reflects the new hierarchy: Process Document → Pre/Post-Sales → Step.

## User

Apply comment

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

Removed the Phase 01 / Phase 02 badges from both landing cards.

## User

Apply comment

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

Legend removed from the landing page.

## User

Inside of the individual pre-sales and post-sales flow pages, can we actually add the sub pages for each piece as a right hand side slide out that happens on the existing page, rather than jumping to a new page? Basically the flow is full screen until you click on a step which opens a new card on the right hand side (that's let's say 2/3rds of the screen with all of the information from the subpage and the video) and then minimizes the flow to the other 1/3rd of the screen on the left hand side. There should be a "back" button that persists at the top which just closes the right hand card and goes back to full screen flow diagram.

## Assistant

_[tool: snip]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: snip]_

_[tool: read_file]_

Now restructure the flow section to include the split-layout container with a detail panel.

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

Step details now slide out as a right-hand panel (≈2/3 width), collapsing the flow chart to the left third. A "Back to flow" button at the top of the panel closes it and restores the full-screen flow.

## User

Apply comment

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Capped the video frame at 200px so it no longer dominates the panel — the rest of the step content (action item, summary, details, notes) now scrolls into view normally.

## User

I would rather the video not scroll at all and just stay fixed at the top of that card. Everything else scrolls WITH the video.

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

The video card now sits pinned above the scrolling content area — it stays put while the rest of the step info scrolls beneath it.

## User

Can you also change the video to where the frame size is locked at a standard 16:9 aspect and centered at the top rather than spanning the whole page?

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Video card is now locked at 16:9 and centered above the scrolling content.

## User

Can you video also scroll with the rest of the page? As in when I scroll down below the video it goes out of frame instead of persisting at the top in full view?

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Video now scrolls with the rest of the panel content.

## User

I'm saying I want the video to scroll underneath the banner at the top of the card instead of overlaying on top of the text.

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Video card was inheriting `position: sticky` from the base `.video-card` style — overrode it to `position: static` so it scrolls naturally beneath the top banner.

## User

Apply comment

## Assistant

_[tool: snip]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Phase eyebrows removed from both flow page headers.

## User

I like the way the watermark is cutoff on the corner of the main page and the orange/blue highlight at the top of that. Can you make that the same on the pre-sales and post sales page? Watermark gets cutoff at the corner of the card and the highlight shows at the top of the flow card for both pre-sales and post-sales which ties it back to the homepage meaningfully.

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Pre-Sales and Post-Sales flow cards now have the orange / navy top border and the larger corner watermark, matching the landing cards.

## User

Let's actually remove the watermark on the pre-sales and post-sales flow pages altogether. I like them on the front page but not on the following pages.

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Watermarks removed from both flow pages.

