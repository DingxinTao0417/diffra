package com.acme.shop.util;

public final class Strings {
  private Strings() {}

  public static boolean blank(String value) {
    return value == null || value.isBlank();
  }
}
