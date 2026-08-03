package com.kodiak.indexer.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.ArrayList;
import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class IndexResult {

  private String mapperId;
  private String className;
  private String entryMethod;
  private String sourceType;
  private String targetType;
  private String sourceFile;
  private List<AstStep> operations = new ArrayList<>();

  public String getMapperId() {
    return mapperId;
  }

  public void setMapperId(String mapperId) {
    this.mapperId = mapperId;
  }

  public String getClassName() {
    return className;
  }

  public void setClassName(String className) {
    this.className = className;
  }

  public String getEntryMethod() {
    return entryMethod;
  }

  public void setEntryMethod(String entryMethod) {
    this.entryMethod = entryMethod;
  }

  public String getSourceType() {
    return sourceType;
  }

  public void setSourceType(String sourceType) {
    this.sourceType = sourceType;
  }

  public String getTargetType() {
    return targetType;
  }

  public void setTargetType(String targetType) {
    this.targetType = targetType;
  }

  public String getSourceFile() {
    return sourceFile;
  }

  public void setSourceFile(String sourceFile) {
    this.sourceFile = sourceFile;
  }

  public List<AstStep> getOperations() {
    return operations;
  }

  public void setOperations(List<AstStep> operations) {
    this.operations = operations;
  }
}
