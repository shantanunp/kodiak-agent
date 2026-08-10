/**
 * PAR-3 — write-pattern conformance corpus.
 * Each supported via-kind must be enumerated. When a new pattern appears in the
 * wild, add a case here first, then fix the adapter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scanWriteSites, adapterFor } from "./scanWriteSites.js";

function fieldsOf(source: string, targetClass: string): Array<{ field: string; via: string }> {
  const { parsed, slices } = scanWriteSites({
    filePath: "patterns.java",
    language: "java",
    mapperClass: "M",
    targetClass,
    source,
  });
  void parsed;
  return slices.map((s) => ({ field: s.targetField, via: s.via }));
}

test("PAR-3: setter write is enumerated", () => {
  const hits = fieldsOf(
    `class M { Out map(){ Out o=new Out(); o.setName("a"); return o; } }
     class Out { void setName(String v){} }`,
    "Out",
  );
  assert.ok(hits.some((h) => h.field === "name" && h.via === "setter"));
});

test("PAR-3: direct assignment is enumerated", () => {
  const hits = fieldsOf(
    `class M { Out map(){ Out o=new Out(); o.flag = true; return o; } }
     class Out { boolean flag; }`,
    "Out",
  );
  assert.ok(hits.some((h) => h.field === "flag" && h.via === "assignment"));
});

test("PAR-3: builder chain is enumerated", () => {
  const hits = fieldsOf(
    `class M { Out map(){ return Out.builder().code("X").build(); } }
     class Out {
       static Builder builder(){ return new Builder(); }
       static class Builder { Builder code(String v){ return this; } Out build(){ return new Out(); } }
     }`,
    "Out",
  );
  assert.ok(hits.some((h) => h.field === "code" && h.via === "builder"), JSON.stringify(hits));
});

test("PAR-3: fluent with* is enumerated", () => {
  const hits = fieldsOf(
    `class M { Out map(){ Out o=new Out(); o.withRegion("CA"); return o; } }
     class Out { Out withRegion(String v){ return this; } }`,
    "Out",
  );
  assert.ok(hits.some((h) => h.field === "region" && h.via === "setter"), JSON.stringify(hits));
});

test("PAR-3: map put is enumerated", () => {
  const hits = fieldsOf(
    `import java.util.*;
     class M { Bag map(){ Bag b=new Bag(); b.put("postal", "95110"); return b; } }
     class Bag extends HashMap<String,String> {}`,
    "Bag",
  );
  assert.ok(hits.some((h) => h.field === "postal" && h.via === "map-put"), JSON.stringify(hits));
});

test("PAR-3: conditional branch writes both enumerated", () => {
  const hits = fieldsOf(
    `class M {
       Out map(boolean e){
         Out o=new Out();
         if(e) o.setTier("EXPRESS"); else o.setTier("STD");
         return o;
       }
     }
     class Out { void setTier(String v){} }`,
    "Out",
  );
  const tiers = hits.filter((h) => h.field === "tier");
  assert.ok(tiers.length >= 2, `expected both branches, got ${JSON.stringify(hits)}`);
});

test("PAR-3: loop write is enumerated", () => {
  const hits = fieldsOf(
    `class M {
       Out map(String[] parts){
         Out o=new Out();
         for(String p: parts) o.setLast(p);
         return o;
       }
     }
     class Out { void setLast(String v){} }`,
    "Out",
  );
  assert.ok(hits.some((h) => h.field === "last" && h.via === "setter"));
});

test("PAR-3: method-reference setter is enumerated", () => {
  const hits = fieldsOf(
    `import java.util.*;
     class M {
       Out map(List<String> parts){
         Out o=new Out();
         parts.forEach(o::setTag);
         return o;
       }
     }
     class Out { void setTag(String v){} }`,
    "Out",
  );
  assert.ok(hits.some((h) => h.field === "tag" && h.via === "setter"), JSON.stringify(hits));
});

test("PAR-3: getX().add / addAll is enumerated as collection-add", () => {
  const hits = fieldsOf(
    `import java.util.*;
     class M {
       Out map(String a, List<String> more){
         Out o=new Out();
         o.getItems().add(a);
         o.getItems().addAll(more);
         return o;
       }
     }
     class Out {
       List<String> getItems(){ return null; }
     }`,
    "Out",
  );
  assert.ok(
    hits.some((h) => h.field === "items" && h.via === "collection-add"),
    JSON.stringify(hits),
  );
});

test("PAR-3: fixture corpus file parses and covers core patterns", () => {
  const source = readFileSync("fixtures/write-patterns/WritePatternCorpus.java", "utf8");
  const { slices } = scanWriteSites({
    filePath: "fixtures/write-patterns/WritePatternCorpus.java",
    language: "java",
    mapperClass: "WritePatternCorpus",
    targetClass: "Target",
    source,
  });
  const fields = new Set(slices.map((s) => s.targetField));
  for (const need of [
    "viaSetter",
    "viaAssignment",
    "viaBuilder",
    "viaWith",
    "viaConditional",
    "viaLoop",
    "viaMethodRef",
  ]) {
    assert.ok(fields.has(need), `corpus missing ${need}; got ${[...fields].join(",")}`);
  }
  // map-put in the corpus lands on HashMap receiver, then copied via setter —
  // still must attribute viaPut somehow.
  assert.ok(fields.has("viaPut"), "viaPut should be set via setter after map put");
});
