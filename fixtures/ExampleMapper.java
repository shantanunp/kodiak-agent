package com.kodiak.fixtures;

/**
 * Minimal mapper fixture for local indexer and golden-harness validation.
 * Uses setter-based WRITE (recognized) and a direct field assignment (raw marker).
 */
public class ExampleMapper {

  public static class Source {
    private final String firstName;
    private final String lastName;
    private final int age;

    public Source(String firstName, String lastName, int age) {
      this.firstName = firstName;
      this.lastName = lastName;
      this.age = age;
    }

    public String getFirstName() {
      return firstName;
    }

    public String getLastName() {
      return lastName;
    }

    public int getAge() {
      return age;
    }
  }

  public static class Target {
    private String displayName;
    private boolean adult;

    public void setDisplayName(String displayName) {
      this.displayName = displayName;
    }

    public void setAdult(boolean adult) {
      this.adult = adult;
    }

    public String getDisplayName() {
      return displayName;
    }

    public boolean isAdult() {
      return adult;
    }
  }

  public Target map(Source source) {
    Target target = new Target();
    target.setDisplayName(source.getFirstName() + " " + source.getLastName());
    if (source.getAge() >= 18) {
      target.setAdult(true);
    } else {
      target.setAdult(false);
    }
    target.displayName = target.getDisplayName().toUpperCase();
    return target;
  }
}
