package com.acme.shop.repository;

import com.acme.shop.model.Order;
import com.acme.shop.service.PriceCalculator;
import org.springframework.stereotype.Repository;

@Repository
public class OrderRepository {
  public Order findById(String id) {
    Order order = new Order(id);
    order.setTotal(PriceCalculator.total(100));
    return order;
  }
}
