// LLM access. Agents call models through LangChain (structured calls below);
// callLLM is the plain chat path kept for the legacy swarm runner.
// Provider, model, temperature and max_tokens come from the agent's row in
// agent_configs; API keys come from function secrets. Nothing is hardcoded.
import { getEnv } from "./client.ts";
import { ChatAnthropic } from "npm:@langchain/anthropic@1.5.11";
import { ChatOpenAI } from "npm:@langchain/openai@1.5.13";
import type { BaseChatModel } from "npm:@langchain/core@1.2.12/language_models/chat_models";
import { HumanMessage, SystemMessage } from "npm:@langchain/core@1.2.12/messages";

export interface LlmParams {
  provider: string; // 'anthropic' | 'gemini'
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function callLLM(params: LlmParams, messages: ChatMessage[]): Promise<string> {
  switch (params.provider) {
    case "anthropic":
      return await callAnthropic(params, messages);
    case "gemini":
      return await callGemini(params, messages);
    default:
      throw new Error(`Unsupported LLM provider: ${params.provider}`);
  }
}

async function callAnthropic(params: LlmParams, messages: ChatMessage[]): Promise<string> {
  const apiKey = getEnv("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      ...(system ? { system } : {}),
      messages: turns,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.content ?? []).map((b: { text?: string }) => b.text ?? "").join("");
}

async function callGemini(params: LlmParams, messages: ChatMessage[]): Promise<string> {
  const apiKey = getEnv("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${params.model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: { temperature: params.temperature, maxOutputTokens: params.maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Gemini call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
}

// ---------------------------------------------------------------------------
// Structured output through LangChain (expense, tax and recruiter agents).
// The provider table lives in app_config `llm.providers`, so a model swap
// per agent is a row change in agent_configs, not a code change:
//   { "<provider>": { "kind": "anthropic" | "openai", "key_env": "...", "base_url"?: "...",
//                     "omit_params"?: ["temperature"], "max_tokens_param"?: "max_completion_tokens",
//                     "model_kwargs"?: {...}, "tool_choice"?: "required" } }
// "openai" covers every OpenAI-compatible endpoint (Moonshot Kimi, DeepSeek).
// omit_params drops settings a model fixes itself (Kimi K3 rejects a custom
// temperature); tool_choice "required" is for endpoints that refuse a named
// forced tool (thinking models), with the single tool's arguments read back.
// The model must return arguments matching the JSON schema (forced tool call);
// callers still validate the result deterministically.
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface StructuredResult<T> {
  value: T;
  usage: { input_tokens: number; output_tokens: number };
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** What an agent graph needs from a model: one structured call. Injected so
 *  graphs can be tested with a scripted stand-in. */
export type Structured = <T>(system: string, content: ContentBlock[], tool: ToolSpec) => Promise<StructuredResult<T>>;

interface ProviderSpec {
  kind: "anthropic" | "openai";
  key_env: string;
  base_url?: string;
  omit_params?: string[];
  max_tokens_param?: string;
  model_kwargs?: Record<string, unknown>;
  tool_choice?: "required";
}

let providerCache: Record<string, ProviderSpec> | null = null;

async function providers(): Promise<Record<string, ProviderSpec>> {
  if (providerCache) return providerCache;
  const { adminClient } = await import("./client.ts");
  const { data, error } = await adminClient().from("app_config").select("value").eq("key", "llm.providers").maybeSingle();
  if (error || !data) throw new Error("app_config llm.providers is missing");
  providerCache = JSON.parse(data.value as string) as Record<string, ProviderSpec>;
  return providerCache;
}

export async function chatModel(params: LlmParams): Promise<BaseChatModel> {
  const spec = (await providers())[params.provider];
  if (!spec) throw new Error(`No provider '${params.provider}' in app_config llm.providers`);
  const apiKey = getEnv(spec.key_env);
  if (!apiKey) throw new Error(`${spec.key_env} not set`);
  if (spec.kind === "anthropic") {
    return new ChatAnthropic({ model: params.model, apiKey, maxTokens: params.maxTokens, temperature: params.temperature });
  }
  const omit = new Set(spec.omit_params ?? []);
  const kwargs: Record<string, unknown> = { ...(spec.model_kwargs ?? {}) };
  if (spec.max_tokens_param) kwargs[spec.max_tokens_param] = params.maxTokens;
  return new ChatOpenAI({
    model: params.model,
    apiKey,
    maxTokens: spec.max_tokens_param ? undefined : params.maxTokens,
    temperature: omit.has("temperature") ? undefined : params.temperature,
    modelKwargs: Object.keys(kwargs).length ? kwargs : undefined,
    configuration: spec.base_url ? { baseURL: spec.base_url } : undefined,
  });
}

function toMessageContent(kind: ProviderSpec["kind"], content: ContentBlock[]) {
  if (kind === "anthropic") return content as unknown as Record<string, unknown>[];
  return content.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image") return { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
    throw new Error("PDF documents need an Anthropic model; set this agent's provider to anthropic in agent_configs");
  });
}

export async function callStructured<T>(
  params: LlmParams,
  system: string,
  content: ContentBlock[],
  tool: ToolSpec,
): Promise<StructuredResult<T>> {
  const spec = (await providers())[params.provider];
  if (!spec) throw new Error(`No provider '${params.provider}' in app_config llm.providers`);
  const model = await chatModel(params);
  const messages = [
    new SystemMessage(system),
    new HumanMessage({ content: toMessageContent(spec.kind, content) as never }),
  ];
  if (spec.tool_choice === "required") {
    // One tool, any call required: its arguments are the structured result.
    const bound = (model as unknown as { bindTools: (t: unknown[], o: unknown) => { invoke: (m: unknown) => Promise<unknown> } })
      .bindTools([{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }], { tool_choice: "required" });
    const msg = await bound.invoke(messages) as { tool_calls?: { name: string; args: unknown }[]; usage_metadata?: { input_tokens?: number; output_tokens?: number } };
    const call = msg.tool_calls?.find((c) => c.name === tool.name) ?? msg.tool_calls?.[0];
    if (!call) throw new Error("Model returned no structured result");
    const u = msg.usage_metadata ?? {};
    return { value: call.args as T, usage: { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 } };
  }
  const runnable = model.withStructuredOutput(
    { ...tool.input_schema, title: tool.name, description: tool.description } as Record<string, unknown>,
    { name: tool.name, method: "functionCalling", includeRaw: true },
  );
  const out = await runnable.invoke(messages);
  if (!out.parsed) throw new Error("Model returned no structured result");
  const u = (out.raw as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata ?? {};
  return { value: out.parsed as T, usage: { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 } };
}

/** Binds one agent's model settings into the Structured shape graphs use. */
export function structuredFor(params: LlmParams): Structured {
  return <T>(system: string, content: ContentBlock[], tool: ToolSpec) => callStructured<T>(params, system, content, tool);
}
