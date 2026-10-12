// Gmail and Calendar calls the recruiter agent makes. It reads mail, writes
// drafts and creates invitations; it has no send scope, so nothing reaches a
// recruiter until Dan presses Send in Gmail. Endpoints come from app_config.
import type { AppConfig } from "./config.ts";

export interface GmailMessage {
  id: string;
  receivedAt: string;
  subject: string;
  from: string;
  text: string;
}

interface Part { mimeType?: string; filename?: string; body?: { data?: string }; parts?: Part[] }

function walk(p: Part, out: Part[] = []): Part[] {
  out.push(p);
  for (const c of p.parts ?? []) walk(c, out);
  return out;
}

const fromB64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const b64url = (bytes: Uint8Array) => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function ok(res: Response, what: string) {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export class Google {
  constructor(private readonly token: string, private readonly cfg: AppConfig) {}

  private get h() {
    return { Authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }
  private get gmail() {
    return this.cfg["integrations.gmail_api_base"];
  }
  private get calendar() {
    return this.cfg["integrations.calendar_api_base"];
  }

  async searchIds(q: string, max: number): Promise<string[]> {
    const r = await ok(await fetch(`${this.gmail}/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`, { headers: this.h }), "Gmail search");
    return ((r.messages ?? []) as { id: string }[]).map((m) => m.id);
  }

  async subjects(q: string, max: number): Promise<string[]> {
    const out: string[] = [];
    for (const id of await this.searchIds(q, max)) {
      const m = await ok(await fetch(`${this.gmail}/users/me/messages/${id}?format=metadata&metadataHeaders=Subject`, { headers: this.h }), "Gmail read");
      out.push(((m.payload?.headers ?? []) as { name: string; value: string }[]).find((x) => x.name.toLowerCase() === "subject")?.value ?? "");
    }
    return out;
  }

  async message(id: string): Promise<GmailMessage> {
    const m = await ok(await fetch(`${this.gmail}/users/me/messages/${id}?format=full`, { headers: this.h }), "Gmail read");
    const headers: { name: string; value: string }[] = m.payload?.headers ?? [];
    const hv = (n: string) => headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    const parts = walk(m.payload ?? {});
    const text = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
    const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
    const body = text ? fromB64url(text.body!.data!) : html ? fromB64url(html.body!.data!).replace(/<[^>]+>/g, " ") : "";
    return { id, receivedAt: new Date(Number(m.internalDate)).toISOString(), subject: hv("subject"), from: hv("from"), text: body };
  }

  /** Creates a Gmail draft; returns its id. The raw MIME comes from mime(). */
  async createDraft(raw: Uint8Array): Promise<string> {
    const r = await ok(await fetch(`${this.gmail}/users/me/drafts`, { method: "POST", headers: this.h, body: JSON.stringify({ message: { raw: b64url(raw) } }) }), "Gmail draft");
    return r.id as string;
  }

  async findDraft(to: string, subject: string): Promise<string | null> {
    const ids = await this.searchIds(`in:draft to:${to} subject:"${subject.replace(/"/g, "")}"`, 5);
    if (!ids.length) return null;
    const r = await ok(await fetch(`${this.gmail}/users/me/drafts?maxResults=50`, { headers: this.h }), "Gmail drafts");
    const d = ((r.drafts ?? []) as { id: string; message: { id: string } }[]).find((x) => ids.includes(x.message.id));
    return d?.id ?? null;
  }

  async calendars(): Promise<{ id: string; summary: string; primary?: boolean }[]> {
    const r = await ok(await fetch(`${this.calendar}/users/me/calendarList?minAccessRole=writer`, { headers: this.h }), "Calendar list");
    return r.items ?? [];
  }

  async busy(ids: string[], from: Date, to: Date): Promise<{ start: string; end: string }[]> {
    const r = await ok(await fetch(`${this.calendar}/freeBusy`, {
      method: "POST",
      headers: this.h,
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: ids.map((id) => ({ id })) }),
    }), "Calendar free/busy");
    return Object.values(r.calendars ?? {}).flatMap((c) => ((c as { busy?: { start: string; end: string }[] }).busy ?? []));
  }

  async eventWithRef(calendarId: string, ref: string, from: Date, to: Date): Promise<string | null> {
    const q = new URLSearchParams({ q: ref, timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true" });
    const r = await ok(await fetch(`${this.calendar}/calendars/${encodeURIComponent(calendarId)}/events?${q}`, { headers: this.h }), "Calendar search");
    return (r.items?.[0]?.id as string | undefined) ?? null;
  }

  async createEvent(calendarId: string, e: { summary: string; description: string; start: Date; end: Date; timeZone: string; attendees: string[]; requestId: string }): Promise<string> {
    const body = {
      summary: e.summary,
      description: e.description,
      start: { dateTime: e.start.toISOString(), timeZone: e.timeZone },
      end: { dateTime: e.end.toISOString(), timeZone: e.timeZone },
      attendees: e.attendees.map((email) => ({ email, responseStatus: "needsAction" })),
      conferenceData: { createRequest: { requestId: e.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
    };
    const r = await ok(await fetch(`${this.calendar}/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`, {
      method: "POST",
      headers: this.h,
      body: JSON.stringify(body),
    }), "Calendar invite");
    return r.id as string;
  }
}

const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${toB64(new TextEncoder().encode(s))}?=`);
const wrap76 = (s: string) => s.replace(/(.{76})/g, "$1\r\n");

/** A plain text email, optionally with one attachment, as RFC 822 bytes. */
export function mime(m: { to: string; subject: string; text: string; attachment?: { name: string; type: string; bytes: Uint8Array } }): Uint8Array {
  const head = [`To: ${m.to}`, `Subject: ${encodeHeader(m.subject)}`, "MIME-Version: 1.0"];
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(toB64(new TextEncoder().encode(m.text)))];
  if (!m.attachment) return new TextEncoder().encode([...head, ...textPart].join("\r\n"));
  const boundary = `nexus_${crypto.randomUUID().replace(/-/g, "")}`;
  const lines = [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textPart,
    `--${boundary}`,
    `Content-Type: ${m.attachment.type}; name="${encodeHeader(m.attachment.name)}"`,
    `Content-Disposition: attachment; filename="${encodeHeader(m.attachment.name)}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(toB64(m.attachment.bytes)),
    `--${boundary}--`,
    "",
  ];
  return new TextEncoder().encode(lines.join("\r\n"));
}
