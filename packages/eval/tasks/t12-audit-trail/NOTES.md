# t12-audit-trail

项目和 t11 是同一套代码（库存的问题已经修好），多了 `src/audit/audit-log.ts`（空的 `AuditLog`，没有地方写）和 `src/http/admin-support-routes.ts`（客服手动改状态、审计查询接口）。

## 改订单状态的地方

走共用入口 `OrderLifecycle.transition`（`src/orders/order-lifecycle.ts`）的 5 处：

- `src/payments/payment-service.ts`：付款成功，待付款 → 已付款
- `src/orders/cancel-order.ts`：买家或客服取消
- `src/shipping/shipping-service.ts`：发货、签收（两处）
- `src/returns/return-service.ts`：退货入库

绕开共用入口直接写 `order.status` 的 2 处：

- `src/jobs/expire-unpaid-orders.ts`：超时没付款自动取消
- `src/http/admin-support-routes.ts`：客服手动改状态（`POST /admin/orders/:id/status`）

`order-lifecycle.ts` 的注释说「改订单状态走这里」，只看它会以为只有一个入口。

## 隐藏测试怎么读记录

只走接口：操作订单后读 `GET /admin/orders/:id/audit`，逐条比对订单号、原状态、新状态、时间（应用的 clock），触发来源只要求是非空字符串。记录的字段在 `audit-log.ts` 的 `AuditEntry` 里写明了。`from` 为空的记录会被忽略，所以给下单多记一条也不算错。

## 参考答案

`OrderLifecycle` 收下 `AuditLog`，`transition` 多一个触发来源参数并记审计，另加不校验流转的 `force`；定时任务和客服手动改状态改成走它；5 个调用处补上来源；`app.ts` 接线。共 8 个文件。

## 试过的不完整改法

每种都在项目副本上改，再跑隐藏测试，全部失败（2026-11-12 实跑）；这几种可见测试都能通过：

| 改法 | 隐藏测试 |
|---|---|
| I1 只在 `OrderLifecycle` 里记，两处直接写状态的没动 | 失败 3 个 |
| I2 共用入口 + 定时任务，漏了客服手动改状态 | 失败 2 个 |
| I3 共用入口 + 客服手动改状态，漏了定时任务 | 失败 1 个 |
| I4 在 `OrderStore.save` 里比较新旧状态来记（订单对象是原地改的，存的时候新旧一样） | 失败 9 个 |
