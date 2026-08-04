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
  const wtArg = opts.worktree ? ` --worktree ${opts.worktree}` : "";

  return [
    `Open in VS Code: ${opts.jobFile}`,
    `Copilot Chat (agent mode): Complete the offline label job in ${opts.jobFile}`,
    `npm run label:import -- --result ${opts.resultFile}${fieldsArg}`,
    `npm run label -- --mapper ${opts.mapperId} --from-cache-only${fieldsArg}`,
    `npm run ui:serve`,
  ];
}

/** Multi-line prompt for stderr / README after export. */
export function formatOfflineVscodePrompt(opts: OfflineVscodeStepsOptions): string {
  const fieldsArg = opts.fields.length ? ` --fields ${opts.fields.join(",")}` : "";

  return [
    "── VS Code offline labeling ──────────────────────────",
    "",
    "1. Open the job file in VS Code:",
    `   ${opts.jobFile}`,
    "",
    "2. Copilot Chat (agent mode) — paste:",
    `   Complete the offline label job in ${opts.jobFile}`,
    "",
    "   (.github/instructions/kodiak-agent-label.instructions.md auto-attaches)",
    "",
    "3. After the agent writes result.json, run in the VS Code terminal:",
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
