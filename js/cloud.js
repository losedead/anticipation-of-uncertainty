// ─────────────────────────────────────────────────────────────
// SDK 单例。整个应用只初始化一次，四个模块（auth/database/storage/llm）共用。
// 必须以 endpoint + publishableKey 两个值初始化，缺少 endpoint 会失败。
// ─────────────────────────────────────────────────────────────
import { PUBLIC_CONFIG } from './config.js'

let client = null

export function getCloud() {
  if (client) return client

  const factory = globalThis.WorkBuddyCloud?.createWorkBuddyCloud
  if (typeof factory !== 'function') {
    throw new Error('云端 SDK 未加载完成，请检查网络连接后刷新页面。')
  }

  client = factory({
    endpoint: PUBLIC_CONFIG.endpoint,
    publishableKey: PUBLIC_CONFIG.publishableKey,
  })
  return client
}

/** 把 { data, error } 信封转成"出错就抛"的形式，调用点更干净 */
export function unwrap({ data, error }) {
  if (error) throw error
  return data
}

/** 统一的错误文案：不要把原始对象抛给用户 */
export function describeError(error) {
  if (!error) return '未知错误'
  const code = error.code || error.error?.code || ''
  if (code === '23505') return '该记录已存在。'
  if (code === '42501' || code === '42P01') return '无权限访问数据，或数据表尚未就绪。'
  if (typeof code === 'string' && code.startsWith('auth_')) return '云端凭证校验未通过，请联系管理员。'
  if (typeof code === 'string' && code.startsWith('quota_')) return '调用额度已用尽或触发限流，请稍后再试。'
  if (typeof code === 'string' && code.startsWith('gateway_')) return '模型服务暂时不可用，请稍后重试。'
  if (typeof code === 'string' && code.startsWith('request_')) return '请求参数不被接受，请调整后重试。'
  if (typeof code === 'string' && code.startsWith('internal_')) return '服务内部错误，请稍后重试。'
  return error.message || error.error?.message || '操作失败，请重试。'
}
