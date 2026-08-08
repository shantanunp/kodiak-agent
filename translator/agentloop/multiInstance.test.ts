import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attributeMultiInstanceWrites,
  builderBoundVars,
  collectParentRoutes,
  sameVarSegment,
  varAssignmentLines,
  varSegment,
} from "./multiInstance.js";
import type { WriteSite } from "../../analyzer/types.js";

function site(
  partial: Partial<WriteSite> & Pick<WriteSite, "targetField" | "receiver" | "line" | "inMethod">,
): WriteSite {
  return {
    via: "setter",
    expression: "x",
    statement: "x",
    ...partial,
  };
}

test("collectParentRoutes: setX / withX / builder .x", () => {
  const source = `
    r.setPrimary(c1);
    r.withSecondary(c2);
    Record.builder().tertiary(buildT()).build();
  `;
  const routes = collectParentRoutes(source, [
    { pathPrefix: "primary", typeName: "Contact" },
    { pathPrefix: "secondary", typeName: "Contact" },
    { pathPrefix: "tertiary", typeName: "Contact" },
  ]);
  assert.ok(routes[0]!.vars.has("c1"));
  assert.ok(routes[1]!.vars.has("c2"));
  assert.ok(routes[2]!.methods.has("buildT"));
});

test("varSegment / sameVarSegment track reassignments", () => {
  const source = `
Contact c = new Contact();
c.setEmail("a");
r.setPrimary(c);
c = new Contact();
c.setEmail("b");
r.setSecondary(c);
`;
  const assigns = varAssignmentLines(source, "c");
  assert.equal(assigns.length, 2);
  const primaryConsume = source.split("\n").findIndex((l) => l.includes("setPrimary")) + 1;
  const secondaryConsume = source.split("\n").findIndex((l) => l.includes("setSecondary")) + 1;
  const writeA = source.split("\n").findIndex((l) => l.includes('"a"')) + 1;
  const writeB = source.split("\n").findIndex((l) => l.includes('"b"')) + 1;
  assert.ok(sameVarSegment(assigns, writeA, primaryConsume));
  assert.ok(!sameVarSegment(assigns, writeA, secondaryConsume));
  assert.ok(sameVarSegment(assigns, writeB, secondaryConsume));
  assert.equal(varSegment(assigns, writeB).start, assigns[1]);
});

test("builderBoundVars: nested Contact.builder() chain binds to assigned var", () => {
  const source = `
Contact c1 = Contact.builder()
  .email(in.getMain())
  .build();
r.setPrimary(c1);
`;
  const emailLine = source.split("\n").findIndex((l) => l.includes(".email")) + 1;
  assert.deepEqual(builderBoundVars(source, "Contact", emailLine), ["c1"]);
});

test("attribute: reassigned var routes writes to the right parent", () => {
  const source = `
public Record map(In in) {
  Record r = new Record();
  Contact c = new Contact();
  c.setEmail(in.getMainEmail().toLowerCase());
  r.setPrimary(c);
  c = new Contact();
  c.setEmail(in.getAltEmail().trim());
  r.setSecondary(c);
  return r;
}
`;
  const lines = source.split("\n");
  const lineOf = (pred: (l: string) => boolean) => lines.findIndex(pred) + 1;
  const sites = [
    site({
      targetField: "email",
      receiver: "c",
      inMethod: "map",
      line: lineOf((l) => l.includes("toLowerCase")),
    }),
    site({
      targetField: "email",
      receiver: "c",
      inMethod: "map",
      line: lineOf((l) => l.includes("trim()")),
    }),
  ];
  const { attributed, unattributed } = attributeMultiInstanceWrites({
    source,
    typeName: "Contact",
    refs: [
      { pathPrefix: "primary", typeName: "Contact" },
      { pathPrefix: "secondary", typeName: "Contact" },
    ],
    sites,
  });
  assert.equal(unattributed.length, 0);
  const primary = attributed.filter((a) => a.pathPrefix === "primary");
  const secondary = attributed.filter((a) => a.pathPrefix === "secondary");
  assert.equal(primary.length, 1);
  assert.equal(secondary.length, 1);
  assert.ok(primary[0]!.site.line < secondary[0]!.site.line);
});

test("attribute: builder parent inject .primary(c1) + nested builder write", () => {
  const source = `
public Record map(In in) {
  Contact c1 = Contact.builder()
    .email(in.getMainEmail().toLowerCase())
    .build();
  return Record.builder()
    .primary(c1)
    .secondary(buildBackup(in))
    .build();
}
private Contact buildBackup(In in) {
  Contact c2 = new Contact();
  c2.setEmail(in.getAltEmail().trim());
  return c2;
}
`;
  const lines = source.split("\n");
  const lineOf = (pred: (l: string) => boolean) => lines.findIndex(pred) + 1;
  const sites = [
    site({
      targetField: "email",
      receiver: "Contact.builder()",
      via: "builder",
      inMethod: "map",
      line: lineOf((l) => l.includes("toLowerCase")),
    }),
    site({
      targetField: "email",
      receiver: "c2",
      inMethod: "buildBackup",
      line: lineOf((l) => l.includes("trim()")),
    }),
  ];
  const { attributed, unattributed } = attributeMultiInstanceWrites({
    source,
    typeName: "Contact",
    refs: [
      { pathPrefix: "primary", typeName: "Contact" },
      { pathPrefix: "secondary", typeName: "Contact" },
    ],
    sites,
  });
  assert.equal(unattributed.length, 0, JSON.stringify(attributed));
  assert.equal(
    attributed.find((a) => a.site.receiver === "Contact.builder()")?.pathPrefix,
    "primary",
  );
  assert.equal(
    attributed.find((a) => a.site.receiver === "c2")?.pathPrefix,
    "secondary",
  );
});
