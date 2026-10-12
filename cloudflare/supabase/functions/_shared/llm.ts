// HTTP LLM client. Replaces the Cloudflare Workers AI binding
// (env.AI.run('@cf/meta/llama-2-7b-chat-int8', ...)) used by base-agent.
// Provider, model, temperature and max_tokens come from the agent's row in
// agent_configs; API keys come from function secrets. Nothing is hardcoded.
import { getEnv } from "./client.ts";

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
