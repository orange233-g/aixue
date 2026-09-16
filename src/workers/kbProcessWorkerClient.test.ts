import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { KBSourceText } from '../types'
import type * as KBClient from './kbProcessWorkerClient'

/** V3-P01 回归：Worker 超时/取消/异常后能拒绝当前任务并重建，不依赖真实 Worker 环境。
 *  用可控制响应的 FakeWorker 替换全局 Worker，验证客户端在三种失联场景下的表现。
 *  客户端持有模块级单例 Worker，故每个用例都 vi.resetModules()+动态 import 拿干净实例，避免用例间串状态。 */

type Msg = { data: { id: number; ok?: unknown; error?: string } }

let client: typeof KBClient
let latestFake: FakeWorker | null = null

class FakeWorker {
  static instances = 0
  static terminated = 0
  onMessage: ((e: Msg) => void) | null = null
  onError: (() => void) | null = null
  postedIds: number[] = []
  constructor() {
    FakeWorker.instances++
    latestFake = this
  }
  addEventListener(type: string, cb: unknown): void {
    if (type === 'message') this.onMessage = cb as (e: Msg) => void
    if (type === 'error') this.onError = cb as () => void
  }
  postMessage(data: { id: number }, _transfer?: unknown): void {
    this.postedIds.push(data.id)
  }
  terminate(): void {
    FakeWorker.terminated++
  }
}

const reply = (res: Msg['data']) => latestFake?.onMessage?.({ data: res })
const fireError = () => latestFake?.onError?.()
const lastPostedId = () => latestFake?.postedIds[latestFake.postedIds.length - 1]

function src(): KBSourceText[] {
  return [{ file: 'doc.md', text: 'test' }]
}

beforeEach(async () => {
  FakeWorker.instances = 0
  FakeWorker.terminated = 0
  latestFake = null
  globalThis.Worker = FakeWorker as unknown as typeof Worker
  vi.resetModules()
  client = await import('./kbProcessWorkerClient')
})

describe('V3-P01：KB Worker 超时/取消/异常与重建', () => {
  it('成功响应：worker reply 后按 ok 解析', async () => {
    const ok = { bodyText: '正文', sections: [] }
    const p = client.processKBSources(src(), { timeoutMs: 5000 })
    setTimeout(() => reply({ id: lastPostedId() ?? 0, ok }), 0)
    await expect(p).resolves.toEqual(ok)
  })

  it('超时：请求在界内无响应则拒绝并重建（下一请求新建 Worker）', async () => {
    const p = client.processKBSources(src(), { timeoutMs: 10 })
    await expect(p).rejects.toThrow(/超时/)
    expect(FakeWorker.instances).toBe(1)
    await expect(client.processKBSources(src(), { timeoutMs: 10 })).rejects.toThrow(/超时/)
    expect(FakeWorker.instances).toBe(2)
  })

  it('取消：signal.abort 拒绝当前任务并 terminate Worker，下一请求由新 Worker 执行（V4-P01）', async () => {
    const ac = new AbortController()
    const p = client.processKBSources(src(), { signal: ac.signal, timeoutMs: 5000 })
    ac.abort()
    await expect(p).rejects.toThrow(/取消/)
    // abort 不再只是 reject Promise：必须真正 terminate 后台 Worker，避免清洗/分块持续占 CPU
    expect(FakeWorker.terminated).toBe(1)
    // 下一任务惰性重建新 Worker 执行
    const p2 = client.processKBSources(src(), { timeoutMs: 5000 })
    setTimeout(() => reply({ id: lastPostedId() ?? 0, ok: { bodyText: 'b', sections: [] } }), 0)
    await expect(p2).resolves.toEqual({ bodyText: 'b', sections: [] })
    expect(FakeWorker.instances).toBe(2)
  })

  it('取消前置：调用前 signal 已 aborted 则同步拒绝且不派发任务', async () => {
    const ac = new AbortController()
    ac.abort()
    const p = client.processKBSources(src(), { signal: ac.signal, timeoutMs: 5000 })
    await expect(p).rejects.toThrow(/取消/)
    expect(latestFake?.postedIds ?? []).toHaveLength(0)
  })

  it('worker 运行时异常：拒绝全部 pending 并复位，下一请求可重建', async () => {
    const p = client.processKBSources(src(), { timeoutMs: 5000 })
    const instBefore = FakeWorker.instances
    setTimeout(() => fireError(), 0)
    await expect(p).rejects.toThrow(/Worker 异常/)
    await expect(client.processKBSources(src(), { timeoutMs: 5000 })).rejects.toThrow(/超时/)
    expect(FakeWorker.instances).toBeGreaterThan(instBefore)
  })
})