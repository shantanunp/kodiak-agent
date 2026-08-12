/**
 * Copy-paste VS Code steps printed after offline job export.
 */

export interface OfflineVscodeStepsOptions {
  mapperId: string;
  jobFile: string;
  resultFile: string;
  worktree?: string;
  fields: string[];
}

export function offlineVscodeSteps(opts: OfflineVscodeStepsOptions): string[] {
  const fieldsArg = opts.fields.length ? ` --fields ${opts.fields.join(",")}` : "";
  const jobDir = opts.jobFile.replace(/\/job\.json$/, "");
  const writes = `${jobDir}/ai-leg-writes.json`;
  const candidates = `${jobDir}/ai-leg-candidates.json`;

  return [
    `Open in VS Code: ${opts.jobFile}`,
    `Copilot Chat (agent mode): Complete the offline label job in ${opts.jobFile}`,
    `Write miner JSON (online shape): ${writes}  →  { "writes": [{ "field", "line", "evidence" }] }`,
    `npx tsx translator/agent/offlineMiner.ts --job ${opts.jobFile} --writes ${writes}`,
    `npx tsx translator/agent/reconcileOffline.ts --job ${opts.jobFile} --candidates ${candidates}`,
    `Label from label-plan.json → write ${opts.resultFile}`,
    `npm run label:import -- --result ${opts.resultFile}${fieldsArg}`,
    `npm run label -- --mapper ${opts.mapperId} --from-cache-only${fieldsArg}`,
    `npm run ui:serve`,
  ];
}

/** Multi-line prompt for stderr / README after export. */
export function formatOfflineVscodePrompt(opts: OfflineVscodeStepsOptions): string {
  const fieldsArg = opts.fields.length ? ` --fields ${opts.fields.join(",")}` : "";
  const jobDir = opts.jobFile.replace(/\/job\.json$/, "");
  const writes = `${jobDir}/ai-leg-writes.json`;
  const candidates = `${jobDir}/ai-leg-candidates.json`;

  return [
    "── VS Code offline labeling (online-parity) ──────────",
    "",
    "1. Open the job file in VS Code:",
    `   ${opts.jobFile}`,
    "",
    "2. Copilot Chat (agent mode) — paste:",
    `   Complete the offline label job in ${opts.jobFile}`,
    "",
    "   (.github/instructions/kodiak-agent-label.instructions.md auto-attaches)",
    "",
    "3. After the agent writes ai-leg-writes.json + result.json, run:",
    "",
    `   npx tsx translator/agent/offlineMiner.ts --job ${opts.jobFile} --writes ${writes}`,
    "",
    `   npx tsx translator/agent/reconcileOffline.ts --job ${opts.jobFile} --candidates ${candidates}`,
    "",
    "   (Label using label-plan.json — demotedUnresolved = online aiOnly demote.)",
    "",
    `   npm run label:import -- --result ${opts.resultFile}${fieldsArg}`,
    "",
    `   npm run label -- --mapper ${opts.mapperId} --from-cache-only${fieldsArg}`,
    "",
    "4. Optional — pipeline viewer:",
    "",
    "   npm run ui:serve",
    "",
    "──────────────────────────────────────────────────────",
  ].join("\n");
}
