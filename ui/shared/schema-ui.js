/** Shared browser helpers for schema UI pages. */

export const SESSION_KEY = "kodiak-structure-draft";

export function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escAttr(s) {
  return escHtml(s).replace(/"/g, "&quot;");
}

export function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2800);
}

export const MAPPER_STORAGE_KEY = "kodiak.mapper";
export const EMBED_STORAGE_KEY = "kodiak.ui.embed";

export function getStoredMapper() {
  try {
    return localStorage.getItem(MAPPER_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setStoredMapper(id) {
  try {
    if (id) localStorage.setItem(MAPPER_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

/** Mapper id from input / localStorage — never from URL query params. */
export function getMapperId() {
  const input = document.getElementById("mapperId")?.value?.trim() || "";
  return input || getStoredMapper();
}

export function requireMapperId() {
  const id = getMapperId();
  if (!id) {
    toast("Enter a mapper id first");
    return null;
  }
  setStoredMapper(id);
  return id;
}

/** "1" = drawer embed, "setup" = full-page setup inside /kodiak shell. */
export function getEmbedMode() {
  try {
    return sessionStorage.getItem(EMBED_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export async function parseViaApi(mode, text, rootName) {
  const res = await fetch("/api/schemas/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, text, rootName }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Parse failed");
  return data;
}

export function saveDraft(draft) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(draft));
}

export function loadDraft() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function saveSchemaDoc(doc) {
  const res = await fetch(`/api/schemas/${encodeURIComponent(doc.mapperId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Save failed");
  return data;
}

export const TYPES = [
  { v: "string", label: "Text (str)" },
  { v: "integer", label: "Number (int)" },
  { v: "number", label: "Decimal (float)" },
  { v: "boolean", label: "Boolean (bool)" },
  { v: "date", label: "Date" },
  { v: "array", label: "List (list)" },
  { v: "object", label: "Object (dict)" },
];

let uid = 1;
export function newNode(name, type) {
  const node = {
    id: "n" + uid++,
    name: name || "field",
    description: "",
    required: false,
    children: [],
  };
  if (type) {
    node.type = type;
    if (type === "array") node.itemType = "string";
  }
  return node;
}

export function resetIds() {
  uid = 1;
}

export function emptyRoot(name) {
  return newNode(name || "root", "object");
}

export function needsChildren(node) {
  return node.type === "object" || (node.type === "array" && node.itemType === "object");
}

export function findNode(tree, id) {
  for (const n of tree) {
    if (n.id === id) return n;
    if (n.children?.length) {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

export function findParentArray(tree, id) {
  for (const n of tree) {
    if (n.id === id) return tree;
    if (n.children?.length) {
      const f = findParentArray(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

export function countNodes(tree) {
  let c = 0;
  for (const n of tree) {
    c += 1;
    if (n.children?.length) c += countNodes(n.children);
  }
  return c;
}

export function buildSchemaDocument(mapperId, source, target) {
  return {
    version: 1,
    mapperId,
    source: {
      method: source.method,
      format: source.format || undefined,
      root: source.root,
    },
    target: {
      method: target.method,
      format: target.format || undefined,
      root: target.root,
    },
    savedAt: new Date().toISOString(),
  };
}
