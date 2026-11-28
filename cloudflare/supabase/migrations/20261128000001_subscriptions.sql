-- Subscriptions: every recurring charge with where it is paid from, what the receipts say about it,
-- and the merchant's own account page next to its cancel page. Additive only: new nullable columns,
-- a wider source list, one view and one trigger. Nothing is dropped, renamed or deleted.

-- Where a charge is paid from when you or a receipt says so (the view falls back to the latest
-- matching bank line), what the receipts show, and the bank lines and mails it rests on.
alter table public.nx_recurring
  add column if not exists paying_account text,
  add column if not exists billing_status text check (billing_status in ('active', 'failing', 'cancelled')),
  add column if not exists evidence text[];

comment on column public.nx_recurring.paying_account is 'Where it is paid from when a receipt or you say so, for example "Amex" or "bunq main". Null: the latest matching bank line decides (nx_subscriptions.paid_from).';
comment on column public.nx_recurring.billing_status is 'What the merchant''s mails and the bank lines show: active, failing (a payment failed) or cancelled (it no longer renews). Null: found running in the bank lines.';
comment on column public.nx_recurring.evidence is 'What the row rests on: nx_transactions ids and gmail:<message id>.';

-- Rows added by hand from receipts and bank lines that the automatic run cannot find on its own.
alter table public.nx_recurring drop constraint if exists nx_recurring_source_check;
alter table public.nx_recurring add constraint nx_recurring_source_check check (source in ('bank', 'apple', 'manual'));

-- The account page beside the cancel page (url).
alter table public.nx_cancel_routes add column if not exists manage_url text;
comment on column public.nx_cancel_routes.manage_url is 'The merchant''s account page where the subscription is seen and managed. url is the cancel page.';

-- The daily spend run (service key) removes rows it no longer finds. A manual row is one it can
-- never find, so that delete is skipped; a delete from the app still goes through.
create or replace function public.nx_recurring_keep_manual()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.source = 'manual' and current_user = 'service_role' then
    return null;
  end if;
  return old;
end;
$$;

drop trigger if exists nx_recurring_keep_manual on public.nx_recurring;
create trigger nx_recurring_keep_manual
  before delete on public.nx_recurring
  for each row execute function public.nx_recurring_keep_manual();

-- The phone's Subscriptions list: each recurring row with the account it is paid from and whether
-- that is bunq. Runs as the caller, so the row policies of nx_recurring and nx_transactions apply.
create or replace view public.nx_subscriptions
with (security_invoker = true)
as
select r.*,
       coalesce(r.paying_account, l.paid_from) as paid_from,
       coalesce(coalesce(r.paying_account, l.paid_from) ilike 'bunq%', false) as on_bunq
from public.nx_recurring r
left join lateral (
  select case t.source when 'abn' then 'ABN AMRO ' || t.account
                       when 'bunq' then 'bunq ' || t.account
                       when 'amex' then 'Amex'
                       else t.source || ' ' || t.account end as paid_from
  from public.nx_transactions t
  where t.user_id = r.user_id
    and t.amount < 0
    and regexp_replace(lower(coalesce(t.merchant, '')), '[^a-z0-9]+', '', 'g') = split_part(r.key, '|', 1)
    and (r.amount is null or abs(-t.amount - r.amount) <= r.amount * 0.15)
  order by t.booked_on desc
  limit 1
) l on true;

comment on view public.nx_subscriptions is 'nx_recurring with paid_from (your paying_account, else the latest matching bank line) and on_bunq. Read by the phone''s Subscriptions list.';

revoke all on public.nx_subscriptions from anon;
grant select on public.nx_subscriptions to authenticated;
