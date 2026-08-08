package com.kodiak.fixtures.patterns;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * PAR-3 conformance corpus — one write pattern per target field.
 * Adapter coverage is proven by analyzer tests against this file.
 */
public class WritePatternCorpus {

  public static class Target {
    private String viaSetter;
    private String viaAssignment;
    private String viaBuilder;
    private String viaWith;
    private String viaPut;
    private String viaConditional;
    private String viaLoop;
    private String viaMethodRef;

    public void setViaSetter(String v) { this.viaSetter = v; }
    public void setViaAssignment(String v) { this.viaAssignment = v; }
    public void setViaBuilder(String v) { this.viaBuilder = v; }
    public void setViaWith(String v) { this.viaWith = v; }
    public void setViaPut(String v) { this.viaPut = v; }
    public void setViaConditional(String v) { this.viaConditional = v; }
    public void setViaLoop(String v) { this.viaLoop = v; }
    public void setViaMethodRef(String v) { this.viaMethodRef = v; }

    public static Builder builder() { return new Builder(); }

    public static class Builder {
      private final Target t = new Target();
      public Builder viaBuilder(String v) { t.viaBuilder = v; return this; }
      public Target build() { return t; }
    }

    /** Fluent with* API (same shape as lombok/fluent setters). */
    public Target withViaWith(String v) { this.viaWith = v; return this; }
  }

  public Target map(String in, List<String> parts, boolean express) {
    Target t = new Target();

    // setter
    t.setViaSetter(in.trim());

    // direct assignment
    t.viaAssignment = in;

    // builder chain
    Target built = Target.builder().viaBuilder(in).build();
    t.setViaBuilder(built.viaBuilder);

    // fluent with*
    t.withViaWith(in);

    // map put (on a Map target receiver)
    Map<String, String> bag = new HashMap<>();
    bag.put("viaPut", in);
    t.setViaPut(bag.get("viaPut"));

    // conditional / ternary
    if (express) {
      t.setViaConditional("EXPRESS");
    } else {
      t.setViaConditional("STANDARD");
    }

    // loop write (last wins — still a write site)
    for (String p : parts) {
      t.setViaLoop(p);
    }

    // method-reference setter
    parts.forEach(t::setViaMethodRef);

    return t;
  }
}
