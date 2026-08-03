package com.kodiak.indexer.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
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
  private String sourceText;
  private String targetField;
  private String sourceField;
  private String condition;
  private List<AstStep> children = new ArrayList<>();
  private Map<String, Object> meta = new LinkedHashMap<>();

  public static AstStep raw(String sourceText) {
    AstStep step = new AstStep();
    step.kind = Kind.RAW;
    step.sourceText = sourceText;
    return step;
  }

  public static AstStep write(String targetField, String sourceField, String sourceText) {
    AstStep step = new AstStep();
    step.kind = Kind.WRITE;
    step.targetField = targetField;
    step.sourceField = sourceField;
    step.sourceText = sourceText;
    return step;
  }

  /**
   * Constant assignment: type-relative path + literal value only.
   *
   * @param targetField path from outer class ({@code Outer.Inner.field}); package is on pipeline
   *     {@code targetType}
   * @param value resolved literal (stored in {@code meta.value})
   */
  public static AstStep constant(String targetField, String value) {
    AstStep step = new AstStep();
    step.kind = Kind.CONSTANT;
    step.targetField = targetField;
    step.children = null;
    step.meta.put("value", value);
    return step;
  }

  public static AstStep filter(String condition, List<AstStep> children, String sourceText) {
    AstStep step = new AstStep();
    step.kind = Kind.FILTER;
    step.condition = condition;
    step.children = children;
    step.sourceText = sourceText;
    return step;
  }

  public static AstStep build(String targetField, String sourceField, String sourceText) {
    AstStep step = new AstStep();
    step.kind = Kind.BUILD;
    step.targetField = targetField;
    step.sourceField = sourceField;
    step.sourceText = sourceText;
    return step;
  }

  public Kind getKind() {
    return kind;
  }

  public String getSourceText() {
    return sourceText;
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

  public List<AstStep> getChildren() {
    return children;
  }

  public Map<String, Object> getMeta() {
    return meta;
  }
}
