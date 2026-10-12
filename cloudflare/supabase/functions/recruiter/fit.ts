// Weighs a job spec against Dan's skill profile. The model only reads the
// spec and maps each requirement to a profile area; the score, the verdict
// and the match decision are computed here, from the tiers in the profile,
// so the same spec always gets the same answer.
import type { AgentSettings, SkillProfile } from "./knowledge.ts";

export interface Requirement {
  text: string;
  must_have: boolean;
  area_id: string | null;
}

export interface SpecReading {
  role_title: string;
  company: string | null;
  centre_area_id: string | null;
  requirements: Requirement[];
}

export interface ScoredRequirement extends Requirement {
  area_label: string | null;
  tier: string | null;
  tier_weight: number;
  importance: number;
  line: string | null;
}

export interface Fit {
  score: number;
  verdict: string;
  isMatch: boolean;
  centre: { id: string | null; label: string; tier: string | null };
  requirements: ScoredRequirement[];
  gaps: ScoredRequirement[];
  report: string;
}

/** Tiers whose areas Dan leads with; a spec centred anywhere else is no match. */
const LEADING_TIERS = new Set(["primary", "strong"]);

export function readingTool(profile: SkillProfile) {
  return {
    name: "spec_reading",
    description: "The job spec read against Dan's skill profile areas.",
    input_schema: {
      type: "object",
      required: ["role_title", "company", "centre_area_id", "requirements"],
      properties: {
        role_title: { type: "string", description: "Role title as the spec states it" },
        company: { type: ["string", "null"], description: "Hiring company if named, otherwise null" },
        centre_area_id: {
          type: ["string", "null"],
          enum: [...profile.areas.map((a) => a.id), null],
          description: "The profile area the spec's weight sits on (its centre of gravity)",
        },
        requirements: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["text", "must_have", "area_id"],
            properties: {
              text: { type: "string", description: "One requirement, in the spec's own words" },
              must_have: { type: "boolean" },
              area_id: { type: ["string", "null"], enum: [...profile.areas.map((a) => a.id), null], description: "Closest profile area, or null if none" },
            },
          },
        },
      },
    },
  };
}

export function readingPrompt(profile: SkillProfile): string {
  const areas = profile.areas.map((a) => `- ${a.id} (${a.tier}): ${a.label}. Terms: ${a.terms.join(", ")}`).join("\n");
  return [
    "Read the job spec. List every requirement it states, in its own words, mark which are must-haves,",
    "and map each to the closest area below by meaning, not by the first matching word. If nothing fits, use null.",
    "Name the area the spec's weight actually sits on as centre_area_id.",
    "Profile areas:",
    areas,
  ].join("\n");
}

export function scoreSpec(reading: SpecReading, profile: SkillProfile, agent: AgentSettings): Fit {
  const byId = new Map(profile.areas.map((a) => [a.id, a]));
  const requirements: ScoredRequirement[] = reading.requirements.map((r) => {
    const a = r.area_id ? byId.get(r.area_id) : undefined;
    const tw = a ? profile.tiers[a.tier]?.weight ?? 0 : 0;
    return { ...r, area_id: a ? a.id : null, area_label: a?.label ?? null, tier: a?.tier ?? null, tier_weight: tw, importance: r.must_have ? 2 : 1, line: a?.line ?? null };
  });
  const total = requirements.reduce((t, r) => t + r.importance, 0);
  const covered = requirements.reduce((t, r) => t + r.importance * r.tier_weight, 0);
  const score = total > 0 ? Math.round((100 * covered) / total) : 0;
  const centreArea = reading.centre_area_id ? byId.get(reading.centre_area_id) : undefined;
  const threshold = agent.no_match_threshold ?? profile.no_match.threshold;
  const isMatch = score >= threshold && Boolean(centreArea && LEADING_TIERS.has(centreArea.tier));
  const verdict = [...profile.verdicts].sort((a, b) => b.min - a.min).find((v) => score >= v.min)?.text ?? "";
  const gaps = requirements.filter((r) => r.must_have && !(r.tier && LEADING_TIERS.has(r.tier)));
  const centreLabel = centreArea ? `${centreArea.label} (${profile.tiers[centreArea.tier]?.label ?? centreArea.tier})` : "outside Dan's profile";

  const lines = [
    `${reading.role_title}${reading.company ? ` at ${reading.company}` : ""}. The centre of gravity is ${centreLabel}.`,
    `Score ${score} out of 100: ${verdict}`,
    `Arithmetic: ${requirements.length} requirements, must-haves count double; each is weighted by its area's tier (${Object.entries(profile.tiers).map(([k, v]) => `${k} ${v.weight}`).join(", ")}). Covered ${covered.toFixed(1)} of ${total}.`,
    gaps.length
      ? `Must-haves outside his primary and strong areas: ${gaps.map((g) => `${g.text}${g.area_label ? ` (${g.area_label}, ${g.tier})` : " (not in his profile)"}`).join("; ")}.`
      : "Every must-have sits in a primary or strong area.",
    "",
    ...requirements.map((r) => `${r.must_have ? "Must" : "Nice"}: ${r.text}. ${r.area_label ? `${r.area_label}, ${r.tier}. ${r.line}` : "Not in his profile."}`),
  ];
  if (!isMatch) lines.push("", profile.no_match.headline);
  return {
    score,
    verdict,
    isMatch,
    centre: { id: centreArea?.id ?? null, label: centreLabel, tier: centreArea?.tier ?? null },
    requirements,
    gaps,
    report: lines.join("\n"),
  };
}
