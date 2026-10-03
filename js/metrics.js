// ─────────────────────────────────────────────────────────────
// 校准度量 + 复盘日期
//
// 复盘的意义不在于"我猜对了多少"，而在于"我说的置信度和实际命中率是否吻合"。
// 一个置信度 90% 的预测，命中率只有 60%，那是系统性过度自信——比偶尔猜错严重得多。
//
// 纯函数，零依赖，可脱离浏览器单测。engine.js 从这里取时域换算，保持单一真源。
// ─────────────────────────────────────────────────────────────

/** 判定等级 → 数值化结果（0/0.5/1）。 */
export const OUTCOME_VALUE = { hit: 1, partial: 0.5, miss: 0 }

export const VERDICTS = {
  pending: { label: '待复盘', cls: 'pending', short: '待' },
  hit: { label: '应验', cls: 'hit', short: '✓' },
  partial: { label: '部分应验', cls: 'partial', short: '~' },
  miss: { label: '未应验', cls: 'miss', short: '✕' },
}

/* ── 时域换算（单一真源） ───────────────────────────────── */

/** horizon 文案 → 兜底天数。模型没给 horizonDays 时用它。 */
export function daysFromHorizon(horizon) {
  const s = String(horizon || '')
  if (s.includes('短期')) return 10
  if (s.includes('长期')) return 180
  if (s.includes('中期')) return 45
  return 45
}

/** 夹到 [3, 730]；非法值一律退回按 horizon 文案估算，绝不产出荒谬的复盘日期。 */
export function normalizeHorizonDays(value, horizon) {
  const n = Math.round(Number(value))
  if (Number.isFinite(n) && n >= 3 && n <= 730) return n
  return daysFromHorizon(horizon)
}

/**
 * 复盘到期时间。老记录没有 due_at 时，用 created_at + 天数现算——
 * 这样加功能之前的历史预测也能进入复盘队列，不必回填数据。
 */
export function computeDueAt(createdAt, horizonDays, horizon) {
  const base = createdAt ? new Date(createdAt) : new Date()
  const t = Number.isFinite(base.getTime()) ? base.getTime() : Date.now()
  return new Date(t + normalizeHorizonDays(horizonDays, horizon) * 86400000)
}

/* ── 判定状态 ───────────────────────────────────────────── */

export function isJudged(p) {
  return !!p && OUTCOME_VALUE[p?.verdict] !== undefined
}

/** 未判定、且复盘日期已到。已判定的永不再进队列。 */
export function isDue(p, now = Date.now()) {
  if (isJudged(p)) return false
  const due = p?.due_at ? new Date(p.due_at).getTime() : NaN
  return Number.isFinite(due) && due <= now
}

/** 距今天数，带正负号；null 表示无日期。 */
export function daysUntil(dateLike, now = Date.now()) {
  if (!dateLike) return null
  const t = new Date(dateLike).getTime()
  if (!Number.isFinite(t)) return null
  return Math.round((t - now) / 86400000)
}

/* ── 校准指标 ───────────────────────────────────────────── */

/**
 * Brier 分数：mean((置信度 − 实际结果)²)，越小越好，取值 [0,1]。
 * 参考基线：永远说 50% → 0.25。低于 0.25 才说明你的置信度带信息量。
 */
export function brierScore(judged) {
  const scored = judged.filter((p) => OUTCOME_VALUE[p.verdict] !== undefined && Number.isFinite(Number(p.confidence)))
  if (!scored.length) return null
  const sum = scored.reduce((acc, p) => {
    const d = Number(p.confidence) - OUTCOME_VALUE[p.verdict]
    return acc + d * d
  }, 0)
  return sum / scored.length
}

const BUCKET_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1.0001]

/**
 * 可靠性分桶：置信度切 5 档，看每档的实际命中率。
 * 理想情况 predicted ≈ actual，即落在那条对角线上。
 */
export function calibrationBuckets(judged) {
  const buckets = BUCKET_EDGES.slice(0, -1).map((lo, i) => ({
    lo,
    hi: BUCKET_EDGES[i + 1],
    label: `${Math.round(lo * 100)}–${Math.round(BUCKET_EDGES[i + 1] * 100)}%`,
    n: 0,
    predictedSum: 0,
    actualSum: 0,
  }))

  for (const p of judged) {
    const v = OUTCOME_VALUE[p.verdict]
    const c = Number(p.confidence)
    if (v === undefined || !Number.isFinite(c)) continue
    const idx = Math.min(Math.max(Math.floor(c * 5), 0), 4)
    const b = buckets[idx]
    b.n += 1
    b.predictedSum += c
    b.actualSum += v
  }

  return buckets.map((b) => ({
    label: b.label,
    lo: b.lo,
    hi: Math.min(b.hi, 1),
    n: b.n,
    predicted: b.n ? b.predictedSum / b.n : null,
    actual: b.n ? b.actualSum / b.n : null,
    gap: b.n ? b.actualSum / b.n - b.predictedSum / b.n : null,
  }))
}

/**
 * 汇总一份档案统计。
 * 只统计已判定记录——把待复盘的混进去算命中率是自欺欺人。
 */
export function summarize(predictions, now = Date.now()) {
  const list = Array.isArray(predictions) ? predictions : []
  const judged = list.filter(isJudged)
  const dueList = list.filter((p) => isDue(p, now))

  const counts = { hit: 0, partial: 0, miss: 0 }
  for (const p of judged) counts[p.verdict] = (counts[p.verdict] || 0) + 1

  const hitRate = judged.length ? counts.hit / judged.length : null
  // 部分应验按半分计入"软命中"，避免把"大致对"和"完全错"混为一谈
  const softRate = judged.length ? (counts.hit + counts.partial * 0.5) / judged.length : null
  const avgConfidence = judged.length
    ? judged.reduce((a, p) => a + Number(p.confidence || 0), 0) / judged.length
    : null

  return {
    total: list.length,
    judged: judged.length,
    pending: list.length - judged.length,
    due: dueList.length,
    dueList,
    counts,
    hitRate,
    softRate,
    avgConfidence,
    // 正数 = 过度自信（说的比做到的高）；负数 = 过度保守
    overconfidence: avgConfidence != null && softRate != null ? avgConfidence - softRate : null,
    brier: brierScore(judged),
    buckets: calibrationBuckets(judged),
  }
}
