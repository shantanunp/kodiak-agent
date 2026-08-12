import assert from "node:assert/strict";
import test from "node:test";
import { parseImport } from "./parse.js";

test("XML payload: strips namespace prefixes from element names", () => {
  const xml = `<?xml version="1.0"?>
<ns:Customer xmlns:ns="http://example.com/cust">
  <ns:fullName>Ada Lovelace</ns:fullName>
  <ns:orders>
    <ns:order ns:id="1">
      <ns:total>12.5</ns:total>
    </ns:order>
  </ns:orders>
</ns:Customer>`;

  const { root } = parseImport({ mode: "payload-xml", text: xml, rootName: "Customer" });
  // Root name matches, so children are promoted under the side root.
  const childNames = (root.children ?? []).map((c) => c.name);
  assert.ok(!childNames.some((n) => n.includes(":")), `unexpected prefixed names: ${childNames.join(",")}`);
  assert.deepEqual(childNames.sort(), ["fullName", "orders"]);

  const orders = root.children!.find((c) => c.name === "orders")!;
  const order = orders.children!.find((c) => c.name === "order")!;
  assert.equal(order.name, "order");
  const orderKids = (order.children ?? []).map((c) => c.name).sort();
  assert.deepEqual(orderKids, ["@id", "total"]);
  assert.ok(!(order.children ?? []).some((c) => c.name.startsWith("@xmlns")));
});

test("XML payload: unprefixed tags unchanged", () => {
  const xml = `<Customer><fullName>Ada</fullName></Customer>`;
  const { root } = parseImport({ mode: "payload-xml", text: xml, rootName: "Customer" });
  assert.equal(root.children![0]!.name, "fullName");
});
