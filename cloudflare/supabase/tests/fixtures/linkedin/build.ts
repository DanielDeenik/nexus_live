// Builds synthetic LinkedIn files for the tests: a Content analytics
// workbook and a data archive zip. All people, companies and URLs are
// invented. Nothing binary is committed; the files are made on each run.
import { strToU8, zipSync } from "npm:fflate@0.8.2";

type Sheet = (string | number | null)[][];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const col = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** A minimal but valid xlsx. Strings go to the shared string table except
 *  in sheets listed in `inline`, which use inline strings, so both reader
 *  paths are exercised. Rows start at `offset[sheet]` to mimic headers that
 *  do not sit on row 1. */
export function buildXlsx(sheets: Record<string, Sheet>, opts: { inline?: string[]; offset?: Record<string, number> } = {}): Uint8Array {
  const shared: string[] = [];
  const sid = (s: string) => {
    const i = shared.indexOf(s);
    return i >= 0 ? i : shared.push(s) - 1;
  };
  const files: Record<string, Uint8Array> = {};
  const names = Object.keys(sheets);
  names.forEach((name, si) => {
    const inline = opts.inline?.includes(name);
    const off = opts.offset?.[name] ?? 0;
    const rows = sheets[name].map((row, ri) => {
      const r = ri + 1 + off;
      const cells = row.map((v, ci) => {
        if (v === null || v === "") return "";
        const ref = `${col(ci)}${r}`;
        if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
        return inline ? `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>` : `<c r="${ref}" t="s"><v>${sid(v)}</v></c>`;
      }).join("");
      return `<row r="${r}">${cells}</row>`;
    }).join("");
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    );
  });
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
    }</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
    }</Relationships>`,
  );
  files["xl/sharedStrings.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${
      shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")
    }</sst>`,
  );
  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
  return zipSync(files);
}

/** Content analytics export in the shape LinkedIn uses, with synthetic numbers. */
export function contentSheets(names = { discovery: "DISCOVERY", engagement: "ENGAGEMENT", top: "TOP POSTS", followers: "FOLLOWERS", demographics: "DEMOGRAPHICS" }): Record<string, Sheet> {
  return {
    [names.discovery]: [
      ["Overall Performance", "9/1/2026 - 9/3/2026"],
      ["Impressions", 1234],
      ["Members reached", 567],
    ],
    [names.engagement]: [
      ["Date", "Impressions", "Engagements"],
      ["9/1/2026", 100, 5],
      ["9/2/2026", 250, 20],
      ["9/3/2026", "1,000", 30],
    ],
    [names.top]: [
      ["Maximum of 50 posts available to include in this list"],
      [],
      ["Post URL", "Post publish date", "Engagements", null, "Post URL", "Post publish date", "Impressions"],
      ["https://www.linkedin.com/feed/update/urn:li:activity:1000000000000000001", "9/1/2026", 30, null, "https://www.linkedin.com/feed/update/urn:li:activity:1000000000000000002", "9/2/2026", 900],
      ["https://www.linkedin.com/feed/update/urn:li:activity:1000000000000000002", "9/2/2026", 12, null, "https://www.linkedin.com/feed/update/urn:li:activity:1000000000000000001", "9/1/2026", 400],
    ],
    [names.followers]: [
      ["Total followers on 9/3/2026:", 812],
      [],
      ["Date", "New followers"],
      ["9/1/2026", 2],
      ["9/2/2026", 0],
      ["9/3/2026", 5],
    ],
    [names.demographics]: [
      ["Top Demographics", "Value", "Percentage"],
      ["Job titles", "Business Analyst", "0.081"],
      ["Job titles", "Portfolio Manager", "5%"],
      ["Locations", "Exampletown Area", "0.32"],
      ["Industries", "Investment Management", "0.2"],
      ["Seniority", "Senior", "0.4"],
      ["Company size", "1001-5000 employees", "0.15"],
      ["Companies", "Acme Talent", "< 1%"],
    ],
  };
}

export function buildContentXlsx(): Uint8Array {
  return buildXlsx(contentSheets(), { inline: ["ENGAGEMENT"], offset: { DEMOGRAPHICS: 2 } });
}

/** Data archive: the CSV fixtures in a dated folder, as LinkedIn ships it. */
export async function buildArchiveZip(opts: { withProfile?: boolean } = {}): Promise<Uint8Array> {
  const dir = new URL("./", import.meta.url);
  const folder = "Basic_LinkedInDataExport_10-12-2026";
  const files: Record<string, Uint8Array> = {};
  const names = ["Connections.csv", "messages.csv", "Invitations.csv", ...(opts.withProfile === false ? [] : ["Profile.csv"])];
  for (const n of names) files[`${folder}/${n}`] = await Deno.readFile(new URL(n, dir));
  files[`${folder}/Rich_Media.csv`] = strToU8("Date/Time,Media Description\n");
  return zipSync(files);
}
