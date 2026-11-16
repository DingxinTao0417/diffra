package com.acme.shop.billing;

import com.acme.shop.model.Order;
import org.springframework.stereotype.Service;

@Service
public class InvoiceService {
  public String invoice(Order order) {
    return "invoice";
  }
}
