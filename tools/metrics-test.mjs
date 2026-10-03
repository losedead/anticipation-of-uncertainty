// 复盘度量单测：纯函数，直接跑，不需要浏览器与云端。
// 运行：node tools/metrics-test.mjs
import {
  daysFromHorizon,
  normalizeHorizonDays,
  computeDueAt,
  isJudged,
  isDue,
  daysUntil,
  brierScore,
  calibrationBuckets,
  summarize,
} from '../js/metrics.js'

let pass = 0
let fail = 0

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.log(`  ✗ ${label}\n     期望 ${e}\n     实得 ${a}`)
  }
}
function near(actual, expected, label, tol = 1e-6) {
  if (actual != null && Math.abs(actual - expected) < tol) {
    pass++
  } else {
    fail++
    console.log(`  ✗ ${label}  期望 ≈${expected} 实得 ${actual}`)
  }
}
function ok(cond, label) {
  if (cond) pass++
  else {
    fail++
    console.log(`  ✗ ${label}`)
  }
}

const DAY = 86400000
const NOW = new Date('2026-10-03T12:00:00Z').getTime()

console.log('\n【时域换算】')
eq(daysFromHorizon('短期（数天）'), 10, '短期 → 10 天')
eq(daysFromHorizon('中期（数周）'), 45, '中期 → 45 天')
eq(daysFromHorizon('长期（数月以上）'), 180, '长期 → 180 天')
eq(daysFromHorizon(''), 45, '空值 → 默认中期')
eq(daysFromHorizon('随便什么'), 45, '无法识别 → 默认中期')

eq(normalizeHorizonDays(30, '中期（数周）'), 30, '合法值直接采用')
eq(normalizeHorizonDays('30', '中期（数周）'), 30, '字符串数字也可用')
eq(normalizeHorizonDays(0, '短期（数天）'), 10, '0 非法 → 退回文案估算')
eq(normalizeHorizonDays(-5, '长期（数月以上）'), 180, '负数非法 → 退回估算')
eq(normalizeHorizonDays(99999, '中期（数周）'), 45, '超上限 → 退回估算')
eq(normalizeHorizonDays(null, '短期（数天）'), 10, 'null → 退回估算')
eq(normalizeHorizonDays(NaN, '中期（数周）'), 45, 'NaN → 退回估算')
eq(normalizeHorizonDays(2, '中期（数周）'), 45, '低于 3 天 → 退回估算')
eq(normalizeHorizonDays(3, '中期（数周）'), 3, '边界 3 天可接受')
eq(normalizeHorizonDays(730, '中期（数周）'), 730, '边界 730 天可接受')

console.log('\n【复盘日期】')
const created = '2026-09-01T00:00:00Z'
near(new Date(computeDueAt(created, 30, '')).getTime() - new Date(created).getTime(), 30 * DAY, '30 天 → 到期时间偏移 30 天')
eq(computeDueAt(created, 10, '').toISOString().slice(0, 10), '2026-09-11', '10 天后日期正确')
ok(!Number.isNaN(computeDueAt(null, null, '中期（数周）').getTime()), '创建时间缺失时仍能算出日期')
ok(!Number.isNaN(computeDueAt('garbage', 5, '').getTime()), '非法创建时间时仍能算出日期')

console.log('\n【判定状态】')
ok(isJudged({ verdict: 'hit' }), 'hit 视为已判定')
ok(isJudged({ verdict: 'partial' }), 'partial 视为已判定')
ok(isJudged({ verdict: 'miss' }), 'miss 视为已判定')
ok(!isJudged({ verdict: 'pending' }), 'pending 未判定')
ok(!isJudged({}), '缺 verdict 未判定')
ok(!isJudged(null), 'null 未判定')

const past = { verdict: 'pending', due_at: new Date(NOW - DAY).toISOString() }
const future = { verdict: 'pending', due_at: new Date(NOW + DAY).toISOString() }
const judgedPast = { verdict: 'hit', due_at: new Date(NOW - DAY).toISOString() }
ok(isDue(past, NOW), '已过期未判定 → 进队列')
ok(!isDue(future, NOW), '未到期 → 不进队列')
ok(!isDue(judgedPast, NOW), '已判定 → 永不再进队列（关键：防止重复复盘）')
ok(!isDue({ verdict: 'pending' }, NOW), '无 due_at → 不进队列')

eq(daysUntil(new Date(NOW + 3 * DAY).toISOString(), NOW), 3, '距今 3 天')
eq(daysUntil(new Date(NOW - 2 * DAY).toISOString(), NOW), -2, '已过 2 天')
eq(daysUntil(null, NOW), null, '无日期 → null')
eq(daysUntil('garbage', NOW), null, '非法日期 → null')

console.log('\n【Brier 分数】')
eq(brierScore([]), null, '空集 → null')
near(brierScore([{ verdict: 'hit', confidence: 1 }]), 0, '满分预测 → 0')
near(brierScore([{ verdict: 'miss', confidence: 1 }]), 1, '完全错且极度自信 → 1')
near(brierScore([{ verdict: 'hit', confidence: 0.5 }]), 0.25, '半信半疑且命中 → 0.25')
near(
  brierScore([
    { verdict: 'hit', confidence: 0.8 },
    { verdict: 'miss', confidence: 0.7 },
  ]),
  (0.04 + 0.49) / 2,
  '多条加权平均'
)
near(brierScore([{ verdict: 'partial', confidence: 0.5 }]), 0, '部分应验按 0.5 计，与 0.5 置信度完全吻合 → 0')

console.log('\n【可靠性分桶】')
const b1 = calibrationBuckets([
  { verdict: 'hit', confidence: 0.85 },
  { verdict: 'hit', confidence: 0.9 },
  { verdict: 'miss', confidence: 0.9 },
  { verdict: 'miss', confidence: 0.1 },
  { verdict: 'hit', confidence: 0.15 },
])
eq(b1.length, 5, '固定 5 档')
const b8099 = b1[4]
eq(b8099.n, 3, '80–100% 档计入 3 条')
near(b8099.predicted, (0.85 + 0.9 + 0.9) / 3, '该档平均置信度')
near(b8099.actual, 2 / 3, '该档实际命中率')
const b020 = b1[0]
eq(b020.n, 2, '0–20% 档计入 2 条')
near(b020.actual, 0.5, '低置信度档实际命中 50%')
eq(b1[2].predicted, null, '空档 predicted 为 null')
eq(b1[2].n, 0, '空档 n 为 0')
ok(b1[4].gap < 0, '高置信度档 gap 为负（过度自信）')

console.log('\n【汇总】')
const set = [
  { verdict: 'hit', confidence: 0.8, due_at: new Date(NOW - DAY).toISOString() },
  { verdict: 'partial', confidence: 0.6, due_at: new Date(NOW - DAY).toISOString() },
  { verdict: 'miss', confidence: 0.9, due_at: new Date(NOW + DAY).toISOString() },
  { verdict: 'pending', due_at: new Date(NOW - DAY).toISOString() },
  { verdict: 'pending', due_at: new Date(NOW + 5 * DAY).toISOString() },
]
const s = summarize(set, NOW)
eq(s.total, 5, '总数 5')
eq(s.judged, 3, '已判定 3')
eq(s.pending, 2, '待判定 2')
eq(s.due, 1, '到期待复盘 1（已判定的那条不算）')
near(s.hitRate, 1 / 3, '硬命中率 1/3')
near(s.softRate, (1 + 0.5) / 3, '软命中率（部分应验算半分）')
near(s.avgConfidence, (0.8 + 0.6 + 0.9) / 3, '平均置信度')
near(s.overconfidence, (0.8 + 0.6 + 0.9) / 3 - 0.5, '过度自信指数')
near(s.brier, ((0.8 - 1) ** 2 + (0.6 - 0.5) ** 2 + (0.9 - 0) ** 2) / 3, 'Brier 分数')

const empty = summarize([], NOW)
eq(empty.total, 0, '空档案总数 0')
eq(empty.hitRate, null, '空档案命中率 null（不是 0，避免误导）')
eq(empty.brier, null, '空档案 Brier null')
eq(empty.overconfidence, null, '空档案偏差 null')
eq(summarize(null, NOW).total, 0, 'null 输入不崩')

console.log(`\n${'─'.repeat(46)}`)
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
