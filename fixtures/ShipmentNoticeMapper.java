package com.kodiak.fixtures;

/**
 * Generic transformation fixture (logistics domain).
 * Exercises: direct setter, helper chains (trim/split/take, digit-keep,
 * letter-sanitize), arithmetic, constant, conditional, direct assignment,
 * an opaque receiver escape, and one deliberately unmapped target field.
 */
public class ShipmentNoticeMapper {

  public static class Shipment {
    private final String customerName;
    private final double weightKg;
    private final String refCode;
    private final String region;
    private final String status;

    public Shipment(String customerName, double weightKg, String refCode, String region, String status) {
      this.customerName = customerName;
      this.weightKg = weightKg;
      this.refCode = refCode;
      this.region = region;
      this.status = status;
    }

    public String getCustomerName() { return customerName; }
    public double getWeightKg() { return weightKg; }
    public String getRefCode() { return refCode; }
    public String getRegion() { return region; }
    public String getStatus() { return status; }
  }

  public static class DeliveryNotice {
    private String recipientFirst;
    private String recipientLast;
    private long weightGrams;
    private String trackingDigits;
    private String regionCode;
    private boolean priority;
    private String channel;
    private boolean internalFlag;
    private String remarks;      // deliberately never written -> UNMAPPED
    private String stampedBy;    // only written by opaque AuditStamper -> UNRESOLVED

    public void setRecipientFirst(String v) { this.recipientFirst = v; }
    public void setRecipientLast(String v) { this.recipientLast = v; }
    public void setWeightGrams(long v) { this.weightGrams = v; }
    public void setTrackingDigits(String v) { this.trackingDigits = v; }
    public void setRegionCode(String v) { this.regionCode = v; }
    public void setPriority(boolean v) { this.priority = v; }
    public void setChannel(String v) { this.channel = v; }
    public void setStampedBy(String v) { this.stampedBy = v; }
    public void setRemarks(String v) { this.remarks = v; }
  }

  private static final String DEFAULT_CHANNEL = "PORTAL";

  public DeliveryNotice map(Shipment shipment) {
    DeliveryNotice notice = new DeliveryNotice();

    String[] parts = splitName(shipment.getCustomerName());
    notice.setRecipientFirst(parts[0]);
    notice.setRecipientLast(parts.length > 1 ? parts[1] : "");

    notice.setWeightGrams((long) (shipment.getWeightKg() * 1000));
    notice.setTrackingDigits(sanitizeRef(shipment.getRefCode()));
    notice.setRegionCode(normalizeRegion(shipment.getRegion()));

    if ("EXPRESS".equals(shipment.getStatus())) {
      notice.setPriority(true);
    } else {
      notice.setPriority(false);
    }

    notice.setChannel(DEFAULT_CHANNEL);
    notice.internalFlag = true;

    AuditStamper.stamp(notice);

    return notice;
  }

  /** Trims and splits a display name on whitespace. */
  private String[] splitName(String raw) {
    String trimmed = trimValue(raw);
    return trimmed.split("\\s+");
  }

  /** Misleading name on purpose: actually keeps digits, not letters. */
  private String sanitizeRef(String raw) {
    return keepDigits(trimValue(raw));
  }

  private String normalizeRegion(String raw) {
    StringBuilder sb = new StringBuilder();
    for (char c : trimValue(raw).toCharArray()) {
      if (Character.isLetter(c)) {
        sb.append(c);
      }
    }
    return sb.toString().toUpperCase();
  }

  private String keepDigits(String value) {
    StringBuilder sb = new StringBuilder();
    for (char c : value.toCharArray()) {
      if (Character.isDigit(c) || c == '-') {
        sb.append(c);
      }
    }
    return sb.toString();
  }

  private String trimValue(String value) {
    return value == null ? "" : value.trim();
  }
}
