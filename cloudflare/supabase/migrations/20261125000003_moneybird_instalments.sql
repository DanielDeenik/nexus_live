-- Invoices paid in instalments: an insurer bills the year once and collects it monthly.
insert into public.app_config (key, value, description) values
('moneybird.instalment_period_days', '366',
 'Days after its date that a purchase invoice paid in instalments (insurance billed for the year, debited monthly) keeps proving debits of that shop'),
('moneybird.instalment_min_lines', '2',
 'Debits it takes before a purchase invoice counts as paid in instalments; one debit below the total proves nothing yet')
on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = now();
