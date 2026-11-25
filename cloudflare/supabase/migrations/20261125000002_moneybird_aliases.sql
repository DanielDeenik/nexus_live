-- Legal names on invoices that differ from the name on the card line.
insert into public.app_config (key, value, description) values
('moneybird.shop_aliases', '{"ravenpack": "bigdata", "realtimeboard": "miro", "huryn": "productcompass"}',
 'Word in a supplier''s legal name and the word its card lines carry (RavenPack bills Bigdata.com, RealtimeBoard is Miro, HURYN is The Product Compass)')
on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = now();
