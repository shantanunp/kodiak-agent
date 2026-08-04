package fixtures;

import java.util.Optional;

/** Fixture: setter fed by a scalar String helper with Optional.trim. */
public class ScalarHelperMapper {

  public static class Property {
    private String street;

    public String getStreet() {
      return street;
    }
  }

  public static class Collateral {
    private String addressLineText;

    public void setAddressLineText(String addressLineText) {
      this.addressLineText = addressLineText;
    }
  }

  public static class Source {
    private Property property;

    public Property getProperty() {
      return property;
    }
  }

  public static class Target {
    private Collateral collateral;

    public void setCollateral(Collateral collateral) {
      this.collateral = collateral;
    }
  }

  public Target map(Source source) {
    Target target = new Target();
    Collateral collateral = new Collateral();
    collateral.setAddressLineText(mapAddressLineViaOptional(source.getProperty()));
    target.setCollateral(collateral);
    return target;
  }

  private String mapAddressLineViaOptional(Property property) {
    return Optional.ofNullable(property)
        .map(Property::getStreet)
        .map(String::trim)
        .filter(s -> !s.isEmpty())
        .orElse(null);
  }
}
