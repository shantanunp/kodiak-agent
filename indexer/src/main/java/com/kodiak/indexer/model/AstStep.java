package com.kodiak.indexer.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.LinkedHashMap;
import java.util.Map;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class AstStep {

  public enum Kind {
    READ,
    FILTER,
    SELECT,
    TRANSFORM,
    BUILD,
    WRITE,
    CONSTANT,
    RAW
  }

  private Kind kind;
  private String targetField;
  private String sourceField;
  private String condition;
  private Map<String, Object> meta;

  public static AstStep raw(String code) {
    AstStep step = new AstStep();
    step.kind = Kind.RAW;
    step.meta = new LinkedHashMap<>();
    step.meta.put("code", code);
    return step;
  }

  /** RAW with a known target so Gemini can expand into a multi-op pipeline. */
  public static AstStep raw(String code, String targetField) {
    AstStep step = raw(code);
    step.targetField = targetField;
    return step;
  }

  public static AstStep write(String targetField, String sourceField) {
    AstStep step = new AstStep();
    step.kind = Kind.WRITE;
    step.targetField = targetField;
    step.sourceField = sourceField;
    return step;
  }

  /**
   * Direct field mapping: source path → target path.
   */
  public static AstStep read(String targetField, String sourceField) {
    AstStep step = new AstStep();
    step.kind = Kind.READ;
    step.targetField = targetField;
    step.sourceField = sourceField;
    return step;
  }

  /**
   * Numeric/text transform with an editable constant (e.g. multiply by 12).
   */
  public static AstStep transform(String op, String value, String targetField) {
    AstStep step = new AstStep();
    step.kind = Kind.TRANSFORM;
    step.targetField = targetField;
    step.meta = new LinkedHashMap<>();
    step.meta.put("op", op);
    step.meta.put("value", value);
    return step;
  }

  public static AstStep constant(String targetField, String value) {
    AstStep step = new AstStep();
    step.kind = Kind.CONSTANT;
    step.targetField = targetField;
    step.meta = new LinkedHashMap<>();
    step.meta.put("value", value);
    return step;
  }

  /** Flat filter marker — following operations are in the then-branch (no children). */
  public static AstStep filter(String condition) {
    AstStep step = new AstStep();
    step.kind = Kind.FILTER;
    step.condition = condition;
    return step;
  }

  public static AstStep build(String targetField, String sourceField) {
    AstStep step = new AstStep();
    step.kind = Kind.BUILD;
    step.targetField = targetField;
    step.sourceField = sourceField;
    return step;
  }

  public Kind getKind() {
    return kind;
  }

  public String getTargetField() {
    return targetField;
  }

  public String getSourceField() {
    return sourceField;
  }

  public String getCondition() {
    return condition;
  }

  public Map<String, Object> getMeta() {
    return meta;
  }
}
