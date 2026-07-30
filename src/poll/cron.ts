#!/usr/bin/env tsx
/**
 * Poll GitHub (or local fixtures) every N minutes for mapping changes.
 */

import cron from "node-cron";
import { getEnvOptional } from "../config/env.js";
import { incrementalScan } from "../orchestrator/incrementalScan.js";

const minutes = Number(getEnvOptional("POLL_INTERVAL_MINUTES", "15"));
const expression = `*/${minutes} * * * *`;

console.log(`[poll] scheduling incremental scan every ${minutes} minutes (${expression})`);

cron.schedule(expression, () => {
  console.log(`[poll] tick ${new Date().toISOString()}`);
  incrementalScan().catch((err) => {
    console.error("[poll] error:", err);
  });
});

// Run once immediately on startup
incrementalScan().catch((err) => {
  console.error("[poll] initial run error:", err);
});
