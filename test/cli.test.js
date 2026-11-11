import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, main, parseArgs } from "../src/cli.js";
import { records, toCsv, toNdjson } from "../src/format.js";

const CATALOG = {
  platform_count: 2,
  endpoint_count: 3,
  platforms: [
    { slug: "zillow", name: "Zillow", category: "real estate", endpoints: [
      { route: "/zillow/v1/search", name: "Zillow search", credits: 1 },
      { route: "/zillow/v1/zestimate-history", name: "Zillow Zestimate history", credits: 1 },
    ] },
    { slug: "github", name: "GitHub", category: "developer", endpoints: [
      { route: "/github/v1/repository/issues", name: "GitHub repository issues", credits: 1 },
    ] },
  ],
};

const SPEC = {
  paths: {
    "/zillow/v1/search": { get: {
      summary: "Zillow search", description: "Homes on Zillow.\n\nPrice: ...", "x-credits": 1,
      parameters: [
        { name: "location", in: "query", required: true, schema: { type: "string" }, example: "Austin, TX" },
        { name: "min_price", in: "query", schema: { type: "integer" } },
        { name: "page", in: "query", schema: { type: "integer" } },
      ],
    } },
  },
};

/** A fake api.sh: routes the CLI's requests and records them. */
function fakeApi(handler) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, headers: init.headers || {} });
    if (url.pathname === "/catalog") return json(CATALOG);
    if (url.pathname.startsWith("/openapi/")) return url.pathname === "/openapi/zillow.json" ? json(SPEC) : new Response("not found", { status: 404 });
    return handler(url, init);
  };
  return { fetch, calls };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function sink(isTTY = false) {
  const s = { text: "", isTTY, write(chunk) { s.text += chunk; return true; } };
  return s;
}

async function run(argv, { handler = () => json({ success: true }), env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "apish-cli-test-"));
  const api = fakeApi(handler);
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, {
    env: { APISH_CONFIG_DIR: join(dir, "config"), APISH_CACHE_DIR: join(dir, "cache"), APISH_BASE_URL: "https://api.test", APISH_SITE_URL: "https://site.test", ...env },
    stdout, stderr, fetch: api.fetch,
  });
  return { code, out: stdout.text, err: stderr.text, calls: api.calls, dir };
}

const KEY = { APISH_API_KEY: "ash_test_key" };

test("parseArgs: values, =, booleans, no-, shorts and --", () => {
  const { positionals, flags } = parseArgs(["zillow", "search", "--location", "Austin, TX", "--min-price=1", "--fresh", "--no-raw", "-o", "csv", "-q", "--", "--x"]);
  assert.deepEqual(positionals, ["zillow", "search", "--x"]);
  assert.deepEqual(flags, { location: "Austin, TX", "min-price": "1", fresh: true, raw: false, output: "csv", quiet: true });
});

test("platform endpoint call sends params, key and options", async () => {
  const r = await run(["zillow", "search", "--location", "Austin, TX", "--min-price", "300000", "--no-raw", "--fresh"], {
    env: KEY,
    handler: (url) => json({ success: true, results: [{ zpid: 1 }] }, 200, { "x-credits-used": "1", "x-credits-remaining": "99", "x-request-id": "req_1" }),
  });
  assert.equal(r.code, EXIT.OK, r.err);
  const call = r.calls.find((c) => c.url.pathname === "/zillow/v1/search");
  assert.equal(call.url.searchParams.get("location"), "Austin, TX");
  assert.equal(call.url.searchParams.get("min_price"), "300000");
  assert.equal(call.url.searchParams.get("raw"), "0");
  assert.equal(call.url.searchParams.get("fresh"), "1");
  assert.equal(call.headers["x-api-key"], "ash_test_key");
  assert.deepEqual(JSON.parse(r.out).results, [{ zpid: 1 }]);
  assert.match(r.err, /1 credit used · 99 left · request req_1/);
});

test("multi-word and dashed endpoint names resolve", async () => {
  for (const argv of [["github", "repository", "issues"], ["github", "repository/issues"], ["zillow", "zestimate-history"]]) {
    const r = await run([...argv, "--url", "x"], { env: KEY });
    assert.equal(r.code, EXIT.OK, r.err);
  }
});

test("typos and missing values stop before any paid call", async () => {
  let r = await run(["zillow", "search", "--locaton", "Austin"], { env: KEY });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /Did you mean --location\?/);
  r = await run(["zillow", "search", "--location"], { env: KEY });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /--location needs a value/);
  assert.ok(!r.calls.some((c) => c.url.pathname === "/zillow/v1/search"));
});

test("call: route with name=value pairs and a full URL", async () => {
  let r = await run(["call", "/zillow/v1/search", "location=Austin, TX"], { env: KEY });
  assert.equal(r.code, EXIT.OK, r.err);
  assert.equal(r.calls.at(-1).url.searchParams.get("location"), "Austin, TX");
  r = await run(["call", "https://api.api.sh/hackernews/v1/item?id=8863"], { env: KEY });
  assert.equal(r.calls.at(-1).url.pathname, "/hackernews/v1/item");
  assert.equal(r.calls.at(-1).url.searchParams.get("id"), "8863");
});

test("--output csv asks the API for CSV and --out writes the file", async () => {
  const r0 = await mkdtemp(join(tmpdir(), "apish-out-"));
  const file = join(r0, "homes.csv");
  const r = await run(["zillow", "search", "--location", "78704", "-o", "csv", "--out", file], {
    env: KEY,
    handler: (url) => new Response("zpid,price\r\n1,500000\r\n", { headers: { "content-type": "text/csv" } }),
  });
  assert.equal(r.code, EXIT.OK, r.err);
  assert.equal(r.calls.at(-1).url.searchParams.get("output"), "csv");
  assert.equal(await readFile(file, "utf8"), "zpid,price\r\n1,500000\r\n");
  assert.equal(r.out, "");
});

test("--all-pages follows next_page and joins rows", async () => {
  const r = await run(["zillow", "search", "--location", "78704", "--all-pages", "-o", "ndjson"], {
    env: KEY,
    handler: (url) => {
      const page = Number(url.searchParams.get("page") || 1);
      return json({ success: true, results: [{ zpid: page }], next_page: page < 3 ? page + 1 : null }, 200, { "x-credits-used": "1" });
    },
  });
  assert.equal(r.code, EXIT.OK, r.err);
  assert.equal(r.out, '{"zpid":1}\n{"zpid":2}\n{"zpid":3}\n');
  assert.equal(r.calls.filter((c) => c.url.pathname === "/zillow/v1/search").length, 3);
  assert.match(r.err, /3 credits used · 3 pages/);
});

test("--page-limit caps --all-pages", async () => {
  const r = await run(["zillow", "search", "--location", "78704", "--all-pages", "--page-limit", "2"], {
    env: KEY,
    handler: () => json({ results: [{ a: 1 }], next_page: 9 }),
  });
  assert.equal(r.code, EXIT.OK);
  assert.equal(JSON.parse(r.out).length, 2);
  assert.match(r.err, /Stopped after 2 pages/);
});

test("API errors map to exit codes with readable messages", async () => {
  const cases = [
    [401, { error: "invalid api key" }, EXIT.AUTH, /apish login/],
    [402, { error: "insufficient credits" }, EXIT.CREDITS, /Not enough credits/],
    [402, { error: "spend limit", spend_limit: "daily" }, EXIT.CREDITS, /daily spend limit/],
    [400, { error: "location is required" }, EXIT.USAGE, /location is required/],
    [404, { error: "listing not found" }, EXIT.NOT_FOUND, /listing not found/],
    [502, { error: "source failed" }, EXIT.SOURCE, /Failed calls are free/],
  ];
  for (const [status, body, code, message] of cases) {
    const r = await run(["call", "/zillow/v1/search", "location=x"], { env: { ...KEY }, handler: () => json(body, status, { "x-request-id": "req_e" }) });
    assert.equal(r.code, code, `HTTP ${status}`);
    assert.match(r.err, message);
    assert.match(r.err, /request req_e/);
  }
});

test("network failure exits 7", async () => {
  const r = await run(["call", "/zillow/v1/search", "location=x"], { env: KEY, handler: () => { throw new TypeError("fetch failed"); } });
  assert.equal(r.code, EXIT.NETWORK);
});

test("no key exits 3 without calling", async () => {
  const r = await run(["zillow", "search", "--location", "x"]);
  assert.equal(r.code, EXIT.AUTH);
  assert.match(r.err, /apish login/);
});

test("login checks the key, saves it owner-only, and calls use it; logout removes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apish-login-"));
  const env = { APISH_CONFIG_DIR: dir, APISH_CACHE_DIR: join(dir, "cache"), APISH_BASE_URL: "https://api.test", APISH_SITE_URL: "https://site.test" };
  const api = fakeApi((url, init) => (init.headers["x-api-key"] === "ash_saved" ? json({ success: true }) : json({ error: "invalid api key" }, 401)));
  const io = { env, stdout: sink(), stderr: sink(), fetch: api.fetch };
  assert.equal(await main(["login", "--api-key", "ash_saved"], io), EXIT.OK);
  assert.equal(api.calls.at(-1).url.pathname, "/v1/account");
  const info = await stat(join(dir, "config.json"));
  if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
  assert.equal(await main(["call", "/zillow/v1/search", "location=x"], io), EXIT.OK);
  assert.equal(await main(["logout"], io), EXIT.OK);
  assert.equal(await main(["call", "/zillow/v1/search", "location=x"], io), EXIT.AUTH);
  assert.equal(await main(["login", "--api-key", "ash_wrong"], io), EXIT.AUTH);
});

test("search, list and help come from the live catalog", async () => {
  let r = await run(["search", "zillow", "zestimate"]);
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out.split("\n")[0], /zillow zestimate-history/);
  r = await run(["list"]);
  assert.match(r.out, /zillow\s+Zillow\s+real estate\s+2 endpoints/);
  r = await run(["list", "zillow", "-o", "json"]);
  assert.equal(JSON.parse(r.out).length, 2);
  r = await run(["zillow", "search", "--help"]);
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out, /--location <string>\s+\(required, e.g. Austin, TX\)/);
  assert.match(r.out, /--all-pages/);
  r = await run(["help", "zillow"]);
  assert.match(r.out, /zestimate-history/);
  r = await run(["nosuchsite", "x"]);
  assert.equal(r.code, EXIT.NOT_FOUND);
});

test("the catalog is cached on disk and used when offline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apish-cache-"));
  const env = { APISH_CONFIG_DIR: dir, APISH_CACHE_DIR: join(dir, "cache"), APISH_BASE_URL: "https://api.test", APISH_SITE_URL: "https://site.test" };
  const api = fakeApi(() => json({}));
  await main(["list"], { env, stdout: sink(), stderr: sink(), fetch: api.fetch });
  await stat(join(dir, "cache", "catalog.json"));
  const offline = async () => { throw new TypeError("fetch failed"); };
  const out = sink();
  assert.equal(await main(["list"], { env, stdout: out, stderr: sink(), fetch: offline }), EXIT.OK);
  assert.match(out.text, /zillow/);
});

test("records, CSV and NDJSON follow the API's rules", () => {
  const data = { success: true, credits_used: 1, count: 2, results: [{ a: 1, b: { c: "x" }, tags: ["p", "q"] }, { a: "=SUM(1)" }] };
  const rows = records(data);
  assert.equal(rows.length, 2);
  assert.equal(toCsv(rows), "a,b.c,tags\r\n1,x,p|q\r\n'=SUM(1),,\r\n");
  assert.equal(toNdjson(rows).split("\n").length, 3);
  assert.deepEqual(records({ name: "one", followers: 3 }), [{ name: "one", followers: 3 }]);
  assert.deepEqual(records(data, "."), [{ count: 2, results: data.results }]);
});
