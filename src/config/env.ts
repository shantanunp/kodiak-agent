import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

loadDotenv();

const __root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getEnvOptional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const paths = {
  root: __root,
  registry: resolve(__root, "registry/mapping-registry.yaml"),
  cacheDir: resolve(process.cwd(), getEnvOptional("CACHE_DIR", "./.cache")),
  indexerJar: resolve(
    process.cwd(),
    getEnvOptional("KODIAK_INDEXER_JAR", "./indexer/build/libs/kodiak-indexer.jar"),
  ),
};
