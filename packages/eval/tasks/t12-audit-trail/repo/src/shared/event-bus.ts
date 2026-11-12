import type { AppEvents } from './events.ts'

export type Handler<K extends keyof AppEvents> = (payload: AppEvents[K]) => void

// 进程内的同步事件总线：emit 时按订阅顺序依次调用，处理函数抛的错直接抛给 emit 的调用方
export class EventBus {
  private readonly handlers = new Map<keyof AppEvents, Array<(payload: never) => void>>()

  on<K extends keyof AppEvents>(type: K, handler: Handler<K>): void {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
  }

  emit<K extends keyof AppEvents>(type: K, payload: AppEvents[K]): void {
    for (const handler of this.handlers.get(type) ?? []) (handler as Handler<K>)(payload)
  }
}
