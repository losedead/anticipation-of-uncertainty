// ─────────────────────────────────────────────────────────────
// 数据接口适配层
//
// 每个源都是一个独立适配器：{ id, name, tags, run() }
// run() 返回 { ok, summary, detail } —— summary 是喂给模型的一行自然语言，
// detail 保留原始结构化数据供界面展示。
//
// 设计原则：多源并行、单源失败不影响整体（Promise.allSettled）、
// 全部走浏览器直连的公开接口（已逐个实测 CORS 可用）。
// 新增数据源只需往 SOURCES 里加一项，不必改动引擎。
//
// 编码注意：腾讯行情（qt.gtimg.cn）返回 GBK，必须走 getText(url, 'gbk')；
// 用 getJSON 会得到乱码。这是唯一需要指定编码的源族。
//
// 两类源：
//   ① 直连源 —— 浏览器直接 fetch 公开 API（已逐个实测 CORS 可用）
//   ② 代理源 —— 目标接口无 CORS 头或校验 UA/Referer（微博/百度/抖音热搜），
//      只能由本站后端 server.js 代抓，走同源 /api/social
// ─────────────────────────────────────────────────────────────
import { DEFAULT_LOCATION } from './config.js'

const TIMEOUT = 12000

/**
 * 代理基址。浏览器里页面与代理同源，用空串即可（拼出来就是 /api/social）；
 * Node 环境（tools/selftest.mjs）没有同源概念，需要绝对地址，可用 WM_BASE 覆盖。
 */
const PROXY_BASE =
  typeof window !== 'undefined' ? '' : globalThis.process?.env?.WM_BASE || 'http://127.0.0.1:8787'

/**
 * 所有抓取统一带 referrerPolicy: 'no-referrer'。
 *
 * 这不是可选项，是必需的：东方财富的 np-* 系列接口做了 Referer 防盗链——
 * 带 Origin 且 Referer 来自非 eastmoney 域时，响应里会被剥掉
 * Access-Control-Allow-Origin，浏览器直接报 MissingAllowOriginHeader，请求失败。
 * 而浏览器跨域 fetch 默认必带 Referer，所以必须显式关掉。
 * （curl 单测能过、浏览器却失败，根源就在这里。）
 */
const FETCH_OPTS = { referrerPolicy: 'no-referrer' }

/**
 * 带超时与重试的 JSON 抓取。
 * 接口分布在多个大洲、偶发慢响应，重试一次能显著压低"整源失败"的概率。
 */
async function getJSON(url, ms = TIMEOUT, retries = 1) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), ms)
    try {
      const res = await fetch(url, {
        ...FETCH_OPTS,
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastError = err
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

/**
 * 带超时与重试的文本抓取（支持指定编码）。
 * 腾讯行情接口返回 GBK，用 res.json()/res.text() 会得到乱码——
 * 必须走 arrayBuffer + TextDecoder，且 TextDecoder 不支持该编码时退回 UTF-8 而不是崩掉。
 */
async function getText(url, encoding = 'utf-8', ms = TIMEOUT, retries = 1) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), ms)
    try {
      const res = await fetch(url, { ...FETCH_OPTS, signal: ctrl.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      try {
        return new TextDecoder(encoding).decode(buf)
      } catch {
        return new TextDecoder('utf-8').decode(buf)
      }
    } catch (err) {
      lastError = err
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

const WMO = {
  0: '晴', 1: '少云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨', 56: '冻毛毛雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
}

/* ── 各数据源适配器 ─────────────────────────────────────── */

export const SOURCES = [
  {
    id: 'time',
    name: '时标',
    icon: '🕐',
    tags: ['时间', '今天', '日期', '季节'],
    core: true,
    async run() {
      const now = new Date()
      const dayOfYear = Math.ceil((now - new Date(now.getFullYear(), 0, 0)) / 86400000)
      const summary = `当前时刻 ${now.toLocaleString('zh-CN', { hour12: false })}（东八区），年内第 ${dayOfYear} 天。`
      return { ok: true, summary, detail: { iso: now.toISOString(), dayOfYear } }
    },
  },

  {
    id: 'weather',
    name: '地面天气',
    icon: '🌤',
    tags: ['天气', '气温', '温度', '下雨', '降雨', '台风', '冷', '热', '出行', '气候', '农业', '洪水', '干旱', '风'],
    core: true,
    async run({ location = DEFAULT_LOCATION }) {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&timezone=auto&forecast_days=5`
      const d = await getJSON(url)
      const c = d.current
      const daily = d.daily
      const days = (daily?.time || []).map((t, i) => ({
        date: t,
        max: daily.temperature_2m_max[i],
        min: daily.temperature_2m_min[i],
        rain: daily.precipitation_sum[i],
        code: daily.weather_code[i],
      }))
      const summary =
        `${location.label}当前：${WMO[c.weather_code] || '未知'}，气温 ${c.temperature_2m}℃（体感 ${c.apparent_temperature}℃），` +
        `湿度 ${c.relative_humidity_2m}%，风速 ${c.wind_speed_10m}km/h，降水 ${c.precipitation}mm。` +
        `未来 5 天：` +
        days.map((x) => `${x.date} ${WMO[x.code] || ''} ${x.min}~${x.max}℃ 雨${x.rain}mm`).join('；')
      return { ok: true, summary, detail: { current: c, days } }
    },
  },

  {
    id: 'air',
    name: '空气质量',
    icon: '🫁',
    tags: ['空气', '污染', '雾霾', 'pm2.5', '健康', '呼吸'],
    async run({ location = DEFAULT_LOCATION }) {
      const url =
        `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${location.latitude}&longitude=${location.longitude}` +
        `&current=pm2_5,pm10,us_aqi&timezone=auto`
      const d = await getJSON(url)
      const c = d.current
      const grade = c.us_aqi <= 50 ? '优' : c.us_aqi <= 100 ? '良' : c.us_aqi <= 150 ? '轻度污染' : c.us_aqi <= 200 ? '中度污染' : '重度污染'
      return {
        ok: true,
        summary: `${location.label}空气质量：AQI ${c.us_aqi}（${grade}），PM2.5 ${c.pm2_5}μg/m³，PM10 ${c.pm10}μg/m³。`,
        detail: c,
      }
    },
  },

  {
    id: 'fx',
    name: '外汇牌价',
    icon: '💱',
    tags: ['汇率', '美元', '人民币', '外汇', '货币', '出口', '进口', '外贸', '欧', '日元'],
    async run() {
      // 双通道：主通道失败即切换备用，避免单点抖动整源不可用
      let rates
      let updated
      try {
        const d = await getJSON('https://open.er-api.com/v6/latest/USD', 8000, 0)
        rates = d.rates || {}
        updated = d.time_last_update_utc
      } catch {
        const d = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD', 9000, 1)
        rates = d.rates || {}
        updated = d.date
      }
      const summary =
        `1 美元 = ${rates.CNY ?? '—'} 人民币；反推 1 人民币 ≈ ${rates.CNY ? (1 / rates.CNY).toFixed(6) : '—'} 美元，` +
        `≈ ${rates.EUR ? (1 / rates.EUR).toFixed(6) : '—'} 欧元，≈ ${rates.JPY ? (1 / rates.JPY).toFixed(6) : '—'} 日元。`
      return {
        ok: true,
        summary,
        detail: { base: 'USD', usdCny: rates.CNY, eur: rates.EUR, jpy: rates.JPY, updated },
      }
    },
  },

  {
    id: 'quake',
    name: '地震活动',
    icon: '🌐',
    tags: ['地震', '地质', '灾害', '板块', '海啸', '火山'],
    async run() {
      const d = await getJSON(
        'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=8&orderby=time&minmagnitude=4.5'
      )
      const list = (d.features || []).map((f) => ({
        mag: f.properties.mag,
        place: f.properties.place,
        time: new Date(f.properties.time).toISOString().slice(0, 16).replace('T', ' '),
        depth: f.geometry?.coordinates?.[2],
      }))
      const summary = list.length
        ? `近 24 小时内全球 M4.5 以上地震 ${list.length} 次：` +
          list.slice(0, 5).map((q) => `M${q.mag} ${q.place}（${q.time} UTC，深 ${Math.round(q.depth)}km）`).join('；')
        : '近 24 小时内全球无 M4.5 以上地震记录。'
      return { ok: true, summary, detail: { quakes: list } }
    },
  },

  {
    id: 'space',
    name: '空间天气',
    icon: '🛰',
    tags: ['地磁', '太阳', '极光', '空间天气', '卫星', '通信', '电网', '辐射'],
    async run() {
      const kp = await getJSON('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json')
      const last = Array.isArray(kp) && kp.length ? kp[kp.length - 1] : null
      if (!last) throw new Error('无 Kp 数据')
      const v = Number(last.kp_index)
      const level = v >= 7 ? '强磁暴' : v >= 5 ? '磁暴' : v >= 4 ? '活跃' : '平静'
      return {
        ok: true,
        summary: `行星地磁指数 Kp = ${v}（${level}）。Kp≥5 即为磁暴，可能影响卫星通信、电网与高纬极光。`,
        detail: { kp: v, level, at: last.time_tag },
      }
    },
  },

  {
    id: 'orbit',
    name: '在轨目标',
    icon: '🚀',
    tags: ['卫星', '轨道', '空间站', '航天', '空间'],
    async run() {
      const d = await getJSON('https://api.wheretheiss.at/v1/satellites/25544')
      return {
        ok: true,
        summary: `国际空间站当前位于北纬 ${Number(d.latitude).toFixed(2)}°、东经 ${Number(d.longitude).toFixed(2)}°，高度 ${Math.round(d.altitude)}km，速度 ${Math.round(d.velocity)}km/h。`,
        detail: { lat: d.latitude, lon: d.longitude, alt: d.altitude, vel: d.velocity },
      }
    },
  },

  {
    id: 'btc',
    name: '比特币链上',
    icon: '⛓',
    tags: ['加密', '比特币', '区块链', '币', '数字货币', '挖矿'],
    async run() {
      const [height, fees] = await Promise.all([
        getJSON('https://mempool.space/api/blocks/tip/height'),
        getJSON('https://mempool.space/api/v1/fees/recommended').catch(() => null),
      ])
      const summary =
        `比特币当前区块高度 ${height}（约每 10 分钟一个块）。` +
        (fees ? `推荐手续费：最快 ${fees.fastestFee} sat/vB，经济 ${fees.economyFee} sat/vB。` : '')
      return { ok: true, summary, detail: { height, fees } }
    },
  },

  {
    id: 'tech',
    name: '技术热榜',
    icon: '💡',
    tags: ['技术', '科技', 'ai', '人工智能', '创业', '编程', '开源', '计算机', '软件', '算法', '大模型', '芯片', '互联网'],
    core: true,
    async run() {
      // 双通道：社区热榜（HN）+ 开源动向（GitHub 近 30 天高星新库）。任一失败仍有半份数据。
      const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      const [hn, gh] = await Promise.all([
        (async () => {
          const ids = await getJSON('https://hacker-news.firebaseio.com/v0/topstories.json')
          const items = await Promise.all(
            (ids || []).slice(0, 5).map((id) => getJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null))
          )
          return items.filter(Boolean).map((i) => i.title)
        })().catch(() => []),
        getJSON(`https://api.github.com/search/repositories?q=created:%3E${since}&sort=stars&order=desc&per_page=5`)
          .then((d) => (d?.items || []).map((r) => `${r.full_name}（★${r.stargazers_count}）`))
          .catch(() => []),
      ])
      const parts = []
      if (hn.length) parts.push(`Hacker News 热榜：${hn.map((t) => `「${t}」`).join('、')}`)
      if (gh.length) parts.push(`GitHub 近 30 天高星新项目：${gh.join('、')}`)
      if (!parts.length) throw new Error('技术类接口均未返回数据')
      return { ok: true, summary: parts.join('；') + '。', detail: { hn, gh } }
    },
  },

  {
    id: 'sun',
    name: '日照窗口',
    icon: '🌅',
    tags: ['日照', '日出', '日落', '白天', '作息', '光照', '光伏'],
    async run({ location = DEFAULT_LOCATION }) {
      const d = await getJSON(
        `https://api.sunrise-sunset.org/json?lat=${location.latitude}&lng=${location.longitude}&formatted=0`
      )
      const r = d.results
      const hhmm = (iso) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      const hours = (r.day_length / 3600).toFixed(2)
      return {
        ok: true,
        summary: `${location.label}今日日出 ${hhmm(r.sunrise)}、日落 ${hhmm(r.sunset)}，昼长 ${hours} 小时。`,
        detail: { sunrise: r.sunrise, sunset: r.sunset, dayLength: r.day_length },
      }
    },
  },

  {
    id: 'spaceflight',
    name: '航天动态',
    icon: '📡',
    tags: ['航天', '火箭', '发射', '太空', 'nasa', '轨道'],
    async run() {
      const d = await getJSON('https://api.spaceflightnewsapi.net/v4/articles/?limit=3')
      const list = (d.results || []).map((a) => ({
        title: a.title,
        published: (a.published_at || '').slice(0, 10),
        site: a.news_site,
      }))
      return {
        ok: true,
        summary: list.length
          ? `近期航天要闻：${list.map((a) => `「${a.title}」（${a.site} ${a.published}）`).join('；')}`
          : '暂无航天动态。',
        detail: { articles: list },
      }
    },
  },

  {
    id: 'macro',
    name: '宏观指标',
    icon: '📊',
    tags: ['经济', '通胀', 'cpi', 'ppi', 'gdp', '宏观', '增长', '物价', '就业', '货币', '利率', '社融', 'pmi', '财政'],
    async run() {
      // 主通道：国家统计局口径月度 CPI（经东方财富数据中心），时效性远好于世界银行年度值。
      try {
        const d = await getJSON(
          'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_CPI&pageSize=4&sortColumns=REPORT_DATE&sortTypes=-1&columns=ALL',
          9000,
          1
        )
        const rows = d?.result?.data || []
        if (!rows.length) throw new Error('无 CPI 数据')
        const last = rows[0]
        const summary =
          `中国 CPI（国家统计局口径）：${last.TIME} 同比 ${last.NATIONAL_SAME}%、环比 ${last.NATIONAL_SEQUENTIAL}%、累计 ${last.NATIONAL_ACCUMULATE}。` +
          (rows.length > 1 ? `前值：${rows.slice(1).map((r) => `${r.TIME} 同比 ${r.NATIONAL_SAME}%`).join('、')}。` : '')
        return { ok: true, summary, detail: { cpi: rows } }
      } catch (primaryError) {
        // 回落：世界银行年度口径。明确标注口径差异，不让模型把年度值当月度用。
        const d = await getJSON('https://api.worldbank.org/v2/country/CN/indicator/FP.CPI.TOTL.ZG?format=json&per_page=6', TIMEOUT, 2)
        const rows = (Array.isArray(d) ? d[1] : null) || []
        const valid = rows.filter((r) => r.value != null).sort((a, b) => Number(b.date) - Number(a.date)).slice(0, 3)
        if (!valid.length) throw primaryError
        return {
          ok: true,
          summary:
            '中国年度通胀率（世界银行年度口径，月度数据不可用时的回落）：' +
            valid.map((r) => `${r.date} 年 ${Number(r.value).toFixed(2)}%`).join('、') + '。',
          detail: { series: valid, fallback: true },
        }
      }
    },
  },

  {
    id: 'market',
    name: '金融市场',
    icon: '📈',
    tags: ['股票', '股市', '股', '上证', '深证', '创业板', '沪深', '恒生', '港股', '美股', '纳斯达克', '道琼斯', '标普', '指数', '大盘',
      '行情', '牛市', '熊市', '金融', '证券', 'a股', '资金', '板块', '估值'],
    core: true,
    async run() {
      const codes = ['sh000001', 'sz399001', 'sz399006', 'sh000300', 'hkHSI', 'usDJI', 'usIXIC', 'usINX']
      const text = await getText(`https://qt.gtimg.cn/q=${codes.join(',')}`, 'gbk')
      const rows = []
      // 格式：v_代码="市场~名称~代码~现价~昨收~今开~…~时间~涨跌~涨跌幅~最高~最低~…"
      for (const m of text.matchAll(/v_([A-Za-z0-9]+)="([^"]*)"/g)) {
        const f = m[2].split('~')
        if (f.length < 33) continue
        rows.push({
          code: m[1],
          name: f[1],
          price: Number(f[3]),
          prevClose: Number(f[4]),
          change: Number(f[31]),
          pct: Number(f[32]),
          high: Number(f[33]),
          low: Number(f[34]),
          at: f[30],
        })
      }
      if (!rows.length) throw new Error('行情接口未返回数据')
      const fmt = (r) => `${r.name} ${r.price}（${r.pct >= 0 ? '+' : ''}${r.pct}%）`
      const seg = (label, arr) => (arr.length ? `${label}：${arr.map(fmt).join('、')}` : '')
      const summary =
        [
          seg('A股收盘', rows.filter((r) => /^s[hz]/.test(r.code))),
          seg('港股', rows.filter((r) => /^hk/.test(r.code))),
          seg('美股前收盘', rows.filter((r) => /^us/.test(r.code))),
        ]
          .filter(Boolean)
          .join('；') + `。行情时间 ${rows[0]?.at || '—'}。`
      return { ok: true, summary, detail: { rows } }
    },
  },

  {
    id: 'futures',
    name: '国际期货',
    icon: '🛢',
    tags: ['期货', '大宗', '原油', '黄金', '白银', '铜', '玉米', '商品', '油价', '金价', '贵金属', '有色', '避险', '通胀'],
    async run() {
      const codes = ['hf_CL', 'hf_GC', 'hf_SI', 'hf_HG', 'hf_C']
      const text = await getText(`https://qt.gtimg.cn/q=${codes.join(',')}`, 'gbk')
      const rows = []
      // 格式：v_hf_XX="现价,涨跌幅%,买价,卖价,最高,最低,时间,昨收,今开,…,日期,中文名"
      for (const m of text.matchAll(/v_(hf_[A-Za-z]+)="([^"]*)"/g)) {
        const f = m[2].split(',')
        if (f.length < 14) continue
        rows.push({
          code: m[1],
          name: f[13],
          price: Number(f[0]),
          pct: Number(f[1]),
          high: Number(f[4]),
          low: Number(f[5]),
          prevClose: Number(f[7]),
          at: `${f[12]} ${f[6]}`,
        })
      }
      if (!rows.length) throw new Error('期货接口未返回数据')
      const summary =
        '国际大宗商品近月合约：' +
        rows.map((r) => `${r.name} ${r.price}（${r.pct >= 0 ? '+' : ''}${r.pct}%，${r.low}~${r.high}）`).join('、') +
        `。数据时间 ${rows[0]?.at || '—'}。`
      return { ok: true, summary, detail: { rows } }
    },
  },

  {
    id: 'policy',
    name: '政策要闻',
    icon: '📜',
    tags: ['政策', '监管', '国务院', '发改委', '央行', '商务部', '法规', '条例', '改革', '补贴', '关税', '两会', '财政',
      '货币政策', '产业政策', '文件', '调控', '反倾销', '制裁'],
    async run() {
      const d = await getJSON(
        'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=345&order=1&needInteractData=0&page_index=1&page_size=8&req_trace=1'
      )
      const items = (d?.data?.list || []).map((x) => ({
        title: x.title,
        time: x.showTime,
        media: x.mediaName || '',
        url: x.url,
      }))
      if (!items.length) throw new Error('政策接口未返回数据')
      const summary =
        '近期政策与要闻（东方财富财经导读）：' +
        items.slice(0, 5).map((x) => `「${x.title}」（${x.media || '来源未标注'} ${x.time || ''}）`).join('；') + '。'
      return { ok: true, summary, detail: { items } }
    },
  },

  {
    id: 'hot',
    name: '实时热点',
    icon: '🔥',
    tags: ['热点', '热搜', '新闻', '舆论', '社会', '事件', '当下', '最近', '热议', '趋势', '话题', '大众', '媒体'],
    async run() {
      const d = await getJSON(
        'https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=12&req_trace=1'
      )
      const items = (d?.data?.fastNewsList || []).map((x) => ({ title: x.title, time: x.showTime }))
      if (!items.length) throw new Error('快讯接口未返回数据')
      const summary =
        '7×24 小时快讯（时间倒序）：' +
        items.slice(0, 6).map((x) => `[${(x.time || '').slice(11, 16)}] ${x.title}`).join('；') + '。'
      return { ok: true, summary, detail: { items } }
    },
  },

  {
    id: 'social',
    name: '社交热榜',
    icon: '📱',
    via: 'proxy',
    tags: ['微博', '百度', '抖音', '热搜', '热搜榜', '榜单', '社交', '舆情', '民意', '大众', '网民',
      '话题', '流行', '爆款', '刷屏', '破圈', '年轻人', '网络'],
    async run() {
      // 走本站后端代理：这三个平台的热搜接口不带 CORS 头、且校验 UA/Referer，
      // 浏览器直连必被拦，只能由服务端代抓（见项目根目录 server.js）。
      let d
      try {
        d = await getJSON(`${PROXY_BASE}/api/social`, TIMEOUT, 1)
      } catch {
        throw new Error('后端代理不可达（该源需要站点以 Node 服务方式部署）')
      }
      const parts = []
      const detail = {}
      for (const key of ['weibo', 'baidu', 'douyin']) {
        const v = d?.platforms?.[key]
        if (!v?.ok || !v.items?.length) continue
        detail[key] = { name: v.name, items: v.items }
        parts.push(`${v.name}：${v.items.slice(0, 5).map((x) => x.word).join('、')}`)
      }
      if (!parts.length) throw new Error('三个平台均未返回数据')
      const at = d.updatedAt ? new Date(d.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''
      return {
        ok: true,
        summary: `全网社交平台当前热议${at ? `（${at}）` : ''} —— ${parts.join('；')}。`,
        detail,
      }
    },
  },

  {
    id: 'company',
    name: '公司公告',
    icon: '🏢',
    tags: ['公司', '上市公司', '公告', '财报', '业绩', '并购', '重组', '分红', '回购', '股东', '企业', 'ipo', '上市', '减持', '增持'],
    async run() {
      const d = await getJSON(
        'https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=10&page_index=1&ann_type=A&client_source=web&f_node=0&s_node=0'
      )
      const items = (d?.data?.list || []).map((x) => ({
        title: x.title,
        stock: x.codes?.[0]?.short_name || '未标注',
        code: x.codes?.[0]?.stock_code || '',
        column: x.columns?.[0]?.column_name || '公告',
        date: (x.notice_date || x.display_time || '').slice(0, 10),
      }))
      if (!items.length) throw new Error('公告接口未返回数据')
      const summary =
        '最新 A 股上市公司公告：' +
        items.slice(0, 6).map((x) => `${x.stock}(${x.code})〔${x.column}〕「${x.title}」${x.date}`).join('；') + '。'
      return { ok: true, summary, detail: { items } }
    },
  },
]

/* ── 路由与抓取 ─────────────────────────────────────────── */

/** 按问题关键词挑选相关数据源；未命中任何关键词时回落到核心源 */
export function selectSources(question, { all = false } = {}) {
  if (all) return SOURCES
  const q = (question || '').toLowerCase()
  const hit = new Set()
  let keywordHits = 0
  for (const s of SOURCES) {
    if (s.core) hit.add(s.id)
    if (s.tags.some((t) => q.includes(t.toLowerCase()))) {
      hit.add(s.id)
      keywordHits++
    }
  }
  // 关键词命中太少（问题太笼统）时补背景源，保证"世界状态"有厚度。
  // 注意判据用 keywordHits 而不是 hit.size —— 核心源自带 4 个，
  // 用 hit.size 判断会让这个兜底永远不触发。
  if (keywordHits <= 1) {
    hit.add('hot')
    hit.add('policy')
    hit.add('social')
    hit.add('spaceflight')
  }
  return SOURCES.filter((s) => hit.has(s.id))
}

/**
 * 并行抓取。返回 { results, snapshotAt }
 * 单个源失败只记录错误，不抛出。
 */
export async function fetchSnapshot(question, opts = {}) {
  const picked = selectSources(question, opts)
  const settled = await Promise.allSettled(
    picked.map(async (s) => {
      const t0 = performance.now()
      const r = await s.run(opts)
      return {
        id: s.id,
        name: s.name,
        icon: s.icon,
        ok: !!(r && r.ok),
        summary: r?.summary || '',
        detail: r?.detail ?? null,
        ms: Math.round(performance.now() - t0),
      }
    })
  )

  const results = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    return {
      id: picked[i].id,
      name: picked[i].name,
      icon: picked[i].icon,
      ok: false,
      summary: '',
      error: r.reason?.message || '抓取失败',
      ms: 0,
    }
  })

  return { results, snapshotAt: new Date().toISOString() }
}
