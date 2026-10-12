// The tailored CV: the model returns its content as structured sections,
// this module checks every employer and date range against the master CV
// before anything is drafted, and renders a clean .docx.
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "npm:docx@9.7.2";

export interface CvRole {
  title: string;
  employer: string;
  dates: string;
  location: string | null;
  bullets: string[];
}

export interface TailoredCv {
  headline: string;
  contact: string;
  summary: string;
  competencies: string[];
  experience: CvRole[];
  certifications: string[];
  education: string[];
  languages: string[];
  skills: string[];
  cover_letter: string;
}

const list = { type: "array", items: { type: "string" } };

export const cvTool = {
  name: "tailored_cv",
  description: "The full CV rewritten for this spec, plus the cover letter.",
  input_schema: {
    type: "object",
    required: ["headline", "contact", "summary", "competencies", "experience", "certifications", "education", "languages", "skills", "cover_letter"],
    properties: {
      headline: { type: "string", description: "The line under the name, from the master CV, reordered for this spec" },
      contact: { type: "string", description: "Contact line exactly as in the master CV" },
      summary: { type: "string" },
      competencies: list,
      experience: {
        type: "array",
        items: {
          type: "object",
          required: ["title", "employer", "dates", "location", "bullets"],
          properties: {
            title: { type: "string" },
            employer: { type: "string", description: "Exactly as written in the master CV" },
            dates: { type: "string", description: "Exactly as written in the master CV, for example 01/2026 – Present" },
            location: { type: ["string", "null"] },
            bullets: list,
          },
        },
      },
      certifications: list,
      education: list,
      languages: list,
      skills: list,
      cover_letter: { type: "string", description: "180 to 280 words, four paragraphs, plain text" },
    },
  },
};

const norm = (s: string) => s.toLowerCase().replace(/[–—-]/g, "-").replace(/\s+/g, " ").trim();

/** Every role must exist in the master CV with the same employer and dates,
 *  every master role must still be there, and no forbidden characters. */
export function checkCv(cv: TailoredCv, master: string): string[] {
  const m = norm(master);
  const problems: string[] = [];
  for (const r of cv.experience) {
    if (!m.includes(norm(r.employer))) problems.push(`employer not in the master CV: ${r.employer}`);
    if (!m.includes(norm(r.dates))) problems.push(`dates not in the master CV: ${r.employer} ${r.dates}`);
  }
  const masterDates = [...master.matchAll(/\b\d{2}\/\d{4}\s*[–—-]\s*(?:\d{2}\/\d{4}|Present)\b/g)].map((x) => norm(x[0]));
  const kept = new Set(cv.experience.map((r) => norm(r.dates)));
  for (const d of new Set(masterDates)) if (!kept.has(d)) problems.push(`role dropped from the CV: ${d}`);
  const text = JSON.stringify(cv);
  if (/[—→⇒⟶]|->|=>/.test(text)) problems.push("em dash or arrow in the output");
  return problems;
}

export function cvMarkdown(cv: TailoredCv, name: string): string {
  return [
    `# ${name}`,
    cv.headline,
    cv.contact,
    "",
    "## Summary",
    cv.summary,
    "",
    "## Core competencies",
    cv.competencies.join(" | "),
    "",
    "## Experience",
    ...cv.experience.flatMap((r) => [`### ${r.title}, ${r.employer} (${r.dates})`, ...(r.location ? [`*${r.location}*`] : []), ...r.bullets.map((b) => `- ${b}`), ""]),
    "## Skills",
    cv.skills.join(" | "),
    "",
    "## Certifications",
    ...cv.certifications.map((c) => `- ${c}`),
    "",
    "## Education",
    ...cv.education.map((c) => `- ${c}`),
    "",
    "## Languages",
    cv.languages.join(", "),
  ].join("\n");
}

const P = (text: string, opts: { bold?: boolean; italics?: boolean; size?: number; after?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}) =>
  new Paragraph({
    alignment: opts.align,
    spacing: { after: opts.after ?? 80 },
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italics, size: opts.size ?? 20, font: "Calibri" })],
  });

const H = (text: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 80 }, children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 22, font: "Calibri" })] });

export async function cvDocx(cv: TailoredCv, name: string): Promise<Uint8Array> {
  const children = [
    P(name.toUpperCase(), { bold: true, size: 32, after: 40, align: AlignmentType.CENTER }),
    P(cv.headline, { size: 20, after: 40, align: AlignmentType.CENTER }),
    P(cv.contact, { size: 18, after: 160, align: AlignmentType.CENTER }),
    H("Summary"),
    P(cv.summary),
    H("Core competencies"),
    P(cv.competencies.join("  |  ")),
    H("Experience"),
    ...cv.experience.flatMap((r) => [
      P(`${r.title}, ${r.employer}`, { bold: true, after: 20 }),
      P([r.dates, r.location].filter(Boolean).join("  |  "), { italics: true, size: 18, after: 40 }),
      ...r.bullets.map((b) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: [new TextRun({ text: b, size: 20, font: "Calibri" })] })),
    ]),
    H("Skills"),
    P(cv.skills.join("  |  ")),
    H("Certifications"),
    ...cv.certifications.map((c) => P(c)),
    H("Education"),
    ...cv.education.map((c) => P(c)),
    H("Languages"),
    P(cv.languages.join(", ")),
  ];
  const doc = new Document({
    creator: name,
    title: `${name} CV`,
    sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } }, children }],
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

/** The name as the master CV's first bold line has it. */
export function masterName(master: string): string {
  const m = master.match(/\*\*([A-Z][A-Z .'-]+)\*\*/);
  if (!m) throw new Error("could not find the name line in cv_master.md");
  return m[1].trim().split(/\s+/).map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}
