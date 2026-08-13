import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedHelperScopeRules } from "./applyChange.js";

const HELPERS = [
  { name: "trimValue", fields: ["recipientLast", "trackingDigits"] },
];

test("default rules forbid editing shared helpers when none are listed", () => {
  const rules = sharedHelperScopeRules(undefined, []);
  assert.match(rules, /Do NOT modify unrelated field mappings or shared helpers/);
});

test("apply-all allows listed shared helpers in place", () => {
  const rules = sharedHelperScopeRules("apply-all", HELPERS);
  assert.match(rules, /edit these IN PLACE/);
  assert.match(rules, /trimValue/);
  assert.match(rules, /recipientLast/);
  assert.doesNotMatch(rules, /MUST NOT be edited in place/);
});

test("fork requires a private copy and leaves the original helper", () => {
  const rules = sharedHelperScopeRules("fork", HELPERS);
  assert.match(rules, /MUST NOT be edited in place/);
  assert.match(rules, /private copy/);
  assert.match(rules, /Leave the original shared helper bodies unchanged/);
});
