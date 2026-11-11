import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where `apish login` keeps the key. APISH_CONFIG_DIR overrides it. */
export function configDir(env = process.env, platform = process.platform) {
  if (env.APISH_CONFIG_DIR) return env.APISH_CONFIG_DIR;
  if (platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "apish");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "apish");
}

/** Where the catalog and parameter lists are cached. APISH_CACHE_DIR overrides it. */
export function cacheDir(env = process.env, platform = process.platform) {
  if (env.APISH_CACHE_DIR) return env.APISH_CACHE_DIR;
  if (platform === "win32") return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "apish", "cache");
  if (platform === "darwin" && !env.XDG_CACHE_HOME) return join(homedir(), "Library", "Caches", "apish");
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "apish");
}

const configFile = (env) => join(configDir(env), "config.json");

export async function readConfig(env = process.env) {
  try {
    return JSON.parse(await readFile(configFile(env), "utf8"));
  } catch {
    return {};
  }
}

/** Saves the key with owner-only permissions. Returns the file path. */
export async function saveKey(key, env = process.env) {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = configFile(env);
  const config = { ...(await readConfig(env)), api_key: key };
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return file;
}

export async function removeKey(env = process.env) {
  const config = await readConfig(env);
  if (!config.api_key) return false;
  delete config.api_key;
  if (Object.keys(config).length) await writeFile(configFile(env), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  else await rm(configFile(env), { force: true });
  return true;
}

/** --api-key, then APISH_API_KEY, then the saved key. */
export async function resolveKey(flag, env = process.env) {
  if (flag) return { key: flag, source: "--api-key" };
  if (env.APISH_API_KEY) return { key: env.APISH_API_KEY, source: "APISH_API_KEY" };
  const saved = (await readConfig(env)).api_key;
  return saved ? { key: saved, source: configFile(env) } : { key: "", source: "" };
}
