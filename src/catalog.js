import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENDPOINTS, PAGINATION } from "@api.sh/sdk";

const HOUR = 3_600_000;

/**
 * The live catalog (GET https://api.api.sh/catalog, free, no key) and per-platform parameter lists
 * (https://api.sh/openapi/<slug>.json), cached on disk. A stale cache is used when the network is down;
 * with no cache at all, the endpoint list bundled with @api.sh/sdk is the fallback.
 */
export class Catalog {
  constructor({ apiBase = "https://api.api.sh", siteBase = "https://api.sh", cacheDir, fetch = globalThis.fetch, now = Date.now } = {}) {
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.siteBase = siteBase.replace(/\/+$/, "");
    this.dir = cacheDir;
    this.fetch = fetch;
    this.now = now;
    this.data = null;
    this.specs = new Map();
  }

  async cached(name, url, ttl, { refresh = false } = {}) {
    const file = this.dir ? join(this.dir, name) : null;
    let stale = null;
    if (file) {
      try {
        const [info, text] = await Promise.all([stat(file), readFile(file, "utf8")]);
        const value = JSON.parse(text);
        if (!refresh && this.now() - info.mtimeMs < ttl) return value;
        stale = value;
      } catch {
        // no cache yet
      }
    }
    try {
      const res = await this.fetch(url, { headers: { accept: "application/json", "user-agent": "apish-cli" } });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      const value = await res.json();
      if (file) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(value));
      }
      return value;
    } catch (err) {
      if (stale) return stale;
      throw err;
    }
  }

  /** { platform_count, endpoint_count, platforms: [{ slug, name, category, endpoints: [{ route, name, credits }] }] } */
  async load(options = {}) {
    if (this.data && !options.refresh) return this.data;
    try {
      this.data = await this.cached("catalog.json", `${this.apiBase}/catalog`, HOUR, options);
    } catch {
      this.data = bundledCatalog();
      this.data.offline = true;
    }
    return this.data;
  }

  /** A platform by slug, name or the SDK's property name (googleMaps, google_maps, google-maps). */
  async platform(name) {
    const { platforms } = await this.load();
    const want = norm(name);
    return platforms.find((p) => norm(p.slug) === want) || platforms.find((p) => norm(p.name) === want) || null;
  }

  /** The endpoint of a platform from words: ["search"], ["repository", "issues"], ["zestimate-history"]. */
  endpoint(platform, words) {
    const want = norm(words.join("-"));
    const prefix = `/${platform.slug}/v1/`;
    return platform.endpoints.find((e) => norm(tail(e.route)) === want) ||
      platform.endpoints.find((e) => norm(e.route.replace(prefix, "").replace(/\/v1\//, "/")) === want) || null;
  }

  /** The route's parameters: [{ name, required, type, description, enum?, example? }]. */
  async params(route) {
    const slug = route.split("/").filter(Boolean)[0];
    let spec = this.specs.get(slug);
    if (spec === undefined) {
      try {
        spec = await this.cached(join("openapi", `${slug}.json`), `${this.siteBase}/openapi/${slug}.json`, 24 * HOUR);
      } catch {
        spec = null;
      }
      this.specs.set(slug, spec);
    }
    const op = spec?.paths?.[route]?.get;
    if (op) {
      return {
        summary: op.summary || "",
        description: (op.description || "").split("\n\n")[0],
        credits: op["x-credits"],
        params: (op.parameters || []).filter((p) => p.in === "query").map((p) => ({
          name: p.name,
          required: !!p.required,
          type: p.schema?.type || "string",
          description: p.description || "",
          ...(p.schema?.enum ? { enum: p.schema.enum } : {}),
          ...(p.example !== undefined ? { example: String(p.example) } : {}),
        })),
      };
    }
    const e = ENDPOINTS.find((x) => x.route === route);
    return e ? { summary: e.summary, description: "", credits: e.credits, params: e.params } : null;
  }

  /** Endpoints matching the words, best first. */
  async search(query, limit = 20) {
    const { platforms } = await this.load();
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) return [];
    const hits = [];
    for (const p of platforms) {
      const platformText = `${p.slug} ${p.name} ${(p.domains || []).join(" ")}`.toLowerCase();
      for (const e of p.endpoints) {
        const text = `${e.name} ${e.route} ${p.category || ""}`.toLowerCase();
        let score = 0;
        let matched = 0;
        for (const w of words) {
          const inPlatform = platformText.includes(w);
          const inEndpoint = text.includes(w);
          if (inPlatform || inEndpoint) matched++;
          score += (inPlatform ? 3 : 0) + (inEndpoint ? 2 : 0) + (tail(e.route).split(/[-/]/).includes(w) ? 1 : 0);
        }
        if (matched) hits.push({ matched, score, platform: p.slug, name: e.name, route: e.route, credits: e.credits });
      }
    }
    hits.sort((a, b) => b.matched - a.matched || b.score - a.score || a.route.localeCompare(b.route));
    return hits.slice(0, limit).map(({ matched, score, ...h }) => h);
  }
}

/** How a route pages: { from: "next_page", to: "page" }. Bundled list first, then the usual field names. */
export function paginationRule(route, params = []) {
  if (PAGINATION[route]) return PAGINATION[route];
  const names = new Set(params.map((p) => p.name));
  for (const [from, to] of [["next_page", "page"], ["next_cursor", "cursor"], ["next_offset", "offset"], ["next_start", "start"]]) {
    if (names.has(to)) return { from, to };
  }
  return null;
}

/** "/github/v1/repository/issues" -> "repository/issues" */
export function tail(route) {
  const segs = route.split("/").filter(Boolean);
  return segs.slice(1).filter((s) => s !== "v1").join("/") || segs[0];
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

function bundledCatalog() {
  const bySlug = new Map();
  for (const e of ENDPOINTS) {
    const slug = e.route.split("/").filter(Boolean)[0];
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, name: e.platform, category: "", endpoints: [] });
    bySlug.get(slug).endpoints.push({ route: e.route, name: e.summary, credits: e.credits });
  }
  const platforms = [...bySlug.values()];
  return { platform_count: platforms.length, endpoint_count: ENDPOINTS.length, platforms };
}
