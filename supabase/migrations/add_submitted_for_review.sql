-- Splits the review queue into "engineer's private pre-review" vs
-- "manager's official review queue."
--
-- Before this migration:
--   pending_review = "manager queue waiting" (any run sat here on creation)
--
-- After:
--   pending_review        = engineer's private pre-review (NOT in manager queue)
--   submitted_for_review  = engineer escalated to manager (NEW state)
--   in_review             = manager actively reviewing (unchanged)
--   changes_requested     = sent back to engineer (unchanged)
--   quick_fix             = manager applied small fix themselves (unchanged)
--   approved              = done (unchanged)
--
-- Existing pending_review runs were created under the old semantics — they
-- were meant for manager review. Backfill them to submitted_for_review so
-- nothing falls off the manager's plate during the cutover.

-- Replace the CHECK constraint to include the new status.
ALTER TABLE public.review_runs
  DROP CONSTRAINT IF EXISTS review_runs_status_check;

ALTER TABLE public.review_runs
  ADD CONSTRAINT review_runs_status_check
  CHECK (status IN (
    'pending_review',
    'submitted_for_review',
    'in_review',
    'changes_requested',
    'quick_fix',
    'approved'
  ));

-- Backfill: any run still in pending_review is from the old semantics, where
-- creation = manager-queued. Move them to submitted_for_review so the
-- manager view doesn't suddenly empty out post-deploy.
UPDATE public.review_runs
   SET status = 'submitted_for_review'
 WHERE status = 'pending_review';
