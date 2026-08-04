package fixtures;

import java.util.Optional;

/** Fixture: setter fed by a scalar String helper with Optional.trim. */
public class ScalarHelperMapper {

  public static class Address {
    private String street;

    public String getStreet() {
      return street;
    }
  }

  public static class Destination {
    private String streetLine;

    public void setStreetLine(String streetLine) {
      this.streetLine = streetLine;
    }
  }

  public static class Source {
    private Address address;

    public Address getAddress() {
      return address;
    }
  }

  public static class Target {
    private Destination destination;

    public void setDestination(Destination destination) {
      this.destination = destination;
    }
  }

  public Target map(Source source) {
    Target target = new Target();
    Destination destination = new Destination();
    destination.setStreetLine(mapStreetViaOptional(source.getAddress()));
    target.setDestination(destination);
    return target;
  }

  private String mapStreetViaOptional(Address address) {
    return Optional.ofNullable(address)
        .map(Address::getStreet)
        .map(String::trim)
        .filter(s -> !s.isEmpty())
        .orElse(null);
  }
}
