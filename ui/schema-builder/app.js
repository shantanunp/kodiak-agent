import {
  escHtml, escAttr, toast, getMapperId, requireMapperId,
  parseViaApi, saveSchemaDoc, downloadJson, loadDraft,
} from "/shared/schema-ui.js";

const TYPES = ["object", "array", "string", "integer", "number", "boolean", "date", "datetime"];
const TYPE_STYLE = {
  object: { c: "var(--op)", bg: "var(--op-bg)" },
  array: { c: "var(--source)", bg: "var(--source-bg)" },
  string: { c: "var(--ink-soft)", bg: "var(--bg)" },
  integer: { c: "var(--num)", bg: "var(--num-bg)" },
  number: { c: "var(--num)", bg: "var(--num-bg)" },
  boolean: { c: "var(--target)", bg: "var(--target-bg)" },
  date: { c: "var(--cond)", bg: "var(--cond-bg)" },
  datetime: { c: "var(--cond)", bg: "var(--cond-bg)" },
};
const CONTAINER = new Set(["object", "array"]);
const MODE_LABEL = {
  "payload-json": "JSON payload",
  "json-schema": "JSON Schema",
  "payload-xml": "XML payload",
  xsd: "XSD schema",
  kodiak: "Kodiak JSON",
};

let uid = 1;
const nid = () => "n" + uid++;

function makeNode(name, type, extra = {}) {
  return Object.assign(
    { id: nid(), name, type, doc: "", required: false, expanded: true, children: [] },
    extra,
  );
}

function emptyRoot(name) {
  return makeNode(name, "object");
}

const schemas = {
  source: { label: "Source schema", method: "manual", format: null, root: emptyRoot("source"), selectedId: null, query: "" },
  target: { label: "Target schema", method: "manual", format: null, root: emptyRoot("target"), selectedId: null, query: "" },
};

let side = "source";
let viewMode = "tabs";
let modalMode = "payload-json";
let modalTarget = "source";

function walk(node, fn, parent = null) {
  fn(node, parent);
  (node.children || []).forEach((c) => walk(c, fn, node));
}

function findNode(id, root, parent = null) {
  if (root.id === id) return { node: root, parent };
  for (const c of root.children || []) {
    const r = findNode(id, c, root);
    if (r) return r;
  }
  return null;
}

function countElements(key) {
  let n = 0;
  walk(schemas[key].root, () => n++);
  return Math.max(0, n - 1);
}

function matches(node, q) {
  return q && node.name.toLowerCase().includes(q.toLowerCase());
}

function subtreeMatches(node, q) {
  if (matches(node, q)) return true;
  return (node.children || []).some((c) => subtreeMatches(c, q));
}

function fromApiNode(n) {
  const type = n.type === "array" ? "array" : n.type;
  const ui = makeNode(n.name, type, {
    doc: n.description || "",
    required: !!n.required,
  });
  if (n.type === "array") {
    if (n.children?.length) {
      ui.children = [fromApiNode(n.children[0])];
    }
  } else {
    ui.children = (n.children || []).map(fromApiNode);
  }
  return ui;
}

function toApiNode(uiNode) {
  const type = uiNode.type === "datetime" ? "string" : uiNode.type;
  const n = {
    id: uiNode.id,
    name: uiNode.name,
    type,
    required: !!uiNode.required,
    description: uiNode.doc || "",
    children: [],
  };
  if (uiNode.type === "array") {
    if (uiNode.children?.length) {
      const item = uiNode.children[0];
      if (item.type === "object" || CONTAINER.has(item.type)) {
        n.itemType = "object";
        n.children = [toApiNode(item)];
      } else {
        n.itemType = item.type === "datetime" ? "string" : item.type;
      }
    }
  } else if (uiNode.type === "object") {
    n.children = (uiNode.children || []).map(toApiNode);
  }
  return n;
}

function markExpanded(node, depth) {
  node.expanded = depth > 0;
  (node.children || []).forEach((c) => markExpanded(c, depth - 1));
}

function typeBadge(t) {
  const s = TYPE_STYLE[t] || TYPE_STYLE.string;
  const label = t === "array" ? "array[ ]" : t;
  return `<span class="type-badge" style="color:${s.c};background:${s.bg}">${label}</span>`;
}

function nodeRowHtml(node, key, isRoot) {
  const q = schemas[key].query;
  const selId = schemas[key].selectedId;
  const hasKids = CONTAINER.has(node.type);
  const dim = q && !subtreeMatches(node, q);
  const nameCls = matches(node, q) ? "node-name hit" : "node-name";
  const twist = hasKids
    ? `<span class="twist" data-twist="${node.id}">${node.expanded ? "&#9662;" : "&#9656;"}</span>`
    : `<span class="twist leaf"></span>`;
  const docTail = node.doc
    ? `<span class="node-doc" title="${escAttr(node.doc)}">${escHtml(node.doc)}</span>`
    : "";
  const req = node.required ? `<span class="req-star" title="Required">*</span>` : "";
  const rootActions = isRoot
    ? `<span class="row-actions" style="display:flex">
      <button class="act" data-add-child="${node.id}" title="Add child">+</button>
    </span>`
    : "";
  const actions = isRoot
    ? rootActions
    : `<span class="row-actions">
      <button class="act" data-add-child="${node.id}" title="Add child (converts to object if needed)">+</button>
      <button class="act" data-add-sib="${node.id}" title="Add sibling">&#8631;</button>
      <button class="act del" data-del="${node.id}" title="Delete">&times;</button>
    </span>`;
  return `<div class="node-row ${node.id === selId ? "selected" : ""} ${dim ? "dim" : ""}" data-sel="${node.id}">
    ${twist}
    <span class="${nameCls}" id="rowName-${node.id}">${escHtml(node.name)}</span>
    ${req}
    ${typeBadge(node.type)}
    ${docTail}
    ${actions}
  </div>`;
}

function inlineEditorHtml(key, node, isRoot) {
  return `<div class="inline-editor" data-inline-for="${node.id}">
    <div class="field"><label>Name</label>
      <input type="text" id="fName-${key}" value="${escAttr(node.name)}"></div>
    <div class="field"><label>Data type</label>
      <select id="fType-${key}">${TYPES.map((t) => `<option value="${t}" ${t === node.type ? "selected" : ""}>${t}</option>`).join("")}</select>
    </div>
    <div class="field"><label class="field-row"><input type="checkbox" id="fReq-${key}" ${node.required ? "checked" : ""}> Required field</label></div>
    <div class="field"><label>Documentation</label>
      <textarea id="fDoc-${key}" placeholder="What is this element? Notes, allowed values, source system...">${escHtml(node.doc || "")}</textarea>
    </div>
    <div class="inline-actions">
      <button class="d-btn" id="btnChild-${key}"><span class="plus">+</span> Add child</button>
      ${!isRoot ? `<button class="d-btn" id="btnSib-${key}"><span class="plus">+</span> Add sibling</button>` : ""}
      ${!isRoot ? `<button class="d-btn del" id="btnDel-${key}">&times;&nbsp; Delete${(node.children || []).length ? " + children" : ""}</button>` : ""}
    </div>
  </div>`;
}

function renderNode(node, key, depth = 0, isRoot = false, inline = false) {
  let html = nodeRowHtml(node, key, isRoot);
  if (inline && schemas[key].selectedId === node.id) {
    html += inlineEditorHtml(key, node, isRoot);
  }
  const isContainer = CONTAINER.has(node.type);
  if (isContainer && node.expanded !== false) {
    html +=
      `<div class="children-wrap">` +
      (node.children || []).map((c) => renderNode(c, key, depth + 1, false, inline)).join("") +
      `</div>`;
  }
  return `<div class="node">${html}</div>`;
}

function renderPaneTree(key, elId, inline = false) {
  const el = document.getElementById(elId);
  const root = schemas[key].root;
  let html = renderNode(root, key, 0, true, inline);
  if (!root.children?.length) {
    html +=
      `<div class="empty" style="padding:28px 16px;margin-top:4px">No fields yet — use <b>+</b> on the root, the source buttons below, or import a schema.</div>`;
  }
  el.innerHTML = html;
  bindPane(key, elId, inline);

  if (!schemas[key].selectedId && viewMode === "tabs" && elId === "treeSingle" && side === key) {
    schemas[key].selectedId = root.id;
    renderDetailPanel(key);
  }
}

function bindPane(key, elId, inline = false) {
  const el = document.getElementById(elId);
  el.querySelectorAll("[data-sel]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-twist]") || e.target.closest(".row-actions")) return;
      e.stopPropagation();
      if (inline) toggleInline(key, row.dataset.sel);
      else selectNode(key, row.dataset.sel);
    });
  });
  el.querySelectorAll("[data-twist]").forEach((t) => {
    t.addEventListener("click", (e) => {
      e.stopPropagation();
      const found = findNode(t.dataset.twist, schemas[key].root);
      if (!found) return;
      found.node.expanded = !found.node.expanded;
      renderPaneTree(key, elId, inline);
    });
  });
  el.querySelectorAll("[data-add-child]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      addChild(key, b.dataset.addChild);
    }),
  );
  el.querySelectorAll("[data-add-sib]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      addSibling(key, b.dataset.addSib);
    }),
  );
  el.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      delNode(key, b.dataset.del);
    }),
  );
  if (inline) bindInlineFields(key, el);
}

function toggleInline(key, id) {
  schemas[key].selectedId = schemas[key].selectedId === id ? null : id;
  renderPaneTree(key, "tree-" + key, true);
  renderTabsRow();
  renderSummary();
}

function bindInlineFields(key, container) {
  const editorEl = container.querySelector(".inline-editor");
  if (!editorEl) return;
  const nodeId = editorEl.dataset.inlineFor;
  const found = findNode(nodeId, schemas[key].root);
  if (!found) return;
  const node = found.node;
  const refreshInline = () => {
    renderPaneTree(key, "tree-" + key, true);
    renderTabsRow();
    renderSummary();
  };

  const nameInput = editorEl.querySelector(`#fName-${key}`);
  nameInput.addEventListener("input", (e) => {
    node.name = e.target.value;
    const label = document.getElementById("rowName-" + node.id);
    if (label) label.textContent = e.target.value || "(unnamed)";
  });
  nameInput.addEventListener("blur", refreshInline);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameInput.blur();
    }
  });

  editorEl.querySelector(`#fType-${key}`).addEventListener("change", (e) => {
    node.type = e.target.value;
    if (!CONTAINER.has(node.type)) {
      node.children = [];
    } else {
      if (!Array.isArray(node.children)) node.children = [];
      node.expanded = true;
    }
    refreshInline();
  });
  editorEl.querySelector(`#fReq-${key}`).addEventListener("change", (e) => {
    node.required = e.target.checked;
    refreshInline();
  });

  const docInput = editorEl.querySelector(`#fDoc-${key}`);
  docInput.addEventListener("input", (e) => {
    node.doc = e.target.value;
  });
  docInput.addEventListener("blur", refreshInline);

  editorEl.querySelector(`#btnChild-${key}`)?.addEventListener("click", (e) => {
    e.preventDefault();
    addChild(key, node.id);
  });
  editorEl.querySelector(`#btnSib-${key}`)?.addEventListener("click", () => addSibling(key, node.id));
  editorEl.querySelector(`#btnDel-${key}`)?.addEventListener("click", () => delNode(key, node.id));
}

function selectNode(key, id) {
  if (side !== key && viewMode === "tabs") side = key;
  schemas[key].selectedId = id;
  renderTree();
}

function renderSourcesRow(key, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const empty = !schemas[key].root.children?.length;
  if (empty) {
    el.innerHTML = `<div class="sources">
      <button class="src-btn" data-src-mode="payload-json" data-target="${key}"><span class="ic">{ }</span> From JSON payload</button>
      <button class="src-btn" data-src-mode="json-schema" data-target="${key}"><span class="ic">JSC</span> Import JSON Schema</button>
      <button class="src-btn" data-src-mode="payload-xml" data-target="${key}"><span class="ic">&lt;/&gt;</span> From XML payload</button>
      <button class="src-btn" data-src-mode="xsd" data-target="${key}"><span class="ic">XSD</span> Import XSD schema</button>
      <button class="src-btn ghost" data-addroot="${key}"><span class="ic">+</span> Add root element</button>
    </div>`;
  } else {
    el.innerHTML = `<div class="sources-compact">
      <button class="mini-btn" data-addroot="${key}">+ Add element</button>
      <button class="link-btn" data-reimport="${key}">Import a different source (replaces this schema)</button>
    </div>`;
  }
  el.querySelectorAll("[data-src-mode]").forEach((b) =>
    b.addEventListener("click", () => openModal(b.dataset.srcMode, b.dataset.target)),
  );
  el.querySelectorAll("[data-addroot]").forEach((b) =>
    b.addEventListener("click", () => addChild(b.dataset.addroot, schemas[b.dataset.addroot].root.id)),
  );
  el.querySelectorAll("[data-reimport]").forEach((b) =>
    b.addEventListener("click", () => openModal("payload-json", b.dataset.reimport)),
  );
}

function detailBodyHtml(key) {
  const sel = schemas[key].selectedId;
  const found = sel ? findNode(sel, schemas[key].root) : null;
  if (!found) {
    return `<div class="detail-label">Element</div><div class="detail-empty">Select an element in the tree to edit its name, data type, whether it is required, and its documentation.</div>`;
  }
  const { node, parent } = found;
  const isRoot = !parent;
  const primitiveHint = !CONTAINER.has(node.type)
    ? `<p class="detail-empty" style="margin-bottom:10px">Type is <b>${escHtml(node.type)}</b> — click <b>Add child</b> to convert this field to an <b>object</b> and add nested fields.</p>`
    : "";
  return `
    <div class="detail-label">${isRoot ? "Root element" : "Element"}</div>
    ${primitiveHint}
    <div class="field"><label>Name</label>
      <input type="text" id="fName-${key}" value="${escAttr(node.name)}"></div>
    <div class="field"><label>Data type</label>
      <select id="fType-${key}">${TYPES.map((t) => `<option value="${t}" ${t === node.type ? "selected" : ""}>${t}</option>`).join("")}</select>
    </div>
    <div class="field"><label class="field-row"><input type="checkbox" id="fReq-${key}" ${node.required ? "checked" : ""}> Required field</label></div>
    <div class="field"><label>Documentation</label>
      <textarea id="fDoc-${key}" placeholder="What is this element? Notes, allowed values, source system...">${escHtml(node.doc || "")}</textarea>
    </div>
    <div class="detail-actions">
      <button class="d-btn" id="btnChild-${key}"><span class="plus">+</span> Add child element</button>
      ${!isRoot ? `<button class="d-btn" id="btnSib-${key}"><span class="plus">+</span> Add sibling element</button>` : ""}
      ${!isRoot ? `<button class="d-btn del" id="btnDel-${key}">&times;&nbsp; Delete element${(node.children || []).length ? " + children" : ""}</button>` : ""}
    </div>`;
}

function bindDetailFields(key, container) {
  const sel = schemas[key].selectedId;
  const found = sel ? findNode(sel, schemas[key].root) : null;
  if (!found) return;
  const { node } = found;
  container.querySelector(`#fName-${key}`)?.addEventListener("input", (e) => {
    node.name = e.target.value;
    softRefresh(key);
  });
  container.querySelector(`#fType-${key}`)?.addEventListener("change", (e) => {
    node.type = e.target.value;
    if (!CONTAINER.has(node.type)) {
      node.children = [];
    } else {
      if (!Array.isArray(node.children)) node.children = [];
      node.expanded = true;
    }
    renderTree();
  });
  container.querySelector(`#fReq-${key}`)?.addEventListener("change", (e) => {
    node.required = e.target.checked;
    renderTree();
  });
  container.querySelector(`#fDoc-${key}`)?.addEventListener("input", (e) => {
    node.doc = e.target.value;
    softRefresh(key);
  });
  container.querySelector(`#btnChild-${key}`)?.addEventListener("click", (e) => {
    e.preventDefault();
    addChild(key, node.id);
  });
  container.querySelector(`#btnSib-${key}`)?.addEventListener("click", () => addSibling(key, node.id));
  container.querySelector(`#btnDel-${key}`)?.addEventListener("click", () => delNode(key, node.id));
}

function renderDetailPanel(key) {
  const el = document.getElementById("detailPanel");
  el.innerHTML = detailBodyHtml(key);
  bindDetailFields(key, el);
}

function softRefresh(key) {
  renderPaneTree(side, "treeSingle");
  renderTabsRow();
  renderSummary();
}

function ensureContainer(node) {
  const wasPrimitive = !CONTAINER.has(node.type);
  if (wasPrimitive) {
    node.type = "object";
  }
  if (!Array.isArray(node.children)) {
    node.children = [];
  }
  node.expanded = true;
  return wasPrimitive;
}

function addChild(key, id) {
  const found = findNode(id, schemas[key].root);
  if (!found) {
    toast("Could not find element — try selecting it again");
    return;
  }
  const { node } = found;
  const converted = ensureContainer(node);
  const child = makeNode("newField", "string");
  node.children.push(child);
  schemas[key].selectedId = child.id;
  if (converted) {
    toast(`Changed ${node.name} to object — add nested fields below`);
  }
  if (viewMode === "split") {
    renderPaneTree(key, "tree-" + key, true);
    renderTabsRow();
    renderSummary();
  } else {
    renderTree();
  }
  focusNameField(key);
}

function addSibling(key, id) {
  const found = findNode(id, schemas[key].root);
  if (!found?.parent) {
    toast("Root has no sibling");
    return;
  }
  const { node, parent } = found;
  const sib = makeNode("newField", "string");
  const idx = parent.children.indexOf(node);
  parent.children.splice(idx + 1, 0, sib);
  schemas[key].selectedId = sib.id;
  if (viewMode === "split") {
    renderPaneTree(key, "tree-" + key, true);
    renderTabsRow();
    renderSummary();
  } else {
    renderTree();
  }
  focusNameField(key);
}

function delNode(key, id) {
  const found = findNode(id, schemas[key].root);
  if (!found?.parent) {
    toast("Cannot delete the root");
    return;
  }
  const { node, parent } = found;
  const idx = parent.children.indexOf(node);
  parent.children.splice(idx, 1);
  schemas[key].selectedId = parent.children[idx] ? parent.children[idx].id : parent.id;
  if (viewMode === "split") {
    renderPaneTree(key, "tree-" + key, true);
    renderTabsRow();
    renderSummary();
  } else {
    renderTree();
  }
}

function focusNameField(key) {
  setTimeout(() => {
    const inp = document.getElementById("fName-" + key);
    if (inp) {
      inp.focus();
      inp.select();
    }
  }, 0);
}

function renderTabsRow() {
  const el = document.getElementById("tabs");
  el.innerHTML = ["source", "target"]
    .map((s) => {
      const active = s === side ? "active" : "";
      const sw = s === "source" ? "var(--source)" : "var(--target)";
      const n = countElements(s);
      return `<div class="tab ${active}" data-side="${s}"><span class="swatch" style="background:${sw}"></span>${schemas[s].label} <span class="count">${n} elements</span></div>`;
    })
    .join("");
  el.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      side = t.dataset.side;
      document.getElementById("aiTarget").value = side;
      renderTree();
    }),
  );
}

function renderViewToggle() {
  const el = document.getElementById("viewToggle");
  el.innerHTML = ["tabs", "split"]
    .map(
      (v) =>
        `<button data-view="${v}" class="${v === viewMode ? "active" : ""}">${v === "tabs" ? "Tabs" : "Side by side"}</button>`,
    )
    .join("");
  el.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      viewMode = b.dataset.view;
      renderTree();
    }),
  );
}

function renderTabsMode() {
  document.getElementById("canvasTitleSingle").innerHTML =
    `Element tree · <b>${escHtml(schemas[side].root.name)}</b>`;
  document.getElementById("searchSingle").value = schemas[side].query || "";
  renderSourcesRow(side, "sourcesSingle");
  renderPaneTree(side, "treeSingle");
  renderDetailPanel(side);
}

function renderSplitMode() {
  ["source", "target"].forEach((k) => {
    const sw = k === "source" ? "var(--source)" : "var(--target)";
    document.getElementById("canvasTitle-" + k).innerHTML =
      `<span class="swatch" style="background:${sw}"></span>${schemas[k].label} · <b>${escHtml(schemas[k].root.name)}</b>`;
    document.getElementById("search-" + k).value = schemas[k].query || "";
    renderSourcesRow(k, "sources-" + k);
    renderPaneTree(k, "tree-" + k, true);
  });
}

function renderSummary() {
  if (viewMode === "split") {
    const sN = countElements("source");
    const sR = (() => {
      let r = 0;
      walk(schemas.source.root, (n) => {
        if (n.required) r++;
      });
      return r;
    })();
    const tN = countElements("target");
    const tR = (() => {
      let r = 0;
      walk(schemas.target.root, (n) => {
        if (n.required) r++;
      });
      return r;
    })();
    document.getElementById("summary").innerHTML =
      `<b>Source</b> · <b>${sN}</b> elements, <b>${sR}</b> required &nbsp;&middot;&nbsp; <b>Target</b> · <b>${tN}</b> elements, <b>${tR}</b> required`;
  } else {
    const n = countElements(side);
    const req = (() => {
      let r = 0;
      walk(schemas[side].root, (nd) => {
        if (nd.required) r++;
      });
      return r;
    })();
    document.getElementById("summary").innerHTML =
      `<b>${schemas[side].label}</b> · <b>${n}</b> elements, <b>${req}</b> required. Large schemas (thousands of elements across files) are built the same way — import once, then refine.`;
  }
}

function renderTree() {
  renderTabsRow();
  renderViewToggle();
  document.getElementById("layoutTabs").style.display = viewMode === "tabs" ? "" : "none";
  document.getElementById("layoutSplit").style.display = viewMode === "split" ? "" : "none";
  if (viewMode === "tabs") renderTabsMode();
  else renderSplitMode();
  renderSummary();
}

function buildDocument() {
  const mapperId = getMapperId();
  return {
    version: 1,
    mapperId,
    savedAt: new Date().toISOString(),
    source: {
      method: schemas.source.method,
      format: schemas.source.format || undefined,
      root: toApiNode(schemas.source.root),
    },
    target: {
      method: schemas.target.method,
      format: schemas.target.format || undefined,
      root: toApiNode(schemas.target.root),
    },
  };
}

async function onSave() {
  const mapperId = requireMapperId();
  if (!mapperId) return;
  try {
    const doc = buildDocument();
    await saveSchemaDoc(doc);
    toast(`Saved registry/schemas/${mapperId}.schema.json`);
  } catch (err) {
    toast(err.message);
  }
}

function onExport() {
  const mapperId = requireMapperId();
  if (!mapperId) return;
  downloadJson(`${mapperId}.schema.json`, buildDocument());
  toast("Exported JSON");
}

async function onContinue() {
  const mapperId = requireMapperId();
  if (!mapperId) return;
  if (countElements("source") === 0 || countElements("target") === 0) {
    toast("Define at least one element on both source and target");
    return;
  }
  try {
    await saveSchemaDoc(buildDocument());
    location.href = `/pipeline-viewer/?mapper=${encodeURIComponent(mapperId)}`;
  } catch (err) {
    toast(err.message);
  }
}

function openModal(mode, targetKey) {
  modalMode = mode;
  modalTarget = targetKey || side;
  document.querySelectorAll("#modalSeg button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode),
  );
  document.getElementById("modalTitle").textContent = "Import from " + MODE_LABEL[mode];
  const existing = schemas[modalTarget].root.children?.length || 0;
  document.getElementById("modalSub").textContent = existing
    ? `Paste your content and Kodiak will rebuild the element tree. This replaces the ${existing} element(s) already in ${schemas[modalTarget].label}.`
    : "Paste your content and Kodiak will build the element tree. You can edit everything afterwards.";
  document.getElementById("modalMsg").textContent = "";
  document.getElementById("modalText").value = "";
  document.getElementById("modalText").placeholder = "Paste your " + MODE_LABEL[mode] + " here...";
  document.getElementById("overlay").classList.add("show");
}

function closeModal() {
  document.getElementById("overlay").classList.remove("show");
}

async function buildFromModal() {
  const text = document.getElementById("modalText").value.trim();
  const msg = document.getElementById("modalMsg");
  msg.textContent = "";
  if (!text) {
    msg.textContent = "Paste some content first.";
    return;
  }
  try {
    if (modalMode === "kodiak") {
      const doc = JSON.parse(text);
      if (doc.source?.root) {
        schemas.source.root = fromApiNode(doc.source.root);
        schemas.source.method = doc.source.method || "manual";
        schemas.source.format = doc.source.format || null;
      }
      if (doc.target?.root) {
        schemas.target.root = fromApiNode(doc.target.root);
        schemas.target.method = doc.target.method || "manual";
        schemas.target.format = doc.target.format || null;
      }
    } else {
      const rootName = schemas[modalTarget].root.name;
      const result = await parseViaApi(modalMode, text, rootName);
      schemas[modalTarget].root = fromApiNode(result.root);
      schemas[modalTarget].format = result.format;
      schemas[modalTarget].method =
        modalMode.includes("schema") || modalMode === "xsd" ? "schema" : "sample";
      markExpanded(schemas[modalTarget].root, 2);
      schemas[modalTarget].selectedId = schemas[modalTarget].root.children[0]
        ? schemas[modalTarget].root.children[0].id
        : schemas[modalTarget].root.id;
    }
    closeModal();
    renderTree();
    toast(MODE_LABEL[modalMode] + " imported into " + schemas[modalTarget].label);
  } catch (err) {
    msg.textContent =
      "Couldn't parse that " + MODE_LABEL[modalMode] + " — " + (err.message || "check the format") + ".";
  }
}

function aiDraft() {
  const intent = document.getElementById("aiInput").value.trim();
  const key = document.getElementById("aiTarget").value;
  const status = document.getElementById("aiStatus");
  if (!intent) {
    status.textContent = "Describe the structure first.";
    status.classList.add("error");
    return;
  }
  status.classList.remove("error");
  status.textContent = "Drafting a structure from your description...";
  setTimeout(() => {
    const root = makeNode(schemas[key].root.name, "object", { doc: 'AI draft from: "' + intent + '"' });
    const lower = intent.toLowerCase();
    root.children.push(makeNode("id", "string", { required: true }));
    if (/borrower|part(y|ies)|customer|person/.test(lower)) {
      const arr = makeNode("borrowers", "array", { doc: "People on the record" });
      const item = makeNode("borrower", "object");
      item.children = [
        makeNode("firstName", "string", { required: true }),
        makeNode("lastName", "string", { required: true }),
        makeNode("email", "string"),
      ];
      arr.children = [item];
      root.children.push(arr);
    }
    if (/address|property|collateral/.test(lower)) {
      const addr = makeNode("address", "object");
      addr.children = [
        makeNode("line", "string"),
        makeNode("city", "string"),
        makeNode("state", "string"),
        makeNode("postalCode", "string"),
      ];
      root.children.push(addr);
    }
    if (/amount|price|balance|money/.test(lower)) root.children.push(makeNode("amount", "number"));
    if (/date|closing|created/.test(lower)) root.children.push(makeNode("date", "date"));
    schemas[key].root = root;
    schemas[key].selectedId = root.children[0]?.id || root.id;
    status.textContent = "Draft ready — review and edit each element below.";
    renderTree();
  }, 500);
}

async function loadExistingSchema(mapperId) {
  try {
    const res = await fetch(`/api/schemas/${encodeURIComponent(mapperId)}`);
    if (!res.ok) return;
    const doc = await res.json();
    if (doc.source?.root) {
      schemas.source.root = fromApiNode(doc.source.root);
      schemas.source.method = doc.source.method || "manual";
      schemas.source.format = doc.source.format || null;
    }
    if (doc.target?.root) {
      schemas.target.root = fromApiNode(doc.target.root);
      schemas.target.method = doc.target.method || "manual";
      schemas.target.format = doc.target.format || null;
    }
  } catch {
    /* ignore */
  }
}

function wireEvents() {
  document.querySelectorAll("#modalSeg button").forEach((b) =>
    b.addEventListener("click", () => openModal(b.dataset.mode, modalTarget)),
  );
  document.getElementById("modalCancel").addEventListener("click", closeModal);
  document.getElementById("modalBuild").addEventListener("click", buildFromModal);
  document.getElementById("clearText").addEventListener("click", () => {
    document.getElementById("modalText").value = "";
  });
  document.getElementById("overlay").addEventListener("click", (e) => {
    if (e.target.id === "overlay") closeModal();
  });

  document.getElementById("searchSingle").addEventListener("input", (e) => {
    schemas[side].query = e.target.value.trim();
    if (schemas[side].query) {
      walk(schemas[side].root, (n) => {
        if (CONTAINER.has(n.type)) n.expanded = true;
      });
    }
    renderPaneTree(side, "treeSingle");
  });
  document.getElementById("expandAllSingle").addEventListener("click", () => {
    walk(schemas[side].root, (n) => {
      if (CONTAINER.has(n.type)) n.expanded = true;
    });
    renderPaneTree(side, "treeSingle");
  });
  document.getElementById("collapseAllSingle").addEventListener("click", () => {
    walk(schemas[side].root, (n) => {
      if (n !== schemas[side].root && CONTAINER.has(n.type)) n.expanded = false;
    });
    renderPaneTree(side, "treeSingle");
  });

  ["source", "target"].forEach((k) => {
    document.getElementById("search-" + k).addEventListener("input", (e) => {
      schemas[k].query = e.target.value.trim();
      if (schemas[k].query) {
        walk(schemas[k].root, (n) => {
          if (CONTAINER.has(n.type)) n.expanded = true;
        });
      }
      renderPaneTree(k, "tree-" + k, true);
    });
  });
  document.querySelectorAll("[data-expand]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.expand;
      walk(schemas[k].root, (n) => {
        if (CONTAINER.has(n.type)) n.expanded = true;
      });
      renderPaneTree(k, "tree-" + k, true);
    }),
  );
  document.querySelectorAll("[data-collapse]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.collapse;
      walk(schemas[k].root, (n) => {
        if (n !== schemas[k].root && CONTAINER.has(n.type)) n.expanded = false;
      });
      renderPaneTree(k, "tree-" + k, true);
    }),
  );

  document.getElementById("aiBtn").addEventListener("click", aiDraft);
  document.getElementById("aiInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") aiDraft();
  });
  document.getElementById("continueBtn").addEventListener("click", onContinue);
  document.getElementById("btnSave").addEventListener("click", onSave);
  document.getElementById("btnExport").addEventListener("click", onExport);
  document.getElementById("btnImportDoc").addEventListener("click", () => openModal("kodiak", side));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get("mapper")) {
    document.getElementById("mapperId").value = params.get("mapper");
  }

  const draft = loadDraft();
  if (draft?.source?.root) {
    schemas.source.root = fromApiNode(draft.source.root);
    schemas.source.method = draft.source.method || "manual";
  }
  if (draft?.target?.root) {
    schemas.target.root = fromApiNode(draft.target.root);
    schemas.target.method = draft.target.method || "manual";
  }

  const mapperId = getMapperId();
  if (mapperId) await loadExistingSchema(mapperId);

  wireEvents();
  renderTree();
}

init();
