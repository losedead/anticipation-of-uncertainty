/**
 * Anticipation of Uncertainty · 后端代理服务
 *
 * 为什么需要它：微博、百度、抖音的热搜接口全部**不带 CORS 头**，
 * 浏览器直连必然被拦；而且它们还要求合法的 User-Agent / Referer，
 * 前端 fetch 无法伪造。所以这一批源只能由服务端代抓：
 * 服务端没有同源策略，可以任意设置请求头。
 *
 * 设计取舍：
 * - **零依赖**，只用 Node 内置模块。部署沙箱不必装任何包，冷启动最快。
 * - **端点白名单**，不做任意 URL 转发 —— 否则就成了公开的 SSRF 跳板。
 * - 单个平台失败只影响它自己，其余照常返回（前端再做一层降级）。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 3000
const TIMEOUT = 12000

// 反爬接口普遍校验这两个头；缺了就是 403 或空响应
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/* ── 白名单端点 ──────────────────────────────────────────── */

const TARGETS = {
  weibo: {
    name: '微博热搜',
    url: 'https://weibo.com/ajax/side/hotSearch',
    referer: 'https://weibo.com/',
    async parse(res) {
      const j = await res.json()
      const list = (j.data && j.data.realtime) || []
      return list
        .map((x, i) => ({
          rank: Number(x.realpos) || i + 1,
          word: String(x.word || '').trim(),
          hot: Number(x.raw_hot || x.num) || null,
          label: String(x.label_name || x.icon_desc || '').trim(),
        }))
        .filter((x) => x.word)
        .slice(0, 10)
    },
  },

  baidu: {
    name: '百度热搜',
    url: 'https://top.baidu.com/board?tab=realtime',
    referer: 'https://top.baidu.com/',
    async parse(res) {
      const html = await res.text()
      // 榜单数据藏在 HTML 注释 <!--s-data:{...}--> 里，是整页唯一的权威来源
      const m = html.match(/<!--s-data:([\s\S]*?)-->/)
      if (!m) throw new Error('页面结构变更：未找到 s-data 数据块')
      const j = JSON.parse(m[1])
      const cards = (j.data && j.data.cards) || []
      const card = cards.find((c) => Array.isArray(c.content) && c.content.length)
      const list = (card && card.content) || []
      return list
        .map((x, i) => ({
          rank: i + 1,
          word: String(x.word || x.query || '').trim(),
          hot: Number(x.hotScore) || null,
          label: String(x.hotTag || '').trim(),
          desc: String(x.desc || '').trim().slice(0, 70),
        }))
        .filter((x) => x.word)
        .slice(0, 10)
    },
  },

  douyin: {
    name: '抖音热点',
    url: 'https://www.douyin.com/aweme/v1/web/hot/search/list/',
    referer: 'https://www.douyin.com/',
    async parse(res) {
      const j = await res.json()
      const list = (j.data && j.data.word_list) || []
      return list
        .map((x, i) => ({
          rank: Number(x.position) || i + 1,
          word: String(x.word || '').trim(),
          hot: Number(x.hot_value) || null,
        }))
        .filter((x) => x.word)
        .slice(0, 10)
    },
  },
}

/**
 * 抓取单个平台。
 *
 * 带 60 秒内存缓存：热搜是分钟级更新的数据，没必要每次请求都去打对方服务器 ——
 * 缓存既能降低被风控（-352 / 空响应）的概率，也让一次预测里的重复调用瞬时返回。
 * 只缓存成功结果，失败下次照常重试。
 */
const CACHE_TTL = 60_000
const cache = new Map()

async function grab(key) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.value, cached: true }

  const t = TARGETS[key]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(t.url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Referer: t.referer,
        Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const items = await t.parse(res)
    if (!items.length) throw new Error('返回空列表')
    const result = { ok: true, name: t.name, items }
    cache.set(key, { at: Date.now(), value: result })
    return result
  } catch (err) {
    return { ok: false, name: t.name, error: String((err && err.message) || err) }
  } finally {
    clearTimeout(timer)
  }
}

/* ── 静态文件 ────────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-cache', ...headers })
  res.end(body)
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return send(res, 400, 'Bad Request')
  }
  const filePath = path.resolve(ROOT, '.' + rel)
  // 目录穿越防护：解析后的绝对路径必须仍在项目根目录内
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden')
  }
  fs.stat(filePath, (err, st) => {
    if (err) return send(res, 404, 'Not Found')
    // 目录请求回落 index.html（`/` 及任何子目录都适用）
    const target = st.isDirectory() ? path.join(filePath, 'index.html') : filePath
    fs.stat(target, (e2, s2) => {
      if (e2 || !s2.isFile()) return send(res, 404, 'Not Found')
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': s2.size,
        'Cache-Control': 'no-cache',
      })
      if (req.method === 'HEAD') return res.end()
      fs.createReadStream(target).pipe(res)
    })
  })
}

/* ── 路由 ────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname

  if (pathname === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, ts: Date.now() }), {
      'Content-Type': 'application/json; charset=utf-8',
    })
  }

  if (pathname === '/api/social') {
    const keys = Object.keys(TARGETS)
    const results = await Promise.all(keys.map(grab))
    const platforms = {}
    keys.forEach((k, i) => (platforms[k] = results[i]))
    const ok = results.some((r) => r.ok)
    return send(res, ok ? 200 : 502, JSON.stringify({ ok, updatedAt: new Date().toISOString(), platforms }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    })
  }

  if (pathname.startsWith('/api/')) {
    return send(res, 404, JSON.stringify({ ok: false, error: 'unknown endpoint' }), {
      'Content-Type': 'application/json; charset=utf-8',
    })
  }

  serveStatic(req, res, pathname)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Anticipation of Uncertainty 已启动 → http://0.0.0.0:${PORT}`)
  console.log(`代理端点：/api/social（${Object.values(TARGETS).map((t) => t.name).join(' / ')}）`)
})
