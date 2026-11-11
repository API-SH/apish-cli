// Live checks against api.sh. Skipped unless APISH_API_KEY is set. The endpoint call costs one credit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, main } from "../src/cli.js";

const key = process.env.APISH_API_KEY;
const sink = () => { const s = { text: "", write(c) { s.text += c; return true; } }; return s; };

test("live: help from the catalog, then one endpoint call", { skip: !key && "set APISH_API_KEY to run" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "apish-live-"));
  const env = { APISH_API_KEY: key, APISH_CONFIG_DIR: dir, APISH_CACHE_DIR: join(dir, "cache") };
  let out = sink();
  assert.equal(await main(["tiktok", "profile", "--help"], { env, stdout: out, stderr: sink() }), EXIT.OK);
  assert.match(out.text, /--username/);
  out = sink();
  const err = sink();
  const code = await main(["tiktok", "profile", "--username", "nasa", "--no-raw"], { env, stdout: out, stderr: err });
  assert.equal(code, EXIT.OK, err.text);
  assert.equal(JSON.parse(out.text).username, "nasa");
});
