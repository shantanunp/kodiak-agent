#!/usr/bin/env tsx
/**
 * Fresh-start wipe of field mapping stores (caches + verified + views + jobs).
 *
 *   npm run reset:mappings
 *   npm run reset:mappings -- --mapper order-request-mapper
 */

import { parseArgs } from "node:util";
import { resetMappingData } from "./resetMappingData.js";

const { values } = parseArgs({
  options: {
    mapper: { type: "string", short: "m" },
  },
});

const result = resetMappingData(values.mapper);
console.log(JSON.stringify({ cleared: true, ...result }, null, 2));
