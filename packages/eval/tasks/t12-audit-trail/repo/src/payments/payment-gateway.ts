export type ChargeResult = { ok: true; ref: string } | { ok: false; reason: string }

export interface PaymentGateway {
  charge(token: string, amountCents: number): ChargeResult
  refund(ref: string, amountCents: number): void
}

// 本地和测试用的假网关：tok_declined 拒付，其他凭证都成功；记下每笔扣款和退款方便核对
export class FakeGateway implements PaymentGateway {
  readonly charges: Array<{ ref: string; amountCents: number }> = []
  readonly refunds: Array<{ ref: string; amountCents: number }> = []

  charge(token: string, amountCents: number): ChargeResult {
    if (token === 'tok_declined') return { ok: false, reason: '银行拒绝了这笔付款' }
    const ref = `ch_${this.charges.length + 1}`
    this.charges.push({ ref, amountCents })
    return { ok: true, ref }
  }

  refund(ref: string, amountCents: number): void {
    this.refunds.push({ ref, amountCents })
  }
}
