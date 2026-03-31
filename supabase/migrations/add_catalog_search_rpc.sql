-- Prioritized product catalog search.
-- Each word in the search term must appear in at least one of
-- manufacturer, model_number, or description.
-- Results where manufacturer or model_number match any word are ranked first;
-- description-only matches come second.
create or replace function public.search_catalog(
  search_term text,
  page_from int default 0,
  page_to   int default 49
)
returns table (
  id               uuid,
  manufacturer     text,
  model_number     text,
  description      text,
  cost             numeric,
  list_price       numeric,
  unit_of_measure  text,
  category         text,
  price_date       date,
  total_count      bigint
)
language sql stable
as $$
  with words as (
    select unnest(string_to_array(trim(search_term), ' ')) as word
  ),
  -- Items where EVERY word matches at least one of the three columns
  matched as (
    select p.*
    from public.product_catalog p
    where not exists (
      select 1 from words w
      where p.manufacturer  not ilike '%' || w.word || '%'
        and p.model_number  not ilike '%' || w.word || '%'
        and p.description   not ilike '%' || w.word || '%'
    )
  ),
  -- Rank: 0 = manufacturer or model hit on any word, 1 = description only
  ranked as (
    select m.*,
      case when exists (
        select 1 from words w
        where m.manufacturer ilike '%' || w.word || '%'
           or m.model_number ilike '%' || w.word || '%'
      ) then 0 else 1 end as priority
    from matched m
  ),
  counted as (
    select count(*) over () as total_count, r.*
    from ranked r
    order by r.priority, r.manufacturer, r.model_number
  )
  select
    c.id, c.manufacturer, c.model_number, c.description,
    c.cost, c.list_price, c.unit_of_measure, c.category, c.price_date,
    c.total_count
  from counted c
  offset page_from
  limit (page_to - page_from + 1);
$$;
