package com.acme.shop.controller;

import com.acme.shop.model.Order;
import com.acme.shop.service.OrderService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
  private final OrderService service;

  public OrderController(OrderService service) {
    this.service = service;
  }

  @GetMapping("/orders/{id}")
  public Order get(String id) {
    return service.find(id);
  }
}
