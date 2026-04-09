/**
 * TTL Map：带自动过期能力的轻量缓存容器。
 *
 * 本项目里的缓存规模普遍不大，因此采用“每个 key 一个 timer”的模型，
 * 比统一 sweep 更直观，也足够稳定。
 *
 * @template V 存储值类型
 */
export class TtlMap<V> {
  /** 真正存值的 Map。 */
  private readonly data = new Map<string, V>()
  /** 每个 key 对应一个过期定时器，便于刷新 TTL 或手动删除时清理。 */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * @param defaultTtlMs 默认 TTL；`set()` 未传 ttlMs 时使用它
   */
  constructor(private readonly defaultTtlMs: number) {}

  /**
   * 读取缓存值。
   *
   * 这里不需要额外判断“是否过期”，因为到期条目会被 timer 主动清走。
   */
  get(key: string): V | undefined {
    return this.data.get(key)
  }

  /**
   * 检查 key 当前是否还存在于缓存中。
   */
  has(key: string): boolean {
    return this.data.has(key)
  }

  /**
   * 设置缓存并启动/刷新过期定时器。
   *
   * 如果 key 已存在，先删除旧条目（含清理旧定时器），再重新设置。
   * 这意味着重复 `set()` 同一个 key 会刷新其 TTL。
   *
   * @param key 键名
   * @param value 缓存值
   * @param ttlMs 可选自定义 TTL
   */
  set(key: string, value: V, ttlMs?: number): void {
    // 先清旧值，保证一个 key 不会挂着两个 timer。
    this.delete(key)
    this.data.set(key, value)
    // 到期后同步清理数据和 timer 引用，保持两个 Map 一致。
    const timer = setTimeout(() => {
      this.data.delete(key)
      this.timers.delete(key)
    }, ttlMs ?? this.defaultTtlMs)
    // 不让缓存 timer 阻止 Node 进程退出。
    timer.unref()
    this.timers.set(key, timer)
  }

  /**
   * 手动删除 key，并一并清理其定时器。
   */
  delete(key: string): void {
    // 如果不清 timer，会留下悬挂定时器。
    const timer = this.timers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
    this.data.delete(key)
  }
}
