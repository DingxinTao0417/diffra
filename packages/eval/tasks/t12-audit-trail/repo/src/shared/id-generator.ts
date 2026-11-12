// 按前缀各自递增：ord_1、ord_2、trk_1……
export class IdGenerator {
  private readonly counters = new Map<string, number>()

  next(prefix: string): string {
    const value = (this.counters.get(prefix) ?? 0) + 1
    this.counters.set(prefix, value)
    return `${prefix}_${value}`
  }
}
