package com.acme.shop.model;

import jakarta.persistence.Entity;

@Entity
public class Order {
  private final String id;
  private long total;

  public Order(String id) {
    this.id = id;
  }

  public void setTotal(long total) {
    this.total = total;
  }
}
