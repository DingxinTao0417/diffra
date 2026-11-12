export interface OutboxMessage {
  customerId: string
  subject: string
  body: string
  at: number
}

// 待发给买家的通知，真正的发送由别的服务来取
export class Outbox {
  private readonly messages: OutboxMessage[] = []

  push(message: OutboxMessage): void {
    this.messages.push(message)
  }

  forCustomer(customerId: string): OutboxMessage[] {
    return this.messages.filter((message) => message.customerId === customerId)
  }
}
