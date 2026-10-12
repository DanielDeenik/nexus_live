-- Expense and tax agent configuration and schedules.

alter table public.profiles
  add column if not exists startersaftrek_eligible boolean not null default false;

insert into public.app_config (key, value, description) values
('expense_agent.categories',
  '["hardware","software_saas","telecom","office_supplies","professional_services","training","travel_business","travel_mixed","representation","club_membership","clothing","gifts","home_office","car","insurance","bank_fees","marketing","uncategorised"]',
  'Categories the expense agent may assign'),
('expense_agent.bank_match_window_days', '4', 'Days either side of a bank payment to look for its receipt'),
('cron.expense_agent_schedule', '17 5 * * *', 'Expense agent: collect and classify receipts (UTC)'),
('cron.tax_agent_schedule', '41 5 * * 1', 'Tax agent: refresh VAT and income tax drafts (UTC, Mondays)')
on conflict (key) do nothing;

select public.schedule_from_config('nexus-expense-agent', 'cron.expense_agent_schedule',
  $$select public.invoke_edge('expense-agent')$$);
select public.schedule_from_config('nexus-tax-agent', 'cron.tax_agent_schedule',
  $$select public.invoke_edge('tax-agent')$$);
