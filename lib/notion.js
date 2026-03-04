'use strict';
/**
 * lib/notion.js — Notion SDK utilities
 * Shared across all routes: client factory, property extractor, paginated query, error translator.
 */

const { Client } = require('@notionhq/client');

/** Create a Notion client for a given integration token. */
function createClient(token) {
  return new Client({ auth: token });
}

/**
 * Extract a typed value from a Notion page property.
 * Returns null for unknown or missing properties.
 */
function prop(page, name) {
  const p = page.properties[name];
  if (!p) return null;
  switch (p.type) {
    case 'title':            return p.title.map(t => t.plain_text).join('') || null;
    case 'rich_text':        return p.rich_text.map(t => t.plain_text).join('') || null;
    case 'number':           return p.number ?? null;
    case 'select':           return p.select?.name ?? null;
    case 'multi_select':     return p.multi_select.map(s => s.name);
    case 'date':             return p.date?.start ?? null;
    case 'checkbox':         return p.checkbox;
    case 'url':              return p.url ?? null;
    case 'email':            return p.email ?? null;
    case 'phone_number':     return p.phone_number ?? null;
    case 'last_edited_time': return p.last_edited_time ?? null;
    case 'created_time':     return p.created_time ?? null;
    case 'formula':          return p.formula?.string ?? p.formula?.number ?? null;
    case 'rollup':           return p.rollup?.number ?? null;
    default:                 return null;
  }
}

/**
 * Query all pages from a Notion database, auto-paginating with cursor.
 */
async function queryAll(client, database_id, filter, sorts) {
  const results = [];
  let cursor;
  do {
    const resp = await client.databases.query({
      database_id,
      filter:       filter   ?? undefined,
      sorts:        sorts    ?? undefined,
      start_cursor: cursor   ?? undefined,
      page_size:    100,
    });
    results.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return results;
}

/**
 * Translate raw Notion API errors into clear, actionable messages.
 */
function translateError(err) {
  const msg = err?.message || String(err);
  if (msg.includes('Could not find database'))
    return `Database not found or not shared with integration. Open Notion → each database → Share → invite your integration. (${msg.slice(0, 120)})`;
  if (msg.includes('Unauthorized') || err?.code === 'unauthorized' || msg.includes('API token is invalid'))
    return 'Invalid Notion token. Check NOTION_TOKEN in your .env or workspaces.json.';
  if (msg.includes('rate_limited') || err?.status === 429)
    return 'Notion rate limit reached. The server will retry automatically — wait a few seconds.';
  if (msg.includes('validation_error'))
    return `Notion validation error — a property name or value is mismatched: ${msg.slice(0, 200)}`;
  if (msg.includes('object_not_found'))
    return `Page or database not found: ${msg.slice(0, 120)}`;
  return msg;
}

module.exports = { createClient, prop, queryAll, translateError };
