// 自检脚本：验证数据源路由、结构化解析容错、以及全部接口的真实抓取
// 运行： node tools/selftest.mjs
import { SOURCES, selectSources, fetchSnapshot } from '../js/datasources.js'
import { parsePrediction } from '../js/engine.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

console.log('\n[1] 数据源路由')
{
  const a = selectSources('未来两周重庆的天气趋势如何').map((s) => s.id)
  check('天气问题命中 weather', a.includes('weather'), JSON.stringify(a))

  const b = selectSources('人民币对美元汇率会怎么走').map((s) => s.id)
  check('汇率问题命中 fx', b.includes('fx'), JSON.stringify(b))

  const c = selectSources('人工智能接下来会怎么发展').map((s) => s.id)
  check('技术问题命中 tech', c.includes('tech'), JSON.stringify(c))

  const d = selectSources('今天午饭吃什么').map((s) => s.id)
  check('无关键词时保留核心源', d.includes('time') && d.includes('weather') && d.length >= 3, JSON.stringify(d))

  const e = selectSources('地震会不会引发海啸').map((s) => s.id)
  check('地质问题命中 quake', e.includes('quake'), JSON.stringify(e))

  // 新增六类金融/期货/政策/科技/热点/公司的路由
  const f = selectSources('上证指数和美股接下来会怎么走').map((s) => s.id)
  check('股市问题命中 market', f.includes('market'), JSON.stringify(f))

  const g = selectSources('原油和黄金价格会怎么走').map((s) => s.id)
  check('大宗商品问题命中 futures', g.includes('futures'), JSON.stringify(g))

  const h = selectSources('最新的产业政策和监管方向是什么').map((s) => s.id)
  check('政策问题命中 policy', h.includes('policy'), JSON.stringify(h))

  const i = selectSources('最近有什么热点事件在被热议').map((s) => s.id)
  check('热点问题命中 hot', i.includes('hot'), JSON.stringify(i))

  const j = selectSources('这家上市公司的公告和业绩怎么样').map((s) => s.id)
  check('公司问题命中 company', j.includes('company'), JSON.stringify(j))

  const k = selectSources('这家公司的cpi和通胀数据').map((s) => s.id)
  check('宏观问题命中 macro', k.includes('macro'), JSON.stringify(k))

  const vague = selectSources('随便聊聊').map((s) => s.id)
  check('空泛问题补足背景源', vague.includes('hot') && vague.includes('policy'), JSON.stringify(vague))
  check('空泛问题不会拉起全部源', vague.length < SOURCES.length, `${vague.length} / ${SOURCES.length}`)

  // 新增：社交热榜（走后端代理的源）
  const soc = selectSources('微博和抖音的热搜榜上都有什么话题').map((s) => s.id)
  check('社交热榜问题命中 social', soc.includes('social'), JSON.stringify(soc))

  check('源总数 >= 18', SOURCES.length >= 18, `实际 ${SOURCES.length}`)
  check('每个源字段完整', SOURCES.every((s) => s.id && s.name && s.icon && Array.isArray(s.tags) && typeof s.run === 'function'))
  check('源 id 唯一', new Set(SOURCES.map((s) => s.id)).size === SOURCES.length)
  check('每个源都有关键词标签', SOURCES.every((s) => s.tags.length >= 3), SOURCES.filter((s) => s.tags.length < 3).map((s) => s.id).join(','))
}

console.log('\n[2] 结构化解析容错')
{
  const clean = parsePrediction('{"headline":"测试结论","confidence":0.72,"domain":"market","horizon":"短期（数天）"}')
  check('裸 JSON 可解析', clean?.headline === '测试结论' && clean.confidence === 0.72, JSON.stringify(clean))

  const fenced = parsePrediction('```json\n{"headline":"围栏结论","confidence":0.4}\n```')
  check('markdown 围栏可解析', fenced?.headline === '围栏结论', JSON.stringify(fenced))

  const noisy = parsePrediction('好的，以下是结果：{"headline":"带噪音","confidence":0.9,"drivers":["a","b"]} 以上。')
  check('前后噪音可解析', noisy?.headline === '带噪音' && noisy.drivers.length === 2, JSON.stringify(noisy))

  check('完全非法输入返回 null', parsePrediction('这不是 JSON') === null)

  const clamped = parsePrediction('{"headline":"越界","confidence":1.8}')
  check('置信度被夹到 [0,1]', clamped?.confidence === 1, String(clamped?.confidence))

  const sparse = parsePrediction('{"headline":"缺字段"}')
  check('缺字段有默认值', sparse && sparse.confidence === 0.5 && Array.isArray(sparse.falsify), JSON.stringify(sparse))

  const strArr = parsePrediction('{"headline":"单值","drivers":"只有一个"}')
  check('字符串被归一成数组', Array.isArray(strArr?.drivers) && strArr.drivers.length === 1)
}

console.log('\n[3] 真实抓取全部数据源（并行，单个失败不影响整体）')
{
  const snap = await fetchSnapshot('天气 汇率 地震 空间天气 卫星 比特币 技术 日照 航天 通胀 空气质量', { all: true })
  check('抓取结果数量与源一致', snap.results.length === SOURCES.length, `${snap.results.length} vs ${SOURCES.length}`)
  const ok = snap.results.filter((r) => r.ok)
  console.log(`\n  接口可用：${ok.length}/${snap.results.length}\n`)
  for (const r of snap.results) {
    const flag = r.ok ? '✓' : '✗'
    const body = r.ok ? r.summary.slice(0, 88) : `失败：${r.error}`
    console.log(`  ${flag} ${r.icon} ${r.name.padEnd(6, '　')} (${String(r.ms).padStart(4)}ms) ${body}`)
  }
  check('至少 8 个接口可用', ok.length >= 8, `仅 ${ok.length} 个`)
  check('可用接口均有非空 summary', ok.every((r) => r.summary && r.summary.length > 5))
  check('snapshotAt 是合法时间', !Number.isNaN(Date.parse(snap.snapshotAt)))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
