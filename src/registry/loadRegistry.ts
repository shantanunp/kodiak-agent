import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface MapperEntry {
  id: string;
  sourceFile: string;
  class: string;
  entryMethod: string;
  sourceType: string;
  targetType: string;
  goldenTests?: string;
}

export interface MappingRegistry {
  repo: string;
  branch: string;
  scope: string[];
  mappers: MapperEntry[];
}

export function loadRegistry(registryPath: string): MappingRegistry {
  const raw = parseYaml(readFileSync(registryPath, "utf8")) as MappingRegistry;
  if (!raw.repo || !raw.branch || !raw.scope?.length) {
    throw new Error("Registry must define repo, branch, and scope");
  }
  return raw;
}

export function parseRepoSlug(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo slug: ${repo}`);
  }
  return { owner, name };
}
