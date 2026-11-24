-- Accounts screen: every account and service Nexus reads, how fresh it is,
-- what is missing, and the connections that keep it current.
--   * eToro and Enable Banking join Google and Wise as connections (keys in Vault).
--   * nx_bank_links: one Enable Banking consent per bank, written only by the edge function.
--   * Bank lines from an API carry the payee, so the parser uses it as given.
--   * Catalog, links, windows and the daily sync schedule live in app_config.

-- 1. Providers.
alter table public.integration_connections drop constraint if exists integration_connections_provider_check;
alter table public.integration_connections add constraint integration_connections_provider_check
  check (provider in ('google', 'wise', 'etoro', 'enable_banking'));

-- 2. One bank consent per catalog bank, written by the accounts function only.
create table if not exists public.nx_bank_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  catalog_id text not null,
  aspsp_name text not null,
  aspsp_country text not null,
  session_id text not null,
  valid_until timestamptz,
  accounts jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'expired', 'error', 'revoked')),
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (user_id, catalog_id)
);
comment on table public.nx_bank_links is
  'Enable Banking consents per bank. accounts holds per account: uid, last4, name, currency, source, bank balance and its date. Written only by the accounts edge function.';
alter table public.nx_bank_links enable row level security;
drop policy if exists nx_bank_links_select_own on public.nx_bank_links;
create policy nx_bank_links_select_own on public.nx_bank_links for select to authenticated
  using (user_id = auth.uid());
revoke all on public.nx_bank_links from anon;
revoke insert, update, delete, truncate on public.nx_bank_links from authenticated;

-- 3. A line that arrives with its payee (bank APIs, the Nexus ledger format) is
--    read as given; ABN AMRO export text without a payee is still parsed.
create or replace function public.nx_parse_bank_line(p_source text, p_description text, p_payee text, p_counterparty text)
returns table(tx_type text, payee text, counterparty_iban text, details text)
language plpgsql immutable set search_path to 'public'
as $function$
declare
  d text := coalesce(p_description, '');
  ws constant text := E' \t\r\n';
  v_kind text; v_rest text; v_name text; v_iban text; v_remi text;
  m text[];
begin
  if coalesce(p_source, '') <> 'abn' or btrim(coalesce(p_payee, ''), ws) <> '' then
    counterparty_iban := btrim(coalesce(p_counterparty, ''), ws);
    tx_type := p_source || case when counterparty_iban = '' then ' card' else ' sepa' end;
    payee := btrim(coalesce(p_payee, ''), ws);
    details := btrim(btrim(regexp_replace(btrim(d, ws), '\s+', ' ', 'g'), ws) || ' ' || counterparty_iban, ws);
    return next;
    return;
  end if;

  if d like '/TRTP/%' then
    v_kind := ''; v_name := ''; v_iban := ''; v_remi := '';
    for m in select regexp_matches(d,
        '(?:/(TRTP|CSID|NAME|MARF|REMI|IBAN|BIC|EREF|ORDP|BENM|ID|ADDR|SVCL)/(.*?)(?=/(?:TRTP|CSID|NAME|MARF|REMI|IBAN|BIC|EREF|ORDP|BENM|ID|ADDR|SVCL)/|$)){1,1}?', 'g') loop
      case m[1]
        when 'TRTP' then v_kind := btrim(m[2], ws);
        when 'NAME' then v_name := btrim(m[2], ws);
        when 'IBAN' then v_iban := btrim(m[2], ws);
        when 'REMI' then v_remi := btrim(m[2], ws);
        else null;
      end case;
    end loop;
    tx_type := v_kind; payee := v_name; counterparty_iban := v_iban;
    details := btrim(v_remi || ' ' || v_iban, ws);
    return next;
    return;
  end if;

  v_kind := btrim(substr(d, 1, 33), ws);
  v_rest := substr(d, 34);
  if upper(replace(v_kind, ' ', '')) ~ '^(BEA|GEA|ECOM)' then
    v_name := btrim(substr(v_rest, 1, 32), ws);
    v_name := btrim(regexp_replace(v_name, '(,PAS[0-9]+| NR:).*$', ''), ws);
    tx_type := v_kind; payee := v_name; counterparty_iban := '';
    details := btrim(v_rest, ws);
    return next;
    return;
  end if;

  v_name := substring(d from 'Naam:\s*?(.+?)(?=\s{2,}|Machtiging:|Omschrijving:|IBAN:|Kenmerk:|BIC:|$)');
  v_iban := coalesce(substring(d from 'IBAN:\s*([A-Z]{2}[0-9]{2}[A-Z0-9]{8,30})'), '');
  tx_type := v_kind;
  payee := coalesce(nullif(btrim(v_name, ws), ''), nullif(btrim(substr(v_rest, 1, 32), ws), ''), v_kind);
  counterparty_iban := v_iban;
  details := btrim(btrim(v_rest, ws) || ' ' || v_iban, ws);
  return next;
end $function$;

-- 4. Catalog, links, windows, schedule.
insert into public.app_config (key, value, description) values
('integrations.catalog', $json$[
  {"id":"abn","name":"ABN AMRO","kind":"bank","via":"enable_banking","aspsp":"ABN AMRO","country":"NL","source":"abn","open_url":"https://www.abnamro.nl/en/personal/internetbanking/index.html"},
  {"id":"bunq","name":"bunq","kind":"bank","via":"enable_banking","aspsp":"bunq","country":"NL","source":"bunq","open_url":"https://bunq.com"},
  {"id":"amex","name":"American Express","kind":"card","via":"enable_banking","aspsp":"American Express","country":"NL","source":"amex","open_url":"https://www.americanexpress.com/nl-nl/","optional":true},
  {"id":"wise","name":"Wise","kind":"wallet","via":"wise_token","open_url":"https://wise.com/home","help_url":"https://wise.com/your-account/integrations-and-tools/api-tokens","help":"Wise, Your Account, Integrations and Tools, API tokens, Add new token, read only."},
  {"id":"etoro","name":"eToro","kind":"broker","via":"etoro_keys","open_url":"https://www.etoro.com/portfolio","help_url":"https://api-portal.etoro.com/getting-started","help":"eToro API portal, Settings, Trading, API Key Management, Create New Key, read only. The user key is shown once."},
  {"id":"gmail","name":"Gmail","kind":"mail","via":"google_oauth","open_url":"https://mail.google.com","help":"Read only: invoices and receipts for the expense agent."},
  {"id":"enable_banking","name":"Enable Banking","kind":"service","via":"enable_banking_app","open_url":"https://enablebanking.com/cp/applications","help_url":"https://enablebanking.com/docs/api/linked-accounts/","help":"Create a Production application, add the redirect URL shown here, then Activate by linking accounts for each bank. Paste the application ID and choose the .pem file it downloaded."}
]$json$, 'Accounts and services on the Accounts screen: how each connects (via), the bank name at Enable Banking (aspsp), which bank lines it feeds (source), and where to open it'),
('integrations.app_callback_url', 'nexuslive://connect', 'Where the browser returns to the iPhone app after a bank or Google consent'),
('integrations.enable_banking.api_base', 'https://api.enablebanking.com', 'Enable Banking API'),
('integrations.enable_banking.consent_days', '180', 'Requested consent length in days; the bank''s own maximum wins when shorter'),
('integrations.enable_banking.jwt_ttl_seconds', '3600', 'Lifetime of each signed Enable Banking request token (the API allows up to 86400)'),
('integrations.etoro.api_base', 'https://public-api.etoro.com', 'eToro public API'),
('accounts.stale_days', '7', 'An account whose newest line is older than this many days is flagged on the Accounts screen'),
('accounts.first_sync_days', '90', 'History fetched for a bank account Nexus has no lines for yet'),
('accounts.overlap_days', '5', 'Each bank sync starts this many days before the newest line Nexus has, to catch late bookings'),
('accounts.match_window_days', '3', 'A bank line matches a line already in Nexus with the same amount within this many days (export dates and API booking dates can differ)'),
('accounts.consent_warn_days', '14', 'Warn this many days before a bank consent ends'),
('accounts.balance_tolerance_eur', '1', 'Difference between the bank''s balance and the balance Nexus computes that is flagged'),
('accounts.manual_needs', $json$[
  {"code":"box3_jan_values","title":"Box 3: your balances on 1 January 2026","detail":"Savings, eToro, Wise and crypto on 1 January decide box 3. Nexus does not model box 3 yet, so the reserve leaves it out.","until":"2027-04-30"},
  {"code":"vat_q4_2026","title":"VAT return Q4 2026","detail":"File and pay by 31 January 2027.","until":"2027-01-31"},
  {"code":"wbso_2027","title":"WBSO for 2027","detail":"With 500 or more R&D hours a year the S&O deduction lowers your income tax. Apply at RVO before the period you claim starts.","until":"2027-03-31"}
]$json$, 'Items Nexus cannot check by itself, shown on the Accounts screen until their date or until dismissed'),
('cron.accounts_sync_schedule', '13 6 * * *', 'Daily refresh of connected banks, Wise and eToro (UTC)')
on conflict (key) do nothing;

-- 5. Daily refresh.
select public.schedule_from_config('nexus-accounts-sync', 'cron.accounts_sync_schedule',
  $$select public.invoke_edge('nexus/accounts')$$);
