-- Sync: data-cleanliness counts for Hope's Queue, 2026-10-20 (Seth; closes O-2, O-8).
-- Run once in the SQL Editor; safe to re-run. Both schemas. Needs sync_won_tasks.sql.
--
-- One "Data Cleanliness" row in Hope's Queue (Background) counts blank required
-- fields on ACTIVE work only (old Won / Completed items would bury the real gaps):
--   Pre-Sales    Follow Up + Won items whose Contract Date is in the current year
--   Post-Sales   In Progress, Install, Close Out
--   Programming  On Radar, Active, Close Out
-- Exemptions: Post-Sales Programmer is only required when the job is on the
-- Programming board (matched by Project Number). Numbers: 0 counts as filled.
-- Cutsheet / Shop Drawings due dates are required on every job (Seth 2026-10-20).
-- The sandbox engine reads the production Post-Sales and Programming boards
-- (read-only; there are no sandbox copies).
do $$
declare
  s text;
begin
  foreach s in array array['public', 'sync_sandbox'] loop
    if to_regclass(format('%I.config_boards', s)) is null then
      continue;
    end if;

    execute format($q$update %I.config_boards set monday_board_id = 9358385694, title = 'AV Programming Project Summary', updated_at = now()
                      where board_key = 'programming'$q$, s);

    execute format($q$
      insert into %I.config_groups (board_key, group_key, monday_group_id, title) values
        ('postsales',   'in_progress', 'topics',         'In Progress'),
        ('postsales',   'install',     'new_group70660', 'Install'),
        ('postsales',   'close_out',   'new_group52749', 'Close Out'),
        ('programming', 'on_radar',    'group_mkrvrja1', 'On Radar'),
        ('programming', 'active',      'group_title',    'Active'),
        ('programming', 'close_out',   'group_mkrvgkta', 'Close Out')
      on conflict (board_key, group_key) do update set monday_group_id = excluded.monday_group_id, title = excluded.title, updated_at = now()
    $q$, s);

    execute format($q$
      insert into %I.config_field_registry (semantic_key, board_key, monday_column_id, column_type, owner, title) values
        ('postsales.project_manager',     'postsales',   'dropdown',                 'dropdown', 'monday', 'Project Manager'),
        ('postsales.presales_engineer',   'postsales',   'multiple_person_mm4sd38q', 'people',   'monday', 'Pre-Sales Engineer'),
        ('postsales.programmer',          'postsales',   'people',                   'people',   'monday', 'Programmer'),
        ('postsales.cutsheet_due',        'postsales',   'date_mksn1dmg',            'date',     'monday', 'Cutsheet Submittals Due'),
        ('postsales.shop_drawings_due',   'postsales',   'date8',                    'date',     'monday', 'Shop Drawings Due'),
        ('programming.presales_engineer', 'programming', 'multiple_person_mm4srewb', 'people',   'monday', 'Pre-Sales Engineer'),
        ('programming.postsales_engineer','programming', 'multiple_person_mm4s718d', 'people',   'monday', 'Post-Sales Engineer'),
        ('programming.business_unit',     'programming', 'dropdown_mkxj80f2',        'dropdown', 'monday', 'Business Unit'),
        ('programming.project_manager',   'programming', 'dropdown_mksmkxs7',        'dropdown', 'monday', 'Project Manager'),
        ('programming.manufacturer',      'programming', 'dropdown_mkrvtwj9',        'dropdown', 'monday', 'Manufacturer'),
        ('programming.project_number',    'programming', 'text_mm5wc4mx',            'text',     'monday', 'Project Number')
      on conflict (semantic_key) do update
        set monday_column_id = excluded.monday_column_id, column_type = excluded.column_type, title = excluded.title, updated_at = now()
    $q$, s);

    execute format($q$
      insert into %I.config_cleanliness_rule (board_key, semantic_key, exempt_when, notes) values
        ('presales',    'presales.quoted_price',          '{}', ''),
        ('presales',    'presales.gm_pct',                '{}', ''),
        ('presales',    'presales.premiere_protect',      '{}', '0 counts as filled: enter 0 when there is no Protect'),
        ('presales',    'presales.programming',           '{}', ''),
        ('presales',    'presales.quote_number',          '{}', ''),
        ('presales',    'presales.win_pct',               '{}', ''),
        ('presales',    'presales.business_unit',         '{}', ''),
        ('presales',    'presales.sales_person',          '{}', ''),
        ('postsales',   'postsales.project_manager',      '{}', ''),
        ('postsales',   'postsales.presales_engineer',    '{}', ''),
        ('postsales',   'postsales.programmer',           '{"not_on_programming_board": true}', 'Only required when the job is on the Programming board (by Project Number)'),
        ('postsales',   'postsales.cutsheet_due',         '{}', 'Required on every job (Seth 2026-10-20)'),
        ('postsales',   'postsales.shop_drawings_due',    '{}', 'Required on every job (Seth 2026-10-20)'),
        ('postsales',   'postsales.project_number',       '{}', ''),
        ('programming', 'programming.presales_engineer',  '{}', ''),
        ('programming', 'programming.postsales_engineer', '{}', ''),
        ('programming', 'programming.business_unit',      '{}', ''),
        ('programming', 'programming.project_manager',    '{}', ''),
        ('programming', 'programming.manufacturer',       '{}', '')
      on conflict (board_key, semantic_key) do update set exempt_when = excluded.exempt_when, notes = excluded.notes, updated_at = now()
    $q$, s);

    execute format($q$
      insert into %I.config_settings (key, value, description) values
        ('cleanliness_scope',
         '{"presales": {"groups": ["follow_up"], "won_current_year": true}, "postsales": {"groups": ["in_progress", "install", "close_out"]}, "programming": {"groups": ["on_radar", "active", "close_out"]}}',
         'Which groups the data-cleanliness count covers (active work only; Seth 2026-10-20). Pre-Sales also counts Won items with a Contract Date this year.')
      on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = now()
    $q$, s);
  end loop;
end $$;
