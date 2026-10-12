-- Kimi K3 for the recruiter agent, and a model check.
--
-- Moonshot discontinued kimi-k2.5 on 31 Aug 2026; kimi-k3 replaced it. K3
-- always thinks, fixes its own temperature (a custom one is refused), takes
-- max_completion_tokens (thinking counts toward it) and is driven with
-- tool_choice "required". Those quirks are provider settings in
-- llm.providers, read by functions/_shared/llm.ts.

-- Provider: merge the moonshot entry, keep every other provider as it is.
insert into public.app_config (key, value, description) values
('llm.providers', '{
  "moonshot": {"kind": "openai", "key_env": "MOONSHOT_API_KEY", "base_url": "https://api.moonshot.ai/v1",
               "omit_params": ["temperature"], "max_tokens_param": "max_completion_tokens",
               "model_kwargs": {"reasoning_effort": "high"}, "tool_choice": "required"}
}', 'Model providers the LangChain layer can build; agent_configs picks provider and model per agent')
on conflict (key) do update set value = (public.app_config.value::jsonb || excluded.value::jsonb)::text;

-- Recruiter: move off the discontinued model only (a model Dan picked since stays).
insert into public.agent_configs (id, agent_id, display_name, system_prompt, llm_provider, llm_model, max_tokens, temperature, cache_ttl_seconds, rate_limit_per_day, enabled, runner)
select id, agent_id, display_name, system_prompt, llm_provider, 'kimi-k3', 32768, temperature, cache_ttl_seconds, rate_limit_per_day, enabled, runner
from public.agent_configs where agent_id = 'recruiter'
on conflict (agent_id) do update set llm_model = excluded.llm_model, max_tokens = excluded.max_tokens
where public.agent_configs.llm_model = 'kimi-k2.5';

-- The probe the model check sends (nothing is saved when it runs).
insert into public.app_config (key, value, description) values
('llm.model_check', '{
  "system": "You read short job adverts and record what they state. Use only the text given. Never use em dashes or arrow characters.",
  "text": "Contract role: SimCorp Dimension front office consultant for an asset manager. Order Manager and IBOR experience required, compliance rules a plus. Six months, remote within the EU, start in November.",
  "tool": {
    "name": "record_role",
    "description": "Record the role the advert describes.",
    "input_schema": {
      "type": "object",
      "properties": {
        "title": {"type": "string"},
        "contract": {"type": "boolean"},
        "duration_months": {"type": ["integer", "null"]},
        "remote": {"type": "boolean"},
        "must_have": {"type": "array", "items": {"type": "string"}},
        "nice_to_have": {"type": "array", "items": {"type": "string"}}
      },
      "required": ["title", "contract", "duration_months", "remote", "must_have", "nice_to_have"]
    }
  }
}', 'Probe for the model check (nexus/models): one structured call per agent, nothing saved')
on conflict (key) do nothing;
