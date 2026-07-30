package com.kodiak.indexer.registry;

public class MapperEntry {

  private String id;
  private String sourceFile;
  private String className;
  private String entryMethod;
  private String sourceType;
  private String targetType;
  private String goldenTests;

  public String getId() {
    return id;
  }

  public void setId(String id) {
    this.id = id;
  }

  public String getSourceFile() {
    return sourceFile;
  }

  public void setSourceFile(String sourceFile) {
    this.sourceFile = sourceFile;
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

  public String getGoldenTests() {
    return goldenTests;
  }

  public void setGoldenTests(String goldenTests) {
    this.goldenTests = goldenTests;
  }
}
