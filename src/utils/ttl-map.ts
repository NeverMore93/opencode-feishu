/**
 * TTL Map — 带自动过期的 Map，替代手动 setTimeout/sweep 模式
 */
export class TtlMap<V> {
  private readonly data = new Map<string, V>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly defaultTtlMs: number) {}

  get(key: string): V | undefined {
    return this.data.get(key)
  }

  has(key: string): boolean {
    return this.data.has(key)
  }

  set(key: string, value: V, ttlMs?: number): void {
    this.delete(key)
    this.data.set(key, value)
    const timer = setTimeout(() => {
      this.data.delete(key)
      this.timers.delete(key)
    }, ttlMs ?? this.defaultTtlMs)
    timer.unref()
    this.timers.set(key, timer)
  }

  delete(key: string): void {
    const timer = this.timers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
    this.data.delete(key)
  }
}
