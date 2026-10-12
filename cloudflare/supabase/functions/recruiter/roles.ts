// Role monitor: the nexus job feed (workers/jobFeed.js) ported to the edge.
// Sources, keywords, recency bands, tiers and the multi-source bonus all come
// from nexus-agent-config.json in the lensiq repo. No model call.
import type { JobConfig, JobSource } from "./knowledge.ts";

export interface RoleItem {
  sourceId: string;
  title: string;
  company: string | null;
  link: string | null;
  postedAt: string | null;
  snippet: string;
  score: number;
  tier: string;
  matched: { keyword: string; pts: number; tier: string }[];
  sources: string[];
}

const get = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

export function recency(cfg: JobConfig["scoring"]["recency"], posted: string | null, now: Date): number {
  if (!posted) return cfg.noDate;
  const t = new Date(posted).getTime();
  if (!Number.isFinite(t)) return cfg.noDate;
  const days = (now.getTime() - t) / 864e5;
  for (const b of cfg.bands) if (days < b.maxDays) return b.mult;
  return cfg.older;
}

export function tierOf(score: number, s: JobConfig["scoring"]): string {
  return [...s.tiers].sort((a, b) => b.min - a.min).find((t) => score >= t.min)?.tier ?? s.tierFloor;
}

export function scoreText(text: string, jobs: JobConfig) {
  let raw = 0;
  const matched: RoleItem["matched"] = [];
  const seen = new Set<string>();
  for (const k of jobs.keywords) {
    const key = `${k.re}/${k.flags}`;
    if (seen.has(key)) continue; // the config lists a few patterns twice; count each once
    seen.add(key);
    if (new RegExp(k.re, k.flags).test(text)) {
      raw += k.pts;
      if (k.pts > 0) matched.push({ keyword: k.re, pts: k.pts, tier: k.tier });
    }
  }
  return { raw, matched };
}

export function parseRss(xml: string) {
  const tag = (block: string, name: string) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
    return m ? strip(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")) : "";
  };
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => ({
    title: tag(m[0], "title"),
    company: tag(m[0], "dc:creator") || null,
    link: tag(m[0], "link") || null,
    date: tag(m[0], "pubDate") || null,
    snippet: tag(m[0], "description"),
  }));
}

export function parseJson(body: unknown, map: Record<string, string>) {
  const listed = map.list ? get(body, map.list) : body;
  const rows = Array.isArray(listed) ? listed : [];
  const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  return rows.map((r) => ({
    title: s(get(r, map.title)),
    company: s(get(r, map.company)) || null,
    link: s(get(r, map.link)) || null,
    date: s(get(r, map.date)) || null,
    snippet: strip(s(get(r, map.snippet))),
  }));
}

export function fillUrl(src: JobSource, env: (k: string) => string | undefined): string | null {
  let url = src.url;
  for (const need of src.needs ?? []) {
    const v = env(need.toUpperCase());
    if (!v) return null; // source needs a key that is not set; skip it
    url = url.replaceAll(`{{${need}}}`, encodeURIComponent(v));
  }
  return url;
}

export function scoreItems(src: JobSource, items: ReturnType<typeof parseRss>, jobs: JobConfig, now: Date, maxAgeDays: number): RoleItem[] {
  return items
    .filter((i) => i.title)
    .filter((i) => !i.date || (now.getTime() - new Date(i.date).getTime()) / 864e5 <= maxAgeDays || !Number.isFinite(new Date(i.date).getTime()))
    .map((i) => {
      const { raw, matched } = scoreText(`${i.title} ${i.snippet}`, jobs);
      const score = Math.max(0, Math.min(jobs.scoring.scoreCap, Math.round(raw * recency(jobs.scoring.recency, i.date, now) * src.authority)));
      return {
        sourceId: src.id,
        title: i.title,
        company: src.company ?? i.company,
        link: i.link,
        postedAt: i.date && Number.isFinite(new Date(i.date).getTime()) ? new Date(i.date).toISOString() : null,
        snippet: i.snippet.slice(0, 400),
        score,
        tier: tierOf(score, jobs.scoring),
        matched,
        sources: [src.id],
      };
    })
    .filter((r) => r.score >= (src.minScore ?? 0));
}

export const dedupKey = (title: string, len: number) => title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, len);

/** Same role from several sources: keep the best, add the bonus once per extra source. */
export function dedup(items: RoleItem[], jobs: JobConfig): RoleItem[] {
  const seen = new Map<string, RoleItem>();
  for (const it of items) {
    const k = dedupKey(it.title, jobs.scoring.dedupKeyLen);
    const ex = seen.get(k);
    if (!ex) {
      seen.set(k, { ...it });
      continue;
    }
    const best = it.score > ex.score ? { ...it } : ex;
    best.sources = [...new Set([...ex.sources, ...it.sources])];
    best.score = Math.min(jobs.scoring.scoreCap, Math.max(ex.score, it.score) + jobs.scoring.multiSourceBonus);
    best.tier = tierOf(best.score, jobs.scoring);
    seen.set(k, best);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

export async function fetchSource(src: JobSource, jobs: JobConfig, now: Date, maxAgeDays: number, env: (k: string) => string | undefined): Promise<RoleItem[]> {
  const url = fillUrl(src, env);
  if (!url) return [];
  const res = await fetch(url, { headers: { accept: src.kind === "rss" ? "application/rss+xml, text/xml" : "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${src.id}: ${res.status}`);
  const items = src.kind === "rss" ? parseRss(await res.text()) : parseJson(await res.json(), src.map ?? {});
  return scoreItems(src, items, jobs, now, maxAgeDays);
}
