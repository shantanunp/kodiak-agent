import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function materializeFile(worktreeRoot: string, filePath: string, content: string): void {
  const full = join(worktreeRoot, filePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
