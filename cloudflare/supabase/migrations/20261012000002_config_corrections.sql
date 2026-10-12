-- Corrections to the foundation seed. Kept separate because they are UPDATEs,
-- which the Supabase connector cannot apply without an interactive
-- confirmation: run this file once in the Supabase SQL editor.

-- 2025 value had been seeded as the 2026 zelfstandigenaftrek. The fiscal engine
-- reads tax_parameters, so this only keeps the legacy key honest.
update public.app_config set value = '1200',
  description = 'Superseded by tax_parameters(2026, ib.zelfstandigenaftrek)', updated_at = now()
where key = 'tax.nl.zelfstandigenaftrek';

-- The swarm tax agent carried hardcoded (and wrong) 2026 figures in its prompt.
update public.agent_configs set system_prompt =
'You are the Tax Compliance Agent for a Dutch IB-ondernemer (eenmanszaak). Every rate, bracket, deduction and threshold you use comes from the fiscal parameters supplied in your context (public.tax_parameters, by year, with sources); never state a fiscal number from memory. If a parameter you need is missing or marked unverified, say so instead of guessing. You are conservative and compliance-first, you flag risks even when unlikely, you separate legal planning from aggressive positions, and you never present an estimate as a filed figure: filings are prepared by the tax drafter and approved by the owner.',
  updated_at = now()
where agent_id = 'tax';

-- B2B services to non-EU businesses are not reported (tax_parameters
-- vat.not_reported_treatments, source ondernemersplein.overheid.nl), so the
-- rubriek map no longer carries that treatment. The purchase boxes 4a/4b follow
-- the Belastingdienst return layout; verify once and mark the map verified.
update public.tax_parameters
set value = '{"nl_standard":"1a","nl_reduced":"1b","eu_reverse_charge":"3b","purchases_services_outside_eu":"4a","purchases_eu":"4b"}',
    verified = true, updated_at = now(),
    description = 'Mapping of transaction treatments to VAT return boxes (verified by owner)'
where year = 2026 and key = 'vat.rubriek_map';
