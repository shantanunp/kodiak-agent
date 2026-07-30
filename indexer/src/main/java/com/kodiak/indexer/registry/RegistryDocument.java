package com.kodiak.indexer.registry;

import java.util.ArrayList;
import java.util.List;

public class RegistryDocument {

  private String repo;
  private String branch;
  private List<String> scope = new ArrayList<>();
  private List<MapperEntry> mappers = new ArrayList<>();
  private String worktreeRoot;

  public String getRepo() {
    return repo;
  }

  public void setRepo(String repo) {
    this.repo = repo;
  }

  public String getBranch() {
    return branch;
  }

  public void setBranch(String branch) {
    this.branch = branch;
  }

  public List<String> getScope() {
    return scope;
  }

  public void setScope(List<String> scope) {
    this.scope = scope;
  }

  public List<MapperEntry> getMappers() {
    return mappers;
  }

  public void setMappers(List<MapperEntry> mappers) {
    this.mappers = mappers;
  }

  /** Local filesystem root where fetched sources live (runtime-only, not in YAML). */
  public String getWorktreeRoot() {
    return worktreeRoot;
  }

  public void setWorktreeRoot(String worktreeRoot) {
    this.worktreeRoot = worktreeRoot;
  }
}
