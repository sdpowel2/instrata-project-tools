-- Per-item approval state on submittal items. Coexists with the package-level
-- submittal status:
--   * Package = Draft       → items default 'pending', approval UI hidden
--   * Package = Submitted   → items 'pending' until acted on; per-item approval
--                              actions become available
--   * Package = R&R         → same as Submitted (item-level marks editable)
--   * Package = Approved    → all items forced to 'approved'
-- Auto-promotion / demotion logic lives in the store, not the DB.

alter table public.submittal_items
  add column if not exists approval_state text not null default 'pending'
    check (approval_state in ('pending', 'approved', 'revise')),
  add column if not exists approval_changed_at timestamptz,
  add column if not exists approval_changed_by uuid references public.profiles(id) on delete set null;

create index if not exists idx_submittal_items_approval on public.submittal_items (approval_state);
