// ─────────────────────────────────────────────────────────────
// 数据层：记忆 / 预测档案 / 个人配置
// 三张表都是 owner 作用域，RLS 在数据库侧隔离，前端一律不传 owner_id。
// ─────────────────────────────────────────────────────────────
import { getCloud } from './cloud.js'

const T_MEMORIES = 'wm_memories'
const T_PREDICTIONS = 'wm_predictions'
const T_PROFILE = 'wm_profile'

/* ── 记忆 ───────────────────────────────────────────────── */

export async function listMemories() {
  const { data, error } = await getCloud()
    .database.from(T_MEMORIES)
    .select('id, category, content, weight, created_at, updated_at')
    .order('weight', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return data ?? []
}

export async function addMemory({ category = 'general', content, weight = 3 }) {
  const { data, error } = await getCloud()
    .database.from(T_MEMORIES)
    .insert({ category, content, weight })
    .select()
  if (error) throw error
  return data?.[0] ?? null
}

/** 改一条记忆的内容。改内容不改权重——权重是取用优先级，不该被编辑动作顺手改掉。 */
export async function updateMemory(id, content) {
  const { data, error } = await getCloud()
    .database.from(T_MEMORIES)
    .update({ content, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
  if (error) throw error
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('未能更新：该记录不存在或不属于你。')
  }
  return data[0]
}

export async function removeMemory(id) {
  const { data, error } = await getCloud()
    .database.from(T_MEMORIES)
    .delete()
    .eq('id', id)
    .select()
  if (error) throw error
  return Array.isArray(data) ? data.length : 0
}

/* ── 预测档案 ───────────────────────────────────────────── */

export async function listPredictions(limit = 100) {
  const { data, error } = await getCloud()
    .database.from(T_PREDICTIONS)
    .select(
      'id, question, domain, horizon, horizon_days, confidence, payload, sources, verdict, note, outcome, due_at, reviewed_at, created_at'
    )
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function addPrediction(rec) {
  const { data, error } = await getCloud()
    .database.from(T_PREDICTIONS)
    .insert(rec)
    .select()
  if (error) throw error
  return data?.[0] ?? null
}

/**
 * 复盘：记下判定、实际发生了什么、复盘时间。
 * outcome 是"实际结果"的自由文本，和 verdict（判定等级）是两件事——
 * 前者留下证据，后者用于统计校准，混在一起以后就没法追责了。
 */
export async function reviewPrediction(id, { verdict, outcome = '', note } = {}) {
  const patch = {
    verdict,
    outcome,
    reviewed_at: new Date().toISOString(),
  }
  if (typeof note === 'string') patch.note = note
  const { data, error } = await getCloud()
    .database.from(T_PREDICTIONS)
    .update(patch)
    .eq('id', id)
    .select()
  if (error) throw error
  // RLS 过滤掉的行会返回空数组，而不是报错——必须显式判断
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('未能更新：该记录不存在或不属于你。')
  }
  return data[0]
}

/** 撤销判定，退回待复盘。 */
export async function resetVerdict(id) {
  const { data, error } = await getCloud()
    .database.from(T_PREDICTIONS)
    .update({ verdict: 'pending', outcome: null, reviewed_at: null })
    .eq('id', id)
    .select()
  if (error) throw error
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('未能更新：该记录不存在或不属于你。')
  }
  return data[0]
}

export async function removePrediction(id) {
  const { data, error } = await getCloud()
    .database.from(T_PREDICTIONS)
    .delete()
    .eq('id', id)
    .select()
  if (error) throw error
  return Array.isArray(data) ? data.length : 0
}

/**
 * 今日已提问次数（服务端精确计数）。
 * 用途是每日额度闸——这个站的模型调用花的是站点所有者的云服务资源点，
 * 必须能按账号限流。用 head:true 只要计数不取行，代价最小。
 * 注意：只有成功落库的预测才计数；被中断或推理失败的尝试同样消耗了额度，
 * 但这里不记账——它是给普通使用者用的护栏，不是审计账本。
 */
export async function countTodayPredictions() {
  const start = new Date()
  start.setHours(0, 0, 0, 0) // 本地零点，再转 UTC 与 timestamptz 比较
  const { count, error } = await getCloud()
    .database.from(T_PREDICTIONS)
    .select('id', { count: 'exact', head: true })
    .gte('created_at', start.toISOString())
  if (error) throw error
  return count ?? 0
}

/* ── 个人配置 ───────────────────────────────────────────── */

export async function getProfile() {
  const { data, error } = await getCloud()
    .database.from(T_PROFILE)
    .select('id, nickname, focus, prefs, created_at, updated_at')
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

export async function saveProfile({ nickname, focus, prefs }) {
  const cloud = getCloud()
  const patch = { nickname, focus, prefs, updated_at: new Date().toISOString() }
  const existing = await getProfile()

  // 先查后写：比依赖 ON CONFLICT 更直白，也让"被 RLS 拦下"这件事可被显式发现
  if (existing?.id) {
    const { data, error } = await cloud.database.from(T_PROFILE).update(patch).eq('id', existing.id).select()
    if (error) throw error
    if (!Array.isArray(data) || data.length === 0) throw new Error('未能保存：该记录不属于当前账号。')
    return data[0]
  }

  const { data, error } = await cloud.database.from(T_PROFILE).insert(patch).select()
  if (error) throw error
  return data?.[0] ?? null
}
