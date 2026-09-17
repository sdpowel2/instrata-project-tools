-- Read-only diagnostic: which migrations in supabase/migrations/ are applied?
-- Run this in the Supabase SQL editor. It checks the actual schema object each
-- migration introduces (table / column / function / policy / constraint) and
-- reports applied vs MISSING. Detection is by end-state object existence, so a
-- migration whose objects already exist (e.g. folded into the consolidated
-- migration.sql base schema) correctly shows as applied — nothing to run.
-- This query creates/modifies nothing.

with checks(migration, applied) as (
  values
    ('add_auto_reviewer',                    (to_regclass('public.product_catalog') is not null)),
    ('add_bid_leveling',                     (to_regclass('public.bid_leveling_sessions') is not null)),
    ('add_bug_reports',                      (to_regclass('public.bug_reports') is not null)),
    ('add_catalog_cost_uom',                 (exists (select 1 from information_schema.columns where table_schema='public' and table_name='product_catalog' and column_name='price_date'))),
    ('add_catalog_search_rpc',               (exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='search_catalog'))),
    ('add_change_orders',                    (to_regclass('public.change_orders') is not null)),
    ('add_cutsheet_repository',              (to_regclass('public.cutsheet_repository') is not null)),
    ('add_cutsheet_staging_link',            (exists (select 1 from information_schema.columns where table_schema='public' and table_name='submittal_items' and column_name='cutsheet_staging_id'))),
    ('add_dtools_catalog_fields',            (exists (select 1 from information_schema.columns where table_schema='public' and table_name='product_catalog' and column_name='product_url'))),
    ('add_dtools_project_fields',            (exists (select 1 from information_schema.columns where table_schema='public' and table_name='projects' and column_name='dtools_project_id'))),
    ('add_legacy_engineer',                  (exists (select 1 from information_schema.columns where table_schema='public' and table_name='projects' and column_name='legacy_engineer_id'))),
    -- add_mcp_tokens is intentionally absent: its objects are removed by drop_mcp_tokens (below).
    ('drop_mcp_tokens',                      (to_regclass('public.mcp_tokens') is null and not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='resolve_mcp_token'))),
    ('add_monday_link_and_status_expansion', (exists (select 1 from information_schema.columns where table_schema='public' and table_name='projects' and column_name='project_code'))),
    ('add_notifications',                    (to_regclass('public.notifications') is not null)),
    ('add_oauth_server',                     (to_regclass('public.oauth_clients') is not null and exists (select 1 from pg_roles where rolname='mcp_service'))),
    ('add_personal_ops',                     (to_regclass('public.ms_graph_tokens') is not null)),
    ('add_phase_value_owner',                (exists (select 1 from information_schema.columns where table_schema='public' and table_name='projects' and column_name='owner_id'))),
    ('add_priced_from_to_bom',               (exists (select 1 from information_schema.columns where table_schema='public' and table_name='project_bom_items' and column_name='priced_from'))),
    ('add_product_manuals',                  (exists (select 1 from information_schema.columns where table_schema='public' and table_name='closeout_packages' and column_name='product_manual_url'))),
    ('add_project_comments',                 (to_regclass('public.project_comments') is not null)),
    ('add_project_milestones',               (to_regclass('public.project_milestones') is not null)),
    ('add_purchasing',                       (to_regclass('public.purchasing_modules') is not null)),
    ('add_quick_start_guide',                (to_regclass('public.quick_start_rooms') is not null)),
    ('add_region_and_monday',                (exists (select 1 from information_schema.columns where table_schema='public' and table_name='projects' and column_name='monday_item_id'))),
    ('add_submittal_item_approval',          (exists (select 1 from information_schema.columns where table_schema='public' and table_name='submittal_items' and column_name='approval_state'))),
    ('add_submitted_for_review',             (exists (select 1 from pg_constraint where conname='review_runs_status_check' and pg_get_constraintdef(oid) like '%submitted_for_review%'))),
    ('add_vendor_contacts',                  (to_regclass('public.vendor_contacts') is not null)),
    ('add_warehouses',                       (to_regclass('public.warehouses') is not null)),
    ('allow_self_add_to_project',            (exists (select 1 from pg_policies where schemaname='public' and tablename='project_members' and policyname='Users can add themselves to projects'))),
    ('enable_rls_project_code_counters',     (exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='project_code_counters' and c.relrowsecurity))),
    ('fix_admin_rls_recursion',              (exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='is_admin' and p.prosecdef))),
    ('fix_project_code_counter',             (to_regclass('public.project_code_counters') is not null)),
    ('open_project_visibility',              (exists (select 1 from pg_policies where schemaname='public' and tablename='projects' and policyname='Authenticated users can view all projects'))),
    ('open_project_view_access',             (exists (select 1 from pg_policies where schemaname='public' and tablename='project_bom_items' and policyname='Authenticated users can view bom items')))
)
select
  case when applied then '✅ applied' else '❌ MISSING — run it' end as status,
  migration
from checks
order by applied asc, migration asc;
