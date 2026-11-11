// 模糊测试用的可复现随机数（mulberry32）：失败时按同一个种子能重现
export function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function randomBytes(next: () => number, length: number): Buffer {
  return Buffer.from(Array.from({ length }, () => Math.floor(next() * 256)))
}
