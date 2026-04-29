-- Purchasing module — bridges approved submittal items to actual POs.
--
-- Data shape:
--   purchasing_modules               (id, project_id, title, …)
--     ├─ purchasing_module_submittals  junction → submittals (one module can
--     │                                  link many submittals; one submittal
--     │                                  can be linked to many modules)
--     ├─ purchasing_items             one row per (module, submittal_item) — only
--     │                                persisted once the purchaser has
--     │                                interacted with the line. Live-linked to
--     │                                submittal_items so display data (mfr,
--     │                                model, qty, sold-in price, vendor) is
--     │                                always fresh.
--     ├─ purchasing_freight           one row per (module, manufacturer) — the
--     │                                always-visible freight line at the
--     │                                bottom of each manufacturer group
--     └─ purchasing_manufacturer_defaults
--                                      per (module, manufacturer) default
--                                      ship-to + need-by; per-item rows can
--                                      override.

create table if not exists public.purchasing_modules (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects on delete cascade,
  title       text not null default '',
  notes       text not null default '',
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.purchasing_module_submittals (
  id                    uuid primary key default gen_random_uuid(),
  purchasing_module_id  uuid not null references public.purchasing_modules on delete cascade,
  submittal_id          uuid not null references public.submittals on delete cascade,
  linked_at             timestamptz not null default now(),
  linked_by             uuid references public.profiles(id) on delete set null,
  unique (purchasing_module_id, submittal_id)
);

create table if not exists public.purchasing_items (
  id                       uuid primary key default gen_random_uuid(),
  purchasing_module_id     uuid not null references public.purchasing_modules on delete cascade,
  submittal_item_id        uuid not null references public.submittal_items on delete cascade,
  -- Purchaser-entered fields
  purchase_unit_price      numeric,
  ship_to_warehouse_id     uuid references public.warehouses(id) on delete set null,
  ship_to_custom_address   text,
  need_by_date             date,
  -- Status machine: not_ordered → ordered → received
  -- 'draft' is computed at render time when the linked submittal is in Draft
  -- or the per-item approval is not 'approved' — never persisted here.
  purchase_status          text not null default 'not_ordered'
    check (purchase_status in ('not_ordered', 'ordered', 'received')),
  ordered_date             date,
  received_date            date,
  po_number                text,
  notes                    text not null default '',
  updated_by               uuid references public.profiles(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (purchasing_module_id, submittal_item_id)
);

create table if not exists public.purchasing_freight (
  id                       uuid primary key default gen_random_uuid(),
  purchasing_module_id     uuid not null references public.purchasing_modules on delete cascade,
  manufacturer             text not null,
  purchase_unit_price      numeric,
  ship_to_warehouse_id     uuid references public.warehouses(id) on delete set null,
  ship_to_custom_address   text,
  need_by_date             date,
  purchase_status          text not null default 'not_ordered'
    check (purchase_status in ('not_ordered', 'ordered', 'received')),
  ordered_date             date,
  received_date            date,
  po_number                text,
  notes                    text not null default '',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (purchasing_module_id, manufacturer)
);

create table if not exists public.purchasing_manufacturer_defaults (
  id                       uuid primary key default gen_random_uuid(),
  purchasing_module_id     uuid not null references public.purchasing_modules on delete cascade,
  manufacturer             text not null,
  ship_to_warehouse_id     uuid references public.warehouses(id) on delete set null,
  ship_to_custom_address   text,
  need_by_date             date,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (purchasing_module_id, manufacturer)
);

-- ---- RLS ----------------------------------------------------------------
alter table public.purchasing_modules               enable row level security;
alter table public.purchasing_module_submittals     enable row level security;
alter table public.purchasing_items                 enable row level security;
alter table public.purchasing_freight               enable row level security;
alter table public.purchasing_manufacturer_defaults enable row level security;

-- purchasing_modules
create policy "Members can view purchasing modules"
  on public.purchasing_modules for select using (public.is_project_member(project_id));
create policy "Members can manage purchasing modules"
  on public.purchasing_modules for all using (public.is_project_member(project_id));

-- purchasing_module_submittals
create policy "Members can view module submittal links"
  on public.purchasing_module_submittals for select using (
    public.is_project_member((select project_id from public.purchasing_modules where id = purchasing_module_id))
  );
create policy "Members can manage module submittal links"
  on public.purchasing_module_submittals for all using (
    public.is_project_member((select project_id from public.purchasing_modules where id = purchasing_module_id))
  );

-- purchasing_items
create policy "Members can view purchasing items"
  on public.purchasing_items for select using (
    public.is_project_member((select project_id from public.purchasing_modules where id = purchasing_module_id))
  );
create policy "Members can manage purchasing items"
  on public.purchasing_items for all using (
    public.is_project_member((select project_id from public.purchasing_modules where id = purchasing_module_id))
  );

-- purchasing_freight
create policy "Members can view purchasing freight"
  on public.purchasing_freight for select using (
    public.is_project_member((select project_id from public.purchasing_modules where id = purchasing_module_id))
  );
create policy "Members can manage purchasing freight"
  on public.purchasing_freight for all using (
    public.is_project_member((select project_id from public.purchasing_modules where id = purchasing_module_id))
  );

-- purchasing_manufacturer_defaults
create policy "Members can view manufacturer defaults"
  on public.purchasing_manufacturer_defaults for select using (
    public.is_project_member((select project_id from public.purchasing_modules where id = purchasing_module_id))
  );
create policy "Members can manage manufacturer defaults"
  on public.purchasing_manufacturer_defaults for all using (
    public.is_project_member((select project_id from public.purchasing_modules where id = purchasing_module_id))
  );

-- ---- Indexes ------------------------------------------------------------
create index if not exists idx_purchasing_modules_project on public.purchasing_modules (project_id);
create index if not exists idx_purchasing_module_submittals_mod on public.purchasing_module_submittals (purchasing_module_id);
create index if not exists idx_purchasing_module_submittals_sub on public.purchasing_module_submittals (submittal_id);
create index if not exists idx_purchasing_items_module on public.purchasing_items (purchasing_module_id);
create index if not exists idx_purchasing_items_submittal_item on public.purchasing_items (submittal_item_id);
create index if not exists idx_purchasing_freight_module on public.purchasing_freight (purchasing_module_id);
create index if not exists idx_purchasing_mfr_defaults_module on public.purchasing_manufacturer_defaults (purchasing_module_id);
