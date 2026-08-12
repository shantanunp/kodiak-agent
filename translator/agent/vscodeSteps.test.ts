import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatOfflineVscodePrompt, offlineVscodeSteps } from "./vscodeSteps.js";

describe("offlineVscodeSteps", () => {
  it("includes miner, reconcile, import, from-cache-only, and ui:serve", () => {
    const steps = offlineVscodeSteps({
      mapperId: "demo-mapper",
      jobFile: "/proj/.cache/agent-jobs/demo-mapper/abc/job.json",
      resultFile: "/proj/.cache/agent-jobs/demo-mapper/abc/result.json",
      fields: ["Summary.displayName"],
    });
    assert.match(steps.join("\n"), /offlineMiner\.ts/);
    assert.match(steps.join("\n"), /reconcileOffline\.ts/);
    assert.match(steps.join("\n"), /ai-leg-writes\.json/);
    assert.match(steps.join("\n"), /--result .+\/result\.json --fields Summary\.displayName/);
    assert.match(steps.join("\n"), /--mapper demo-mapper --from-cache-only --fields Summary\.displayName/);
    assert.equal(steps.at(-1), "npm run ui:serve");
  });

  it("formatOfflineVscodePrompt is copy-paste friendly", () => {
    const text = formatOfflineVscodePrompt({
      mapperId: "demo",
      jobFile: "/tmp/job.json",
      resultFile: "/tmp/result.json",
      fields: ["A.b"],
    });
    assert.match(text, /offline labeling/);
    assert.match(text, /offlineMiner/);
    assert.match(text, /reconcileOffline/);
    assert.match(text, /npm run label:import/);
    assert.match(text, /npm run label -- --mapper demo --from-cache-only --fields A\.b/);
  });
});
