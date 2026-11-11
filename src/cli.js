import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Apish, ApishError } from "@api.sh/sdk";
import { Catalog, paginationRule, tail } from "./catalog.js";
import { cacheDir, removeKey, resolveKey, saveKey } from "./config.js";
import { records, toCsv, toNdjson } from "./format.js";

const VERSION = createRequire(import.meta.url)("../package.json").version;

/** Exit codes (also in the README). */
export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, CREDITS: 4, NOT_FOUND: 5, SOURCE: 6, NETWORK: 7 };

const KEYS_URL = "https://app.api.sh/keys";
/** Query parameters every endpoint takes (on top of its own). */
const COMMON = new Set(["raw", "fields", "fresh", "output", "records", "format"]);
/** The CLI's own flags. Everything else is sent to the endpoint. */
const OWN = new Set(["help", "out", "all-pages", "page-limit", "api-key", "quiet", "output"]);
const DEFAULT_PAGE_LIMIT = 100;

class UsageError extends Error {
  constructor(message, code = EXIT.USAGE) { super(message); this.code = code; }
}

/**
 * Parses argv into positionals and flags. `--a b`, `--a=b`, `--flag` (true), `--no-flag` (false), `-o csv`,
 * `-q`, `-h`, and `--` (everything after it is positional). Repeated flags keep the last value.
 */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  const shorts = { o: "output", q: "quiet", h: "help", v: "version" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positionals.push(...argv.slice(i + 1)); break; }
    let name; let value;
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) value = a.slice(eq + 1);
    } else if (/^-[a-z]$/i.test(a) && shorts[a[1]]) {
      name = shorts[a[1]];
    } else {
      positionals.push(a);
      continue;
    }
    if (value === undefined) {
      const next = argv[i + 1];
      const takesNoValue = name === "help" || name === "quiet" || name === "all-pages" || name.startsWith("no-");
      if (!takesNoValue && next !== undefined && !next.startsWith("--") && !/^-[a-z]$/i.test(next)) { value = next; i++; }
      else if (name.startsWith("no-")) { name = name.slice(3); value = false; }
      else value = true;
    }
    flags[name] = value;
  }
  return { positionals, flags };
}

/**
 * Runs the CLI. Returns the exit code. `io` lets tests swap the environment, streams and fetch.
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const say = (s) => err.write(s + "\n");
  const { positionals, flags } = parseArgs(argv);
  const catalog = new Catalog({
    apiBase: env.APISH_BASE_URL || "https://api.api.sh",
    siteBase: env.APISH_SITE_URL || "https://api.sh",
    cacheDir: cacheDir(env),
    fetch: io.fetch ?? globalThis.fetch,
  });
  const ctx = { env, out, err, say, flags, catalog, io };
  try {
    const [cmd, ...rest] = positionals;
    if (!cmd) {
      if (flags.version === true) { out.write(VERSION + "\n"); return EXIT.OK; }
      out.write(generalHelp());
      return flags.help ? EXIT.OK : EXIT.USAGE;
    }
    switch (cmd) {
      case "help": return await help(ctx, rest);
      case "version": out.write(VERSION + "\n"); return EXIT.OK;
      case "login": return await login(ctx);
      case "logout": return await logout(ctx);
      case "search": return await searchCmd(ctx, rest);
      case "list": return await listCmd(ctx, rest);
      case "call": return await callCmd(ctx, rest);
      default: return await platformCmd(ctx, cmd, rest);
    }
  } catch (e) {
    return report(e, ctx);
  }
}

// ---------------------------------------------------------------- commands

async function help(ctx, rest) {
  if (!rest.length) { ctx.out.write(generalHelp()); return EXIT.OK; }
  ctx.flags.help = true;
  return platformCmd(ctx, rest[0], rest.slice(1));
}

async function searchCmd(ctx, words) {
  if (ctx.flags.help) { ctx.out.write(SEARCH_HELP); return EXIT.OK; }
  const query = words.join(" ").trim();
  if (!query) throw new UsageError("search needs words, e.g. apish search tiktok comments");
  const limit = Math.max(1, Math.min(200, Number(ctx.flags.limit) || 20));
  const hits = await ctx.catalog.search(query, limit);
  if (ctx.flags.output === "json") { ctx.out.write(JSON.stringify(hits, null, 2) + "\n"); return EXIT.OK; }
  if (!hits.length) { ctx.say(`No endpoints match "${query}". Try fewer or other words, or apish list.`); return EXIT.NOT_FOUND; }
  ctx.out.write(table(hits.map((h) => [command(h.route), h.name, credits(h.credits)])));
  ctx.say(`\nDetails: apish ${command(hits[0].route)} --help`);
  return EXIT.OK;
}

async function listCmd(ctx, rest) {
  if (ctx.flags.help) { ctx.out.write(LIST_HELP); return EXIT.OK; }
  const cat = await ctx.catalog.load();
  const json = ctx.flags.output === "json";
  if (!rest.length) {
    const rows = [...cat.platforms].sort((a, b) => a.slug.localeCompare(b.slug));
    if (json) { ctx.out.write(JSON.stringify(rows.map(({ slug, name, category, endpoints }) => ({ slug, name, category, endpoints: endpoints.length })), null, 2) + "\n"); return EXIT.OK; }
    ctx.out.write(table(rows.map((p) => [p.slug, p.name, p.category || "", `${p.endpoints.length} endpoint${p.endpoints.length === 1 ? "" : "s"}`])));
    ctx.say(`\n${cat.platform_count} platforms, ${cat.endpoint_count} endpoints. Endpoints of one: apish list <platform>`);
    return EXIT.OK;
  }
  const p = await requirePlatform(ctx, rest[0]);
  if (json) { ctx.out.write(JSON.stringify(p.endpoints, null, 2) + "\n"); return EXIT.OK; }
  ctx.out.write(table(p.endpoints.map((e) => [command(e.route), e.name, credits(e.credits)])));
  return EXIT.OK;
}

async function platformCmd(ctx, name, words) {
  const p = await requirePlatform(ctx, name);
  if (!words.length) {
    ctx.out.write(platformHelp(p));
    return ctx.flags.help ? EXIT.OK : EXIT.USAGE;
  }
  const e = ctx.catalog.endpoint(p, words);
  if (!e) throw new UsageError(`${p.name} has no endpoint "${words.join(" ")}". Its endpoints:\n${table(p.endpoints.map((x) => [command(x.route), x.name]))}`, EXIT.NOT_FOUND);
  const info = await ctx.catalog.params(e.route);
  if (ctx.flags.help) { ctx.out.write(endpointHelp(p, e, info)); return EXIT.OK; }
  const params = endpointParams(ctx.flags, info, e.route);
  return run(ctx, e.route, params, info);
}

async function callCmd(ctx, rest) {
  if (ctx.flags.help || !rest.length) { ctx.out.write(CALL_HELP); return ctx.flags.help ? EXIT.OK : EXIT.USAGE; }
  let [route, ...pairs] = rest;
  if (/^https?:\/\//.test(route)) {
    const u = new URL(route);
    route = u.pathname;
    for (const [k, v] of u.searchParams) pairs.unshift(`${k}=${v}`);
  }
  if (!route.startsWith("/")) route = "/" + route;
  const params = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new UsageError(`expected name=value, got "${pair}"`);
    params[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  Object.assign(params, flagParams(ctx.flags));
  const info = ctx.flags["all-pages"] ? await ctx.catalog.params(route) : null;
  return run(ctx, route, params, info);
}

async function login(ctx) {
  if (ctx.flags.help) { ctx.out.write(LOGIN_HELP); return EXIT.OK; }
  let key = typeof ctx.flags["api-key"] === "string" ? ctx.flags["api-key"] : "";
  const stdin = ctx.io.stdin ?? process.stdin;
  if (!key) key = stdin.isTTY ? await promptHidden(`API key (${KEYS_URL}): `, stdin, ctx.err) : await readAll(stdin);
  key = key.trim();
  if (!key) throw new UsageError(`no key given. Create one at ${KEYS_URL}`);
  const client = new Apish({ apiKey: key, baseUrl: ctx.catalog.apiBase, fetch: ctx.io.fetch, maxRetries: 1 });
  await client.account.get(); // free: checks the key
  const file = await saveKey(key, ctx.env);
  ctx.say(`Logged in. Key saved to ${file}`);
  if (ctx.env.APISH_API_KEY) ctx.say("Note: APISH_API_KEY is set in this shell and takes precedence over the saved key.");
  return EXIT.OK;
}

async function logout(ctx) {
  const removed = await removeKey(ctx.env);
  ctx.say(removed ? "Logged out. The saved key was removed." : "No saved key.");
  return EXIT.OK;
}

// ---------------------------------------------------------------- calling

async function run(ctx, route, params, info) {
  const { key } = await resolveKey(typeof ctx.flags["api-key"] === "string" ? ctx.flags["api-key"] : "", ctx.env);
  if (!key) throw new UsageError(`no API key. Run apish login, or set APISH_API_KEY (create a key at ${KEYS_URL})`, EXIT.AUTH);
  const output = String(ctx.flags.output || params.output || "json");
  if (!["json", "csv", "ndjson"].includes(output)) throw new UsageError(`--output must be json, csv or ndjson (got ${output})`);
  delete params.output;
  const client = new Apish({ apiKey: key, baseUrl: ctx.catalog.apiBase, fetch: ctx.io.fetch });

  let body;
  let used = 0;
  let left = null;
  const ids = [];
  if (ctx.flags["all-pages"]) {
    const rule = paginationRule(route, info?.params || []);
    if (!rule) throw new UsageError(`${route} has no pages to follow (drop --all-pages)`);
    const limit = Number(ctx.flags["page-limit"]) || DEFAULT_PAGE_LIMIT;
    const pages = [];
    let p = { ...params };
    for (let n = 0; n < limit; n++) {
      const page = await client.call(route, p);
      pages.push(page);
      used += page.$meta.creditsUsed;
      left = page.$meta.creditsRemaining;
      ids.push(page.$meta.requestId);
      if (!ctx.flags.quiet && ctx.err.isTTY) ctx.err.write(`\rpage ${n + 1}…`);
      const next = page[rule.from];
      if (next === undefined || next === null || next === "" || next === false) break;
      if (n === limit - 1) ctx.say(`\nStopped after ${limit} pages (--page-limit). More pages exist.`);
      p = { ...p, [rule.to]: next };
    }
    if (!ctx.flags.quiet && ctx.err.isTTY) ctx.err.write("\r");
    const pick = typeof params.records === "string" ? params.records : undefined;
    if (output === "json") body = JSON.stringify(pages, null, 2) + "\n";
    else {
      const rows = pages.flatMap((pg) => records(pg, pick));
      body = output === "csv" ? toCsv(rows) : toNdjson(rows);
    }
  } else {
    const res = await client.call(route, params, { output });
    used = res.$meta.creditsUsed;
    left = res.$meta.creditsRemaining;
    ids.push(res.$meta.requestId);
    body = output === "json" ? JSON.stringify(res, null, 2) + "\n" : String(res);
  }

  if (typeof ctx.flags.out === "string") {
    await writeFile(ctx.flags.out, body);
    if (!ctx.flags.quiet) ctx.say(`Wrote ${ctx.flags.out}`);
  } else {
    ctx.out.write(body);
  }
  if (!ctx.flags.quiet) {
    const parts = [`${used} credit${used === 1 ? "" : "s"} used`];
    if (left !== null && left !== undefined) parts.push(`${left} left`);
    if (ids.length === 1 && ids[0]) parts.push(`request ${ids[0]}`);
    if (ids.length > 1) parts.push(`${ids.length} pages`);
    ctx.say(parts.join(" · "));
  }
  return EXIT.OK;
}

/** Endpoint flags -> query parameters, checked against the endpoint's parameter list. */
export function endpointParams(flags, info, route) {
  const raw = flagParams(flags);
  if (!info) return raw;
  const known = new Map(info.params.map((p) => [p.name, p]));
  const out = {};
  for (const [flag, value] of Object.entries(raw)) {
    const name = known.has(flag) ? flag : known.has(flag.replace(/-/g, "_")) ? flag.replace(/-/g, "_") : COMMON.has(flag) ? flag : null;
    if (!name) {
      const close = closest(flag.replace(/-/g, "_"), info.params.map((p) => p.name));
      const hint = close ? ` Did you mean --${close}?` : info.params.length ? ` See apish ${command(route)} --help` : "";
      throw new UsageError(`unknown parameter --${flag} for ${route}.${hint}\nTo send it anyway: apish call ${route} ${flag}=...`);
    }
    const p = known.get(name);
    out[name] = value === true && p?.type !== "boolean" && name !== "fresh" ? missingValue(name) : value;
  }
  // required parameters are left to the API: some have alternatives (video_id or url), and a 400 is free
  return out;
}

/** The nearest name by edit distance, if it is near enough to be a typo. */
function closest(word, names) {
  let best = null;
  let bestD = Infinity;
  for (const n of names) {
    const d = distance(word, n);
    if (d < bestD) { best = n; bestD = d; }
  }
  return bestD <= Math.max(2, Math.floor(word.length / 4)) ? best : null;
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function missingValue(name) {
  throw new UsageError(`--${name} needs a value`);
}

function flagParams(flags) {
  const out = {};
  for (const [k, v] of Object.entries(flags)) {
    if (OWN.has(k)) continue;
    if (k === "fresh" && v === true) out.fresh = "1";
    else if (k === "raw" && typeof v === "boolean") out.raw = v ? "1" : "0";
    else out[k] = v === true ? true : v === false ? "false" : v;
  }
  return out;
}

// ---------------------------------------------------------------- errors

function report(e, ctx) {
  const say = ctx.say;
  if (e instanceof UsageError) { say(`error: ${e.message}`); return e.code; }
  if (e instanceof ApishError) {
    const id = e.requestId ? `, request ${e.requestId}` : "";
    say(`error: ${e.message} (HTTP ${e.status}${id})`);
    if (e.status === 401 || e.status === 403) { say(`Check your key: apish login, or set APISH_API_KEY. Keys: ${KEYS_URL}`); return EXIT.AUTH; }
    if (e.status === 402) {
      say(e.spendLimit ? `Your ${e.spendLimit} spend limit was reached. Change it at https://app.api.sh` : "Not enough credits for this call. Add credits at https://app.api.sh");
      return EXIT.CREDITS;
    }
    if (e.status === 404) return EXIT.NOT_FOUND;
    if (e.status === 400 || e.status === 422) return EXIT.USAGE;
    if (e.retryable) { say("The source site did not answer in time. Failed calls are free: try again in a minute. Status: https://status.api.sh"); return EXIT.SOURCE; }
    return EXIT.ERROR;
  }
  if (e && (e.name === "TypeError" || e.name === "AbortError" || /fetch failed|no answer in|ECONN|ENOTFOUND|ETIMEDOUT/i.test(String(e.message) + String(e.cause?.code)))) {
    say(`error: could not reach api.sh (${e.cause?.code || e.message}). Check your connection.`);
    return EXIT.NETWORK;
  }
  say(`error: ${e?.message || e}`);
  return EXIT.ERROR;
}

async function requirePlatform(ctx, name) {
  const p = await ctx.catalog.platform(name);
  if (p) return p;
  const hits = await ctx.catalog.search(name, 5);
  const also = hits.length ? `\nDid you mean:\n${table(hits.map((h) => [command(h.route), h.name]))}` : "";
  throw new UsageError(`unknown command or platform "${name}". Find endpoints with apish search <words>.${also}`, EXIT.NOT_FOUND);
}

// ---------------------------------------------------------------- help text

const command = (route) => `${route.split("/").filter(Boolean)[0]} ${tail(route).replace(/\//g, " ")}`;
const credits = (n) => (n === undefined ? "" : `${n} credit${n === 1 ? "" : "s"}`);

function table(rows) {
  if (!rows.length) return "";
  const widths = rows[0].map((_, i) => Math.min(48, Math.max(...rows.map((r) => String(r[i] ?? "").length))));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c ?? "") : String(c ?? "").padEnd(widths[i]))).join("  ").trimEnd()).join("\n") + "\n";
}

function platformHelp(p) {
  return `${p.name}${p.category ? ` (${p.category})` : ""}

Usage: apish ${p.slug} <endpoint> [--param value ...] [options]

Endpoints:
${table(p.endpoints.map((e) => ["  " + tail(e.route).replace(/\//g, " "), e.name, credits(e.credits)]))}
Parameters of one: apish ${p.slug} <endpoint> --help
Docs: https://api.sh/${p.slug}-api
`;
}

function endpointHelp(p, e, info) {
  const rule = paginationRule(e.route, info?.params || []);
  const lines = [`${e.name} · ${credits(e.credits ?? info?.credits)} per successful call (failed calls are free)`, ""];
  const about = (info?.description || "").replace(/\s*Every response includes[\s\S]*$/, "").trim();
  if (about) lines.push(wrap(about), "");
  lines.push(`Usage: apish ${command(e.route)} [--param value ...] [options]`, `Route: GET ${e.route}`, "", "Parameters:");
  for (const prm of info?.params || []) {
    const kind = prm.enum ? prm.enum.join("|") : prm.type;
    const extra = [prm.required ? "required" : "", prm.example ? `e.g. ${prm.example}` : ""].filter(Boolean).join(", ");
    lines.push(`  --${prm.name} <${kind}>${extra ? `  (${extra})` : ""}`);
    if (prm.description) lines.push(wrap(prm.description, "      "));
  }
  if (!info?.params?.length) lines.push("  (none)");
  lines.push("", OPTIONS_HELP.trimEnd());
  if (rule) lines.push(`  --all-pages            follow ${rule.from} until the last page (one call per page)`, "  --page-limit <n>       stop after n pages (default 100)");
  lines.push("", `Docs: https://api.sh/${p.slug}-api`);
  return lines.join("\n") + "\n";
}

function wrap(text, indent = "", width = 100) {
  const out = [];
  let line = indent;
  for (const w of text.split(/\s+/)) {
    if (line.length + w.length + 1 > width && line.trim()) { out.push(line.trimEnd()); line = indent; }
    line += w + " ";
  }
  if (line.trim()) out.push(line.trimEnd());
  return out.join("\n");
}

const OPTIONS_HELP = `Options:
  -o, --output <format>  json (default), csv or ndjson
  --out <file>           write to a file instead of stdout
  --raw / --no-raw       include / leave out the raw source blocks (no-raw is much smaller)
  --fields <a,b.c>       only these fields
  --fresh                skip the 24-hour cache
  --records <key>        with csv/ndjson: which list becomes the rows ("." = the whole object)
  --api-key <key>        use this key (default: APISH_API_KEY, then the key saved by apish login)
  -q, --quiet            no credits line on stderr
`;

function generalHelp() {
  return `apish: public web pages from around 1,000 websites as clean JSON, CSV or NDJSON (https://api.sh)

Usage:
  apish <platform> <endpoint> [--param value ...]   run an endpoint
  apish call <route> [name=value ...]              run any route
  apish search <words>                             find endpoints in the live catalog
  apish list [platform]                            list platforms, or a platform's endpoints
  apish help <platform> [endpoint]                 parameters, from the live catalog
  apish login | logout                             save or remove your API key

Examples:
  apish zillow search --location "Austin, TX" --no-raw
  apish tiktok profile --username nasa --fields username,followers
  apish reddit subreddit --subreddit python --all-pages --page-limit 3 -o csv --out python.csv
  apish call /google/v1/search q="best running shoes"
  apish search instagram comments

${OPTIONS_HELP}
Exit codes: 0 ok, 1 error, 2 bad usage or input, 3 key missing or invalid, 4 out of credits or spend
limit, 5 not found, 6 source site failed (failed calls are free), 7 network.

Free monthly credits on every account: https://app.api.sh/signup
`;
}

const SEARCH_HELP = `Usage: apish search <words> [--limit n] [-o json]

Finds endpoints in the live catalog by platform, name and route.
  apish search zillow
  apish search youtube transcript
`;
const LIST_HELP = `Usage: apish list [platform] [-o json]

Without a platform: every platform. With one: its endpoints and prices.
`;
const CALL_HELP = `Usage: apish call <route> [name=value ...] [--name value ...] [options]

Runs any route, as written in the docs. Parameters are sent as given.
  apish call /zillow/v1/search location="Austin, TX"
  apish call "/hackernews/v1/item?id=8863"

${OPTIONS_HELP}  --all-pages            follow the next-page field until the last page
  --page-limit <n>       stop after n pages (default 100)
`;
const LOGIN_HELP = `Usage: apish login [--api-key <key>]

Checks the key (free) and saves it to your config directory (owner-only file).
Reads the key from --api-key, from stdin when piped, or asks for it.
APISH_API_KEY, when set, takes precedence over the saved key. Keys: ${KEYS_URL}
`;

// ---------------------------------------------------------------- input

async function readAll(stream) {
  let s = "";
  for await (const chunk of stream) s += chunk;
  return s;
}

function promptHidden(question, stdin, stderr) {
  return new Promise((resolve, reject) => {
    stderr.write(question);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") { done(); return resolve(value); }
        if (c === "\u0003") { done(); return reject(new UsageError("cancelled")); }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    const done = () => { stdin.setRawMode?.(false); stdin.pause(); stdin.off("data", onData); stderr.write("\n"); };
    stdin.on("data", onData);
  });
}
