/**
 * CSV / NDJSON from JSON responses, by the same rules as the API's `output=csv|ndjson`. Used with --all-pages,
 * where the pages are read as JSON (to follow the next-page field) and joined here.
 *
 * Records are the response's main list (the preferred or biggest top-level array of objects); a response
 * without one becomes one row. Nested objects become dot.paths; lists of plain values are joined with "|".
 */
const META = new Set(["success", "cached", "fetched_at", "credits_used", "raw", "request_id"]);
const LIST_KEYS = ["results", "items", "products", "listings", "posts", "videos", "reviews", "comments", "jobs", "ads", "users", "profiles", "places", "hotels", "flights", "properties", "homes", "events", "entries", "books", "apps", "pins", "reels", "tracks", "repositories", "followers", "following", "follows", "replies", "segments", "companies", "creators", "locations", "links"];
const MAX_LIST_FIELDS = 17;

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

export function records(data, pick) {
  const rows = (v) => v.map((x) => (isObj(x) ? x : { value: x }));
  if (Array.isArray(data)) return rows(data);
  if (!isObj(data)) return [{ value: data }];
  const whole = () => [Object.fromEntries(Object.entries(data).filter(([k]) => !META.has(k)))];
  if (pick === ".") return whole();
  if (pick && Array.isArray(data[pick])) return rows(data[pick]);
  const lists = [];
  let fields = 0;
  for (const [k, v] of Object.entries(data)) {
    if (META.has(k)) continue;
    if (Array.isArray(v) && v.length && v.some(isObj)) lists.push([k, v]);
    else fields++;
  }
  if (!lists.length || fields > MAX_LIST_FIELDS) return whole();
  const rank = (k) => { const i = LIST_KEYS.indexOf(k); return i < 0 ? LIST_KEYS.length : i; };
  lists.sort((a, b) => rank(a[0]) - rank(b[0]) || b[1].length - a[1].length);
  return rows(lists[0][1]);
}

function flatten(o, prefix = "", depth = 0, out = {}) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) out[key] = "";
    else if (isObj(v) && depth < 3) flatten(v, key, depth + 1, out);
    else if (Array.isArray(v)) out[key] = v.every((x) => x === null || typeof x !== "object") ? v.map((x) => (x === null ? "" : String(x))).join("|") : JSON.stringify(v);
    else if (typeof v === "object") out[key] = JSON.stringify(v);
    else out[key] = String(v);
  }
  return out;
}

function cell(s) {
  // a leading = + - @ would run as a spreadsheet formula: made literal
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows) {
  const flat = rows.map((r) => flatten(r));
  const cols = [];
  const seen = new Set();
  for (const r of flat) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const lines = [cols.map(cell).join(",")];
  for (const r of flat) lines.push(cols.map((c) => cell(r[c] ?? "")).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function toNdjson(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}
