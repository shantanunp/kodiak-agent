#!/usr/bin/env tsx
/**
 * DEMO: seed incomplete email pipeline after Java was changed to trim().toLowerCase().
 * Viewer shows plain READ; Verify claim should agree and write user-corrected.
 */
import { readFileSync } from "node:fs";
import { loadSchemaJson } from "../translator/model/index.js";
import {
  computeVerifiedFingerprint,
  getVerified,
  promoteToVerified,
} from "../translator/verified/store.js";

const mapperId = "order-request-mapper";
const sourcePath =
  process.env.MAPPER_WORKTREE
    ? `${process.env.MAPPER_WORKTREE}/src/main/java/com/kodiakservice/mapper/OrderRequestMapper.java`
    : "/home/shantanu/Workspace/VS_CODE_V2/ktransform/src/main/java/com/kodiakservice/mapper/OrderRequestMapper.java";

const sourceJava = readFileSync(sourcePath, "utf8");
if (!sourceJava.includes("trim()") || !sourceJava.includes("toLowerCase()")) {
  console.error(
    "Source does not contain trim()/toLowerCase() on email — patch OrderRequestMapper first.",
  );
  process.exit(1);
}

const schemaJson = loadSchemaJson(mapperId);
const fingerprint = computeVerifiedFingerprint({ sourceJava, schemaJson });
const res = promoteToVerified({
  mapperId,
  fingerprint,
  labeledBy: "demo:incomplete-email",
  status: "verified",
  mapping: [
    {
      targetField: "order.details.customer.email",
      pipeline: [
        {
          kind: "READ",
          labelSource: "demo",
          summary: "Reads email from the input customer object.",
          sourceField: "customer.email",
        },
      ],
    },
  ],
});

const entry = getVerified(mapperId, fingerprint);
const email = entry?.fields.find((f) => f.targetField.includes("email"));
console.log(
  JSON.stringify(
    {
      ok: true,
      fingerprint,
      file: res.file,
      emailStatus: email?.status,
      emailPipelineKinds: (email?.pipeline as Array<{ kind?: string }> | undefined)?.map(
        (s) => s.kind,
      ),
      next: [
        "Hard-refresh viewer → open order.details.customer.email (should show READ only)",
        'Claim: there should be a trim and toLowerCase on email before write',
        "Expect: corrected → user-corrected in verified store",
      ],
    },
    null,
    2,
  ),
);
