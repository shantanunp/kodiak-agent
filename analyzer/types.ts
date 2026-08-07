/**
 * Deterministic source analyzer — shared types.
 *
 * Language-neutral: everything here speaks in "classes / methods / fields /
 * write sites". Language specifics live behind LanguageAdapter implementations
 * in analyzer/adapters/ (the POC ships the first adapter; more languages plug
 * in without changing these types).
 */

export interface SourceMethod {
  /** Owning class (simple name). */
  className: string;
  name: string;
  /** 1-based inclusive body line range. */
  startLine: number;
  endLine: number;
  /** Exact body text (verbatim from source). */
  bodyText: string;
  /** Full method text including signature. */
  fullText: string;
  isPrivateOrStaticHelper: boolean;
}

export interface SourceField {
  className: string;
  name: string;
  type?: string;
  line: number;
}

export interface SourceClass {
  name: string;
  startLine: number;
  endLine: number;
}

export interface ParsedSource {
  filePath: string;
  classes: SourceClass[];
  methods: SourceMethod[];
  fields: SourceField[];
}

/** One place in the code where a target field gets written. */
export interface WriteSite {
  /** Normalized field leaf, e.g. "recipientFirst". */
  targetField: string;
  /** How the write happens. */
  via: "setter" | "builder" | "assignment" | "map-put";
  /** Receiver variable, e.g. "notice". */
  receiver: string;
  /** The full argument / right-hand-side expression, verbatim. */
  expression: string;
  /** Enclosing method name. */
  inMethod: string;
  line: number;
  /** Verbatim source line(s) of the write statement. */
  statement: string;
}

/**
 * A self-contained code slice for one write site:
 * the statement plus the transitive bodies of every same-class helper it calls.
 * This is what the labeling agent receives — nothing else is needed.
 */
export interface WriteSlice extends WriteSite {
  /** Helper methods (transitive, same class), in call order, full text. */
  helperClosure: Array<{ name: string; text: string }>;
  /** Ready-to-embed slice: statement + helpers, for the agent prompt. */
  sliceText: string;
}

export type FieldState = "mapped" | "unmapped" | "unresolved";

export interface ChecklistEntry {
  /** Declared field on the target type. */
  field: string;
  type?: string;
  state: FieldState;
  /** Write sites accounting for this field (provenance). */
  writes: Array<{ line: number; via: WriteSite["via"]; inMethod: string }>;
  note?: string;
}

export interface AuditReport {
  sourceFile: string;
  targetClass: string;
  declaredFields: number;
  mapped: number;
  unmapped: number;
  unresolved: number;
  /** True only when every declared field is accounted for (mapped or explicitly unmapped). */
  gatePassed: boolean;
  checklist: ChecklistEntry[];
  /** Write sites that could not be attributed to a declared target field. */
  orphanWrites: WriteSite[];
}

/** Contract every source-language adapter must fulfil. */
export interface LanguageAdapter {
  language: string;
  parse(filePath: string, source: string): ParsedSource;
  /** Enumerate every write site against the given receiver type/class. */
  findWriteSites(parsed: ParsedSource, source: string, targetClass: string): WriteSite[];
  /** Declared fields of the target type (checklist universe). */
  targetFields(parsed: ParsedSource, targetClass: string): SourceField[];
}
