export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

export interface ManualClock extends Clock {
  advance(ms: number): void
}

// 测试用：时间只在调用 advance 时往前走
export function createManualClock(start = 0): ManualClock {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}
