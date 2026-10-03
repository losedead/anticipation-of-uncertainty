// ─────────────────────────────────────────────────────────────
// 应用主逻辑：路由 / 四视图 / 预测流程
// ─────────────────────────────────────────────────────────────
import { getCloud, describeError } from './cloud.js'
import { DEFAULT_LOCATION, DAILY_QUESTION_LIMIT, MAX_QUESTION_CHARS } from './config.js'
import { LOGOMARK, brandBlock } from './brand.js'
import * as Auth from './auth.js'
import * as Store from './store.js'
import { fetchSnapshot, SOURCES } from './datasources.js'
import { runPrediction } from './engine.js'
import { summarize, isJudged, daysUntil, VERDICTS, computeDueAt, normalizeHorizonDays } from './metrics.js'

const $ = (sel, el = document) => el.querySelector(sel)
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel))

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/* ── 对话框与轻提示 ─────────────────────────────────────────
   原生 confirm() / alert() 无法控制样式，在精心排版的页面里非常突兀，
   而且会阻塞渲染线程。统一换成自建组件，行为一致、可键盘操作。 */

/** 确认框。返回 Promise<boolean>。 */
function confirmDialog({ title, body = '', confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal modal-narrow" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button type="button" class="modal-x" data-close aria-label="关闭">✕</button>
        </div>
        <div class="modal-body">
          ${body ? `<p class="cf-body">${esc(body)}</p>` : ''}
          <div class="cf-actions">
            <button type="button" class="btn ghost" data-no>取消</button>
            <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(confirmText)}</button>
          </div>
        </div>
      </div>`
    document.body.appendChild(overlay)

    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      resolve(v)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') done(false)
      if (e.key === 'Enter') done(true)
    }
    document.addEventListener('keydown', onKey)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(false)
    })
    $('[data-close]', overlay).onclick = () => done(false)
    $('[data-no]', overlay).onclick = () => done(false)
    $('[data-yes]', overlay).onclick = () => done(true)
    $('[data-yes]', overlay).focus()
  })
}

/** 轻提示，替代 alert()。不阻塞交互，几秒后自动消失。 */
function toast(message, kind = 'error') {
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  el.textContent = message
  document.body.appendChild(el)
  requestAnimationFrame(() => el.classList.add('show'))
  setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.remove(), 300)
  }, 4000)
}

const PRESET_CITIES = [
  DEFAULT_LOCATION,
  { label: '重庆 · 主城', latitude: 29.563, longitude: 106.551 },
  { label: '北京', latitude: 39.904, longitude: 116.407 },
  { label: '上海', latitude: 31.230, longitude: 121.474 },
  { label: '广州', latitude: 23.129, longitude: 113.264 },
  { label: '成都', latitude: 30.573, longitude: 104.067 },
  { label: '西安', latitude: 34.341, longitude: 108.940 },
  { label: '武汉', latitude: 30.593, longitude: 114.306 },
  { label: '纽约', latitude: 40.713, longitude: -74.006 },
  { label: '伦敦', latitude: 51.507, longitude: -0.128 },
  { label: '东京', latitude: 35.690, longitude: 139.692 },
]

const MEMORY_CATEGORIES = [
  { id: 'identity', label: '身份背景' },
  { id: 'interest', label: '兴趣关注' },
  { id: 'goal', label: '目标计划' },
  { id: 'constraint', label: '约束条件' },
  { id: 'general', label: '其他' },
]

const EXAMPLES = [
  '未来三个月全球地磁活动会不会影响卫星通信？',
  '接下来两周重庆万州的天气趋势如何，适合户外安排吗？',
  '人民币对美元的汇率在未来一个月会怎么走？',
  '当前技术社区在热炒的方向，三个月后会留在主流视野里吗？',
]

const state = {
  user: null,
  profile: null,
  memories: [],
  predictions: [],
  location: DEFAULT_LOCATION,
  view: 'predict',
  running: false,
  controller: null,
  // 今日已用提问次数（服务端计数）。全站共享站点所有者的云服务额度，
  // 所以每次提问前要先过这道闸。
  todayUsed: 0,
  // 列表是否被上限截断（用于如实告知用户看到的不是全部）
  truncated: { memories: false, predictions: false },
  // 公开模式：未登录访客可浏览介绍页，其余视图与一切写操作仍需登录。
  // 目的是让陌生人在交出邮箱之前先看懂这个产品，而不是撞上一堵登录墙。
  public: false,
}

/* ── 启动 ───────────────────────────────────────────────── */

/** 全屏登录 / 注册页，覆盖整个应用外壳 */
function showAuth() {
  state.public = false
  $('#app-root').classList.add('hidden')
  const authRoot = $('#auth-root')
  authRoot.classList.remove('hidden')
  Auth.renderAuthView(authRoot, {
    onSignedIn: async (user) => {
      state.user = user
      await enterApp()
    },
  })
}

/** 公开落地页：未登录也能读完整个介绍页，所有 CTA 一律引导到登录 */
function showLanding() {
  state.public = true
  state.view = 'intro'
  $('#auth-root').classList.add('hidden')
  $('#app-root').classList.remove('hidden')
  renderShell()
  renderView()
}

async function boot() {
  const authRoot = $('#auth-root')
  const appRoot = $('#app-root')

  // SDK 是否就绪
  try {
    getCloud()
  } catch (err) {
    authRoot.innerHTML = `<div class="auth-card auth-card-solo">
      <div class="brand brand-lg"><span class="brand-mark">${LOGOMARK}</span>
      <span class="brand-text"><b>Anticipation of Uncertainty</b><i>UNCERTAINTY FORECASTING</i></span></div>
      <p class="auth-msg error">${esc(err.message)}</p></div>`
    authRoot.classList.remove('hidden')
    return
  }

  try {
    const session = await Auth.getSession()
    if (session?.user) {
      state.user = session.user
      await enterApp()
    } else {
      // 没登录不再直接甩登录墙——先让访客把产品看明白
      showLanding()
    }
  } catch (err) {
    appRoot.classList.add('hidden')
    authRoot.classList.remove('hidden')
    authRoot.innerHTML = `<div class="auth-card auth-card-solo">
      <div class="brand brand-lg"><span class="brand-mark">${LOGOMARK}</span>
      <span class="brand-text"><b>Anticipation of Uncertainty</b><i>UNCERTAINTY FORECASTING</i></span></div>
      <p class="auth-msg error">初始化失败：${esc(describeError(err))}</p></div>`
  }

  // 登录页左栏的「介绍页」链接 → 未登录时回到公开落地页
  window.addEventListener('aou:show-intro', () => {
    if (!state.user) showLanding()
  })

  Auth.onAuthChange((event) => {
    if (event === 'SIGNED_OUT') {
      state.user = null
      state.memories = []
      state.predictions = []
      state.profile = null
      showLanding()
    }
  })
}

async function enterApp() {
  state.public = false
  $('#auth-root').classList.add('hidden')
  $('#app-root').classList.remove('hidden')
  renderShell()
  await loadData()
  renderView()
}

async function loadData() {
  try {
    const [profile, memories, predictions, todayUsed] = await Promise.all([
      Store.getProfile().catch(() => null),
      Store.listMemories().catch(() => []),
      Store.listPredictions().catch(() => []),
      Store.countTodayPredictions().catch(() => 0),
    ])
    state.profile = profile
    state.memories = memories
    state.todayUsed = todayUsed
    // 列表有上限，超过就必须说出来。静默截断会让人以为看到的是全部——
    // 一个以"诚实标注"为卖点的工具，自己不能在数据完整性上撒谎。
    state.truncated = {
      memories: memories.length >= 200,
      predictions: predictions.length >= 100,
    }
    // 加复盘功能之前的历史记录没有 due_at，按创建时间+时域现算一个虚拟截止日，
    // 这样它们也能进入复盘队列，不必回填数据。
    state.predictions = predictions.map((p) =>
      p.due_at ? p : { ...p, due_at: computeDueAt(p.created_at, p.horizon_days, p.horizon).toISOString() }
    )
    const loc = profile?.prefs?.location
    state.location = loc && loc.latitude != null ? loc : DEFAULT_LOCATION
  } catch (err) {
    console.warn('[aou] 数据加载失败', describeError(err))
  }
}

/* ── 外壳 ───────────────────────────────────────────────── */

const NAV = [
  { id: 'predict', label: '预测台', icon: '◈' },
  { id: 'archive', label: '档案', icon: '▤' },
  { id: 'memory', label: '记忆', icon: '❖' },
  { id: 'intro', label: '介绍', icon: '✦' },
  { id: 'me', label: '我的', icon: '◍' },
]

function renderShell() {
  // 公开模式：顶栏只留「产品介绍」和一个登录入口。
  // 不给访客看到自己点不动的按钮——点了就弹登录，比放着好看但报错要诚实。
  if (state.public) {
    $('#app-root').innerHTML = `
      <header class="topbar">
        <div class="topbar-inner">
          ${brandBlock({ size: 'sm' })}
          <nav class="nav" id="nav">
            <button type="button" class="nav-item active" data-view="intro"><span>✦</span>产品介绍</button>
          </nav>
          <button type="button" class="btn primary nav-signin" id="nav-signin">登录 / 注册</button>
        </div>
      </header>
      <main class="main" id="main"></main>
    `
    $('#nav-signin').onclick = () => showAuth()
    return
  }

  const email = state.user?.email || ''
  const masked = email ? email.replace(/^(.{2}).*(@.*)$/, '$1****$2') : '已登录'

  $('#app-root').innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        ${brandBlock({ size: 'sm' })}
        <nav class="nav" id="nav">
          ${NAV.map((n) => `<button type="button" class="nav-item" data-view="${n.id}"><span>${n.icon}</span>${n.label}<i class="nav-dot hidden" data-dot="${n.id}"></i></button>`).join('')}
        </nav>
        <div class="user-chip" title="${esc(email)}">
          <span class="dot"></span><span class="user-mail">${esc(masked)}</span>
        </div>
      </div>
    </header>
    <main class="main" id="main"></main>
  `

  $$('#nav .nav-item').forEach((b) => {
    b.onclick = () => {
      if (state.running) return
      state.view = b.dataset.view
      renderView()
    }
  })
}

function renderView() {
  // 公开模式下只允许看介绍页。这里是最后一道闸：即便有人手动改 state.view
  // 或构造 data-goto，也进不到需要登录的视图。
  if (state.public && state.view !== 'intro') state.view = 'intro'

  $$('#nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view))
  // 待复盘角标：到期该核对的事主动找上来，而不是等人想起来
  const dueCount = summarize(state.predictions).due
  const dot = $('[data-dot="archive"]')
  if (dot) {
    dot.textContent = dueCount ? String(dueCount) : ''
    dot.classList.toggle('hidden', !dueCount)
  }
  const main = $('#main')
  if (state.view === 'predict') renderPredict(main)
  else if (state.view === 'archive') renderArchive(main)
  else if (state.view === 'memory') renderMemory(main)
  else if (state.view === 'intro') renderIntro(main)
  else renderMe(main)
  // 回到页首。不能用 main.scrollIntoView —— 顶栏是 sticky 的，会把页面标题压在顶栏下面
  window.scrollTo({ top: 0 })
}

/* ── 视图一：预测台 ─────────────────────────────────────── */

/* ── 视图：产品介绍 ─────────────────────────────────────── */

/** 数据源分类（仅用于介绍页展示；抓取逻辑仍由 datasources 的关键词路由决定） */
const SOURCE_GROUPS = [
  { title: '时间与基准', ids: ['time'], note: '给所有推断一个共同的时间原点' },
  { title: '地球与环境', ids: ['weather', 'air', 'quake', 'sun'], note: '本地与全球的物理状态' },
  { title: '天文与航天', ids: ['space', 'orbit', 'spaceflight'], note: '空间天气与在轨目标' },
  { title: '金融与市场', ids: ['fx', 'market', 'futures', 'macro', 'btc', 'company'], note: '价格、宏观与公司事件' },
  { title: '社会与舆论', ids: ['policy', 'hot', 'social', 'tech'], note: '政策风向与公共注意力' },
]

function bindGoto(root) {
  $$('[data-goto]', root).forEach((b) => {
    b.onclick = () => {
      // 公开模式下这些按钮指向的全是要登录才能用的地方 → 直接引导登录，
      // 而不是跳过去再弹一个错误
      if (state.public) return showAuth()
      state.view = b.dataset.goto
      renderView()
    }
  })
}

const INTRO_FIELDS = [
  ['一句话结论', '写到第三方能明确判定「应验 / 未应验」的程度，不出现「或将」「不排除」这类无法判定的措辞。'],
  ['置信度', '0–1 的诚实标定。0.5 表示接近抛硬币。低置信度是诚实，虚高才是问题。'],
  ['可预测时域', '这套系统最多能往前看多久、为什么——上限由混沌与反身性决定，不是由态度决定。'],
  ['驱动变量', '真正决定结果的三到五个量，其余都是噪声。'],
  ['核心机制', '从驱动变量推到结果的因果链条，一到两句。'],
  ['不确定性来源', '内在涨落、认知缺口、社交不确定性，三者性质不同，分别标出。'],
  ['反身性', '若这条预测会被读到并据此行动，它将如何改变自己的结果。'],
  ['边界声明', '一句话说清这条判断在什么范围内成立、什么情况下不适用，以及它不是什么。'],
]

const INTRO_REASONS = [
  ['尺度分离', '手上的数据是一个尺度，目标问题是另一个尺度。跨尺度外推时误差会被放大，不能假装衔接得上。'],
  ['涌现', '宏观规律未必能从微观细节推出。看不到的细节，不许假装知道。'],
  ['混沌', '初值敏感的系统存在可预测时域上限。超过上限只能给统计陈述，绝不能给确定预言。'],
  ['反身性', '若被预测的系统会读到预测并据此行动，预测会自我实现或自我否定。涉及人群、市场、舆论、政策时必须明说。'],
]

const INTRO_FLOW = [
  ['理解问题', '按关键词判断这属于哪一类系统，决定该取哪些数据。'],
  ['抓取世界状态', '并行调用命中的数据源，单点失败不中断；每条来源与耗时如实列出。'],
  ['拼装上下文', '实时数据 + 你的长期记忆 + 观测位置，一起进入推理。'],
  ['结构化推演', '按四元组建模，逐条自查四条边界，输出结构化判断。'],
  ['落库待复盘', '写入档案并设定复盘日。到期由你判定应验与否，进入校准统计。'],
]

function renderIntro(main) {
  const pub = state.public
  const byId = new Map(SOURCES.map((s) => [s.id, s]))
  const used = new Set()
  const groups = SOURCE_GROUPS.map((g) => {
    const items = g.ids.map((id) => byId.get(id)).filter(Boolean)
    items.forEach((s) => used.add(s.id))
    return { ...g, items }
  }).filter((g) => g.items.length)
  const rest = SOURCES.filter((s) => !used.has(s.id))
  if (rest.length) groups.push({ title: '其他', note: '补充维度', items: rest })

  const coreCount = SOURCES.filter((s) => s.core).length

  main.innerHTML = `
    <section class="hero intro-hero">
      <p class="kicker"><span class="kicker-dot"></span>PRODUCT BRIEF</p>
      <h1>Anticipation of Uncertainty<span class="hero-cn">不确定性前瞻</span></h1>
      <p class="sub">大部分预测之所以没用，不是因为它算错了，而是因为它从一开始就没说清<strong>什么情况下算错</strong>。<br>
      这里把每一句判断都写成一条到期可核对、错了能定位原因的命题。</p>
      <div class="hero-cta">
        <button type="button" class="btn primary lg" data-goto="predict">${
          pub ? '登录后开始预测' : '开始一次预测'
        }</button>
        <button type="button" class="btn lg" data-goto="archive">${
          pub ? '登录后查看校准' : '查看我的校准'
        }</button>
      </div>
      ${
        pub
          ? `<p class="hero-note">用邮箱免费注册即可使用 · 你的预测与记忆按账号隔离，只有你本人能看到</p>`
          : ''
      }
    </section>

    <section class="intro-sec">
      <h2 class="sec-head"><span class="sec-num">01</span>它针对的三个毛病</h2>
      <div class="grid-3">
        <article class="icard">
          <span class="icard-tag">点预测的陷阱</span>
          <h3>给出一个数，然后无法复盘</h3>
          <p>「明天涨到 3,240」听起来干脆。但混沌系统的点预测命中基本靠运气——即便蒙对，你也没学到任何可迁移的东西。</p>
        </article>
        <article class="icard">
          <span class="icard-tag">措辞的陷阱</span>
          <h3>怎么说都不算错</h3>
          <p>「或将」「不排除」「中长期看需观望」——这类话永远正确，也永远无法被证伪，因此永远无法让人长进。</p>
        </article>
        <article class="icard">
          <span class="icard-tag">遗忘的陷阱</span>
          <h3>判断给完就沉底</h3>
          <p>没有人回头核对说过什么，于是既不知道自己的准确率，也发现不了自己系统性地过度自信。</p>
        </article>
      </div>
    </section>

    <section class="intro-sec">
      <h2 class="sec-head"><span class="sec-num">02</span>一次回答里装了什么</h2>
      <p class="sec-lead">每次预测都落成同一套结构。不是为了好看，是为了让它可被检验。</p>
      <div class="grid-2 tight">
        ${INTRO_FIELDS.map(
          ([k, v]) => `<div class="fieldcard"><b>${k}</b><span>${v}</span></div>`
        ).join('')}
        <div class="fieldcard accent">
          <b>推翻条件</b>
          <span>可观察的条件清单；满足任一条，即判定这条预测错了。写不出它，这条预测就不该出口。</span>
        </div>
        <div class="fieldcard accent">
          <b>复盘日</b>
          <span>这条判断应该在多少天后回头核对。到点它会主动出现在你的档案页顶部。</span>
        </div>
      </div>
    </section>

    <section class="intro-sec">
      <h2 class="sec-head"><span class="sec-num">03</span>方法论内核</h2>
      <p class="sec-lead">任何被预测的对象都可以写成四元组 <code>(S, T, O, P)</code>。模型在内部完成这套拆解，不向你复述术语。</p>
      <div class="quad">
        <div class="quad-item"><span class="quad-k">S</span><h4>状态空间</h4><p>哪些量在描述这个系统。选错了状态量，后面全是噪声。</p></div>
        <div class="quad-item"><span class="quad-k">T</span><h4>演化算子</h4><p>状态随时间如何变化：单调、周期，还是对初值极端敏感。</p></div>
        <div class="quad-item"><span class="quad-k">O</span><h4>观测算子</h4><p>我们能测到什么、测不到什么。测不到的部分只能进不确定性。</p></div>
        <div class="quad-item"><span class="quad-k">P</span><h4>不确定性来源</h4><p>内在涨落 / 认知不确定性 / 社交不确定性，三者性质完全不同。</p></div>
      </div>
    </section>

    <section class="intro-sec">
      <h2 class="sec-head"><span class="sec-num">04</span>预测能力的四条边界</h2>
      <p class="sec-lead">这四条不是装饰，是每次推理都必须逐条自查的硬理由——它们决定了「能预测到什么程度」。</p>
      <div class="grid-2 tight">
        ${INTRO_REASONS.map(
          ([t, d], i) => `<article class="reason"><h4><span>${String(i + 1).padStart(2, '0')}</span>${t}</h4><p>${d}</p></article>`
        ).join('')}
      </div>
    </section>

    <section class="intro-sec">
      <h2 class="sec-head"><span class="sec-num">05</span>一次预测的完整流程</h2>
      <ol class="flow">
        ${INTRO_FLOW.map(
          ([t, d], i) => `<li><span class="flow-n">${i + 1}</span><b>${t}</b><p>${d}</p></li>`
        ).join('')}
      </ol>
    </section>

    <section class="intro-sec">
      <h2 class="sec-head"><span class="sec-num">06</span>接入了什么</h2>
      <p class="sec-lead">共 <strong>${SOURCES.length}</strong> 路实时数据源，其中 ${coreCount} 路为每次必取的核心源，其余按问题关键词命中。绝大多数是公开接口、浏览器直连、无需密钥。</p>
      <div class="srclist">
        ${groups
          .map(
            (g) => `<div class="srcgroup">
              <h4>${g.title}<i>${g.note}</i></h4>
              <div class="chips">
                ${g.items
                  .map(
                    (s) =>
                      `<span class="tag ${s.core ? 'ok ' : ''}${s.via === 'proxy' ? 'proxy' : ''}" title="${
                        s.core ? '核心接口，每次必取' : '按关键词命中'
                      }${s.via === 'proxy' ? '；经本站后端代理抓取' : ''}">${s.icon} ${esc(s.name)}</span>`
                  )
                  .join('')}
              </div>
            </div>`
          )
          .join('')}
      </div>
      <p class="hint">绿色底纹为核心源，每次必取；带虚线框的少数源（如社交热榜）目标站不开放跨域，由本站后端代理转发，不额外向第三方暴露你的身份。</p>
    </section>

    <section class="intro-sec">
      <h2 class="sec-head"><span class="sec-num">07</span>它怎么知道自己准不准</h2>
      <div class="grid-3">
        <article class="icard">
          <span class="icard-tag">硬命中率</span>
          <h3>应验 ÷ 已判定</h3>
          <p>最粗暴也最诚实的指标：那些写清了判定标准的判断，到底对不对。</p>
        </article>
        <article class="icard">
          <span class="icard-tag">Brier 分数</span>
          <h3>概率的平方误差</h3>
          <p>不只问「对不对」，还问「你给的置信度合不合理」。越低越好；长期停在 0.25，等于永远说 50%。</p>
        </article>
        <article class="icard">
          <span class="icard-tag">可靠性分桶</span>
          <h3>声称 80%，就该对 80%</h3>
          <p>按置信度分桶，比较「声称概率」与「实际发生频率」，画出校准曲线，直接暴露系统性过度自信。</p>
        </article>
      </div>
    </section>

    <section class="intro-sec">
      <h2 class="sec-head"><span class="sec-num">08</span>它不做什么</h2>
      <div class="grid-2 tight">
        <article class="limit-card"><h4>不预测不可约的随机结果</h4><p>彩票、单场赛事比分、具体价格点位。这类问题只给结构性判断——区间、方向、条件依赖，并说明为什么给不出点预测。</p></article>
        <article class="limit-card"><h4>不为了让你舒服而抬高置信度</h4><p>低置信度是诚实的输出，不是失败。<code>0.5</code> 是一个合法的答案。</p></article>
        <article class="limit-card"><h4>不编造缺失的数据</h4><p>某个维度没有数据，就明说「无该维度数据」，并在推翻条件里保留这一缺口。</p></article>
        <article class="limit-card"><h4>不把记忆当话术</h4><p>它用你的长期背景做个性化，但不会用「我知道你……」的口吻复述记忆机制本身。</p></article>
      </div>
    </section>

    <section class="intro-sec">
      <h2 class="sec-head"><span class="sec-num">09</span>隐私与使用条款</h2>
      <p class="sec-lead">这是个人做的小站。把话说清楚，比写得好看重要。</p>
      <div class="grid-2 tight">
        <article class="legal">
          <h4>隐私：收集什么，用来做什么</h4>
          <ul>
            <li><b>邮箱</b>——只用于登录。不发营销邮件，不对外提供。</li>
            <li><b>你写的记忆与预测</b>——只服务于本应用的功能：预测时作为上下文、到期做复盘统计。</li>
            <li><b>观测位置</b>——用于天气、日照这类本地化推导，可随时改。</li>
            <li><b>隔离</b>——数据存在云数据库中，由数据库行级安全策略强制按账号隔离，
                其他用户读不到你的内容，管理员界面也不展示。</li>
            <li><b>第三方请求</b>——预测时向公开数据接口（气象、行情、热榜等）发起请求，
                只传问题必需的参数（如城市坐标），不传你的身份信息。</li>
            <li><b>你能做的</b>——随时删除单条记忆或预测；用「我的 → 导出数据」把数据全部带走；
                退出登录即清除本地会话。</li>
          </ul>
        </article>
        <article class="legal warn">
          <h4>免责：它不是什么</h4>
          <ul>
            <li>输出的是<b>结构性判断与概率估计</b>，不是事实陈述，
                <b>不构成投资、医疗、法律、税务等任何专业建议</b>。</li>
            <li>涉及金融市场的判断只作方法演示，据此操作，风险自负。</li>
            <li>模型会出错、会过时、会给出貌似合理实则错误的结论。
                请以它自己声明的<b>推翻条件</b>为准，而不是以措辞的确定性为准。</li>
            <li>服务按「现状」提供，不承诺可用性与准确性；额度耗尽或维护期间会暂停。</li>
            <li>这是个人项目，不是商业服务，请勿用于需要高可靠性的决策。</li>
          </ul>
        </article>
      </div>
    </section>

    <section class="intro-cta">
      <div>
        <b>${pub ? '注册后就能试。' : '现在就可以试一次。'}</b>
        <span>${
          pub
            ? '用邮箱免费注册，然后问一个你本来就想知道答案的问题，等它到期，回来核对。'
            : '先问一个你本来就想知道答案的问题，然后等它到期，回来核对。'
        }</span>
      </div>
      <button type="button" class="btn primary lg" data-goto="predict">${
        pub ? '登录 / 注册' : '开始预测'
      }</button>
    </section>
  `

  bindGoto(main)
}

/* ── 视图一：预测台 ─────────────────────────────────────── */

/** 额度的展示文案只有一份真源，预测台渲染与预测后刷新共用 */
function quotaHtml() {
  const left = Math.max(0, DAILY_QUESTION_LIMIT - state.todayUsed)
  return `<b>今日额度</b>${
    left === 0
      ? `<span class="quota-out">已用完（${state.todayUsed}/${DAILY_QUESTION_LIMIT}），明日 0:00 重置</span>`
      : `剩余 <i>${left}</i> / ${DAILY_QUESTION_LIMIT} 次`
  }<span class="quota-note">每次提问都会真实调用一次大模型，花的是本站在云服务上的共享额度，请节约使用</span>`
}

function refreshQuota() {
  const el = $('#quota')
  if (!el) return
  el.classList.toggle('out', Math.max(0, DAILY_QUESTION_LIMIT - state.todayUsed) === 0)
  el.innerHTML = quotaHtml()
}

function renderPredict(main) {
  const left = Math.max(0, DAILY_QUESTION_LIMIT - state.todayUsed)

  main.innerHTML = `
    <section class="hero">
      <p class="kicker"><span class="kicker-dot"></span>PREDICTION DESK</p>
      <h1>问一件还没发生的事</h1>
      <p class="sub">它先抓取此刻的真实世界状态，再按「状态空间 / 演化算子 / 观测算子 / 不确定性来源」
      四元组建模，最后给你一条<strong>带置信度、可预测时域和推翻条件</strong>的判断——而不是一句好听的话。
      <button type="button" class="link inline-link" data-goto="intro">这个引擎怎么工作 →</button></p>
    </section>

    <section class="ask">
      <textarea id="q" rows="3" maxlength="${MAX_QUESTION_CHARS}"
        placeholder="例如：未来一个月人民币对美元会怎么走？"></textarea>
      <div class="ask-row">
        <div class="examples">
          ${EXAMPLES.slice(0, 3).map((e) => `<button type="button" class="chip" data-ex="${esc(e)}">${esc(e.slice(0, 14))}…</button>`).join('')}
        </div>
        <div class="ask-actions">
          <button type="button" class="btn ghost hidden" id="stop">停止</button>
          <button type="button" class="btn primary" id="go">开始预测</button>
        </div>
      </div>
      <p class="quota ${left === 0 ? 'out' : ''}" id="quota">${quotaHtml()}</p>
      <p class="msg error hidden" id="qerr"></p>
    </section>

    <section id="stage">
      <div class="idle">
        <div class="idle-top">
          <span class="pulse"></span>
          <b>引擎就绪</b>
          <span class="idle-meta">${SOURCES.length} 路数据源在线 · ${SOURCES.filter((s) => s.core).length} 路核心源每次必取 · 一次完整推演约 10–20 秒</span>
        </div>
        <div class="idle-steps">
          <div class="idle-step"><i>1</i><b>抓取世界状态</b><span>按关键词选源，并行抓取</span></div>
          <div class="idle-step"><i>2</i><b>四元组建模</b><span>状态 / 演化 / 观测 / 不确定性</span></div>
          <div class="idle-step"><i>3</i><b>结构化判断</b><span>置信度 · 时域 · 推翻条件</span></div>
          <div class="idle-step"><i>4</i><b>落库待复盘</b><span>到期回来核对结果</span></div>
        </div>
      </div>
    </section>
  `

  const qEl = $('#q', main)
  const goEl = $('#go', main)
  const stopEl = $('#stop', main)
  const stageEl = $('#stage', main)
  const qerrEl = $('#qerr', main)

  $$('.chip', main).forEach((c) => {
    c.onclick = () => {
      qEl.value = c.dataset.ex.replace(/…$/, '')
      qEl.focus()
    }
  })

  qEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') goEl.click()
  })

  bindGoto(main)

  stopEl.onclick = () => state.controller?.abort()

  goEl.onclick = async () => {
    const question = qEl.value.trim()
    if (!question) return
    if (state.running) return
    // 额度闸放在最前面：宁可让用户明确知道为什么不能问，也不要白跑一趟再报错
    const nowLeft = Math.max(0, DAILY_QUESTION_LIMIT - state.todayUsed)
    if (nowLeft === 0) {
      qerrEl.classList.remove('hidden')
      qerrEl.textContent = `今日提问额度已用完（${DAILY_QUESTION_LIMIT} 次/天）。每次提问都会真实调用大模型并消耗本站的共享额度，所以设了这个上限；明日 0:00 自动重置。`
      return
    }
    qerrEl.classList.add('hidden')
    await doPredict(question, { stageEl, goEl, stopEl, qerrEl })
  }

  if (state.running) goEl.disabled = true
}

async function doPredict(question, { stageEl, goEl, stopEl, qerrEl }) {
  state.running = true
  state.controller = new AbortController()
  goEl.disabled = true
  goEl.textContent = '抓取数据…'
  stopEl.classList.remove('hidden')

  stageEl.innerHTML = `
    <div class="stage-card">
      <div class="stage-step" id="s1"><span class="spin"></span>正在抓取实时世界状态…</div>
      <div id="source-bar" class="source-bar"></div>
      <div class="stage-step hidden" id="s2"><span class="spin"></span><span id="s2-text">正在按四元组建模并推演…</span><i id="wait" class="wait"></i></div>
      <div class="stream-wrap hidden" id="stream-wrap">
        <div class="stream-head">模型正在生成的原始输出（结束后下方会给出结构化判断）</div>
        <pre class="stream" id="stream"></pre>
      </div>
      <p class="msg error hidden" id="perr"></p>
    </div>
  `

  const s1 = $('#s1', stageEl)
  const s2 = $('#s2', stageEl)
  const s2Text = $('#s2-text', stageEl)
  const waitEl = $('#wait', stageEl)
  const bar = $('#source-bar', stageEl)
  const streamWrap = $('#stream-wrap', stageEl)
  const streamEl = $('#stream', stageEl)
  const errEl = $('#perr', stageEl)

  // 推理阶段可能长达数十秒，给出真实进度，避免"像死了一样"的等待
  let secs = 0
  let gotFirst = false
  let tick = null

  try {
    const snapshot = await fetchSnapshot(question, { location: state.location })

    s1.classList.add('done')
    s1.innerHTML = `✓ 世界状态已就绪 · ${snapshot.results.filter((r) => r.ok).length}/${snapshot.results.length} 个接口返回`
    bar.innerHTML = snapshot.results
      .map(
        (r) =>
          `<span class="src ${r.ok ? 'ok' : 'bad'}" title="${esc(r.ok ? r.summary : r.error || '')}">
             ${r.icon} ${esc(r.name)}${r.ok ? `<i>${r.ms}ms</i>` : '<i>失败</i>'}
           </span>`
      )
      .join('')

    s2.classList.remove('hidden')
    streamWrap.classList.remove('hidden')
    goEl.textContent = '推理中…'

    tick = setInterval(() => {
      secs += 1
      waitEl.textContent = gotFirst
        ? `　已生成 ${secs}s`
        : `　已等待 ${secs}s${secs >= 5 ? '（首字通常需 5–15 秒）' : ''}`
    }, 1000)

    let acc = ''
    const { parsed, model } = await runPrediction(
      {
        question,
        snapshot,
        memories: state.memories,
        profile: state.profile,
        location: state.location,
      },
      {
        signal: state.controller.signal,
        onDelta: (d) => {
          if (!gotFirst) {
            gotFirst = true
            secs = 0
          }
          acc += d
          streamEl.textContent = acc.length > 1200 ? acc.slice(-1200) : acc
          streamEl.scrollTop = streamEl.scrollHeight
        },
        // 引擎会在模型无响应时自动换下一个候选，界面如实呈现并清空上一条残留
        onRetry: (nextId, fails) => {
          acc = ''
          gotFirst = false
          secs = 0
          streamEl.textContent = ''
          s2Text.textContent = `当前模型无响应，正在换用备用模型（${esc(nextId)}）…`
          waitEl.textContent = ''
        },
      }
    )

    s2.classList.add('done')
    s2.innerHTML = `✓ 推演完成 · ${esc(model)}`

    if (!parsed) {
      errEl.classList.remove('hidden')
      errEl.textContent = '模型返回的内容无法解析为结构化预测，原始输出已保留在下方。'
      streamEl.textContent = acc
      return
    }

    streamWrap.classList.add('hidden')
    const horizonDays = normalizeHorizonDays(parsed.horizonDays, parsed.horizon)
    const dueAt = computeDueAt(new Date().toISOString(), horizonDays, parsed.horizon)
    const card = document.createElement('div')
    card.className = 'result-block'
    card.innerHTML = renderPredCard(parsed, snapshot, horizonDays, dueAt)
    stageEl.appendChild(card)

    // 落库
    try {
      const saved = await Store.addPrediction({
        question,
        domain: parsed.domain || 'general',
        horizon: parsed.horizon || '',
        horizon_days: horizonDays,
        confidence: parsed.confidence,
        payload: parsed,
        sources: snapshot.results.map((r) => ({ id: r.id, name: r.name, ok: r.ok, summary: r.summary })),
        due_at: dueAt.toISOString(),
      })
      if (saved) state.predictions.unshift(saved)
      // 只有真正落库的预测才计入今日额度（服务端也是按这张表计数，两边口径一致）
      state.todayUsed += 1
      refreshQuota()
    } catch (err) {
      errEl.classList.remove('hidden')
      errEl.textContent = '预测已生成，但存入档案失败：' + describeError(err)
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      s2.innerHTML = '已停止生成。'
      errEl.classList.remove('hidden')
      errEl.textContent = '本次生成已被中断，未写入档案。'
    } else {
      // 别把转圈的 spinner 留在屏幕上——明确告诉用户这一轮失败了
      s2.classList.add('done')
      s2.innerHTML = '✗ 推演未完成'
      s1.classList.add('done')
      errEl.classList.remove('hidden')
      errEl.textContent = describeError(err)
    }
  } finally {
    if (tick) clearInterval(tick)
    state.running = false
    state.controller = null
    goEl.disabled = false
    goEl.textContent = '开始预测'
    stopEl.classList.add('hidden')
  }
}

function renderPredCard(p, snapshot, horizonDays, dueAt) {
  const conf = Math.round((p.confidence ?? 0.5) * 100)
  const confClass = conf >= 70 ? 'high' : conf >= 45 ? 'mid' : 'low'
  const srcOk = (snapshot?.results || []).filter((r) => r.ok)

  const list = (arr, cls = '') =>
    arr && arr.length ? `<ul class="${cls}">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">—</p>'

  return `
  <article class="pred-card">
    <div class="pred-head">
      <span class="pill">${esc(p.horizon)}</span>
      <h2>${esc(p.headline)}</h2>
    </div>

    <div class="conf-row">
      <div class="conf-bar"><i class="${confClass}" style="width:${conf}%"></i></div>
      <span class="conf-val ${confClass}">置信度 ${conf}%</span>
    </div>

    <p class="pred-window"><b>可预测时域</b>${esc(p.predictableWindow)}</p>
    <p class="due-line">${dueLine(horizonDays, dueAt)}</p>

    <div class="pred-grid">
      <section class="cell">
        <h3>时间线</h3>
        ${p.timeline && p.timeline.length
          ? `<ol class="timeline">${p.timeline.map((t) => `<li><span class="when">${esc(t.when)}</span><span class="what">${esc(t.what)}</span></li>`).join('')}</ol>`
          : '<p class="muted">—</p>'}
      </section>
      <section class="cell">
        <h3>驱动变量</h3>
        <div class="chips">${(p.drivers || []).map((d) => `<span class="tag">${esc(d)}</span>`).join('') || '<span class="muted">—</span>'}</div>
      </section>
      <section class="cell wide">
        <h3>核心机制</h3>
        <p>${esc(p.mechanism) || '—'}</p>
      </section>
      <section class="cell">
        <h3>不确定性来源</h3>
        ${list(p.uncertainty)}
      </section>
      <section class="cell">
        <h3>反身性</h3>
        <p class="reflex">${esc(p.reflexivity)}</p>
      </section>
      <section class="cell wide falsify-cell">
        <h3>推翻条件 <span class="hint">满足任一，即说明这个预测错了</span></h3>
        ${list(p.falsify, 'falsify')}
      </section>
    </div>

    <details class="basis">
      <summary>依据与边界声明</summary>
      <div class="basis-body">
        <h4>实际使用的数据与记忆</h4>
        ${list(p.basis)}
        <h4>本次调用的接口</h4>
        <div class="chips">${srcOk.map((s) => `<span class="tag ok">${esc(s.name)}</span>`).join('') || '<span class="muted">无</span>'}</div>
        <h4>边界声明</h4>
        <p>${esc(p.caveat) || '—'}</p>
      </div>
    </details>
  </article>`
}

/* ── 视图二：档案 ───────────────────────────────────────── */

function fmtDate(d) {
  if (!d) return '—'
  const t = d instanceof Date ? d : new Date(d)
  if (!Number.isFinite(t.getTime())) return '—'
  return t.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/** 复盘进度标签：越接近到期越醒目，已超期最高优先级。 */
function dueBadge(p) {
  if (isJudged(p)) return { text: '已复盘', cls: 'done' }
  const d = daysUntil(p.due_at)
  if (d == null) return { text: '无期限', cls: 'plain' }
  if (d <= 0) return { text: d === 0 ? '今日到期' : `超期 ${-d} 天`, cls: 'overdue' }
  if (d <= 7) return { text: `${d} 天后到期`, cls: 'soon' }
  return { text: `${d} 天后到期`, cls: 'plain' }
}

function dueLine(horizonDays, dueAt) {
  return `<b>复盘日</b>${fmtDate(dueAt)}（${horizonDays} 天后）· 到期回来核对实际结果，标记应验与否`
}

function renderArchive(main) {
  const list = state.predictions
  const s = summarize(list)

  main.innerHTML = `
    <section class="hero sm">
      <h1>预测档案</h1>
      <p class="sub">到期回来核对结果。<strong>校准</strong>比预测本身更重要——声称 80%，就该对 80%。</p>
    </section>

    <section class="stats">
      <div class="stat"><b>${s.total}</b><span>累计预测</span></div>
      <div class="stat ${s.due ? 'alert' : ''}"><b>${s.due}</b><span>待复盘</span></div>
      <div class="stat"><b>${s.judged}</b><span>已判定</span></div>
      <div class="stat"><b>${s.hitRate != null ? Math.round(s.hitRate * 100) + '%' : '—'}</b><span>硬命中率</span></div>
      <div class="stat"><b>${s.brier != null ? s.brier.toFixed(3) : '—'}</b><span>Brier 分数</span></div>
    </section>

    ${
      s.dueList.length
        ? `<section class="due-queue">
            <h2 class="sec-title">到了该复盘的时候 <span class="badge-count">${s.dueList.length}</span></h2>
            <p class="hint">以下预测的可预测时域已经结束。趁记忆还新鲜，把实际结果记下来——这是整套方法唯一能被证伪的地方。</p>
            <div class="due-list" id="due-list">${s.dueList.map(dueCard).join('')}</div>
          </section>`
        : ''
    }

    ${
      s.judged >= 3
        ? calibrationPanel(s)
        : `<section class="panel"><h3>可靠性校准</h3><p class="hint">已判定满 3 条后开始生成校准分析（当前 ${s.judged} 条）。只有一条记录时算命中率，和抛硬币没有区别。</p></section>`
    }

    <section class="list">
      <h2 class="sec-title">全部记录</h2>
      ${
        state.truncated.predictions
          ? `<p class="notice">档案页最多列出最近 100 条。更早的记录仍在数据库里，只是没显示——
             需要完整数据请到「我的 → 导出数据」下载。</p>`
          : ''
      }
      <div id="pred-list">
        ${list.length ? list.map(predRow).join('') : '<p class="empty">还没有预测记录。去预测台提第一个问题吧。</p>'}
      </div>
    </section>
  `

  $$('#due-list .due-card', main).forEach((el) => {
    el.querySelector('[data-review]').onclick = () => {
      const p = state.predictions.find((x) => x.id === Number(el.dataset.id))
      if (p) openReview(p)
    }
  })

  $$('#pred-list .pred-row', main).forEach((row) => {
    const id = Number(row.dataset.id)
    const find = () => state.predictions.find((x) => x.id === id)

    row.querySelector('.row-toggle')?.addEventListener('click', () => row.classList.toggle('open'))

    row.querySelector('[data-review]')?.addEventListener('click', () => {
      const p = find()
      if (p) openReview(p)
    })

    row.querySelector('[data-reset]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '撤销这条判定？',
        body: '它会退回「待复盘」，已写下的判定与实际结果将被清空。校准统计会随之变化。',
        confirmText: '撤销判定',
      })
      if (!ok) return
      try {
        const updated = await Store.resetVerdict(id)
        const item = find()
        if (item) Object.assign(item, updated || { verdict: 'pending', outcome: null, reviewed_at: null })
        renderView()
      } catch (err) {
        toast(describeError(err))
      }
    })

    row.querySelector('[data-del]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '删除这条预测？',
        body: '记录与其复盘结果会被永久删除，无法撤销。如果只是不想看到它，可以先留着——它也是你校准历史的一部分。',
        confirmText: '永久删除',
        danger: true,
      })
      if (!ok) return
      try {
        await Store.removePrediction(id)
        state.predictions = state.predictions.filter((x) => x.id !== id)
        renderView()
      } catch (err) {
        toast(describeError(err))
      }
    })
  })
}

function dueCard(p) {
  const head = p.payload?.headline || p.question
  const conf = p.confidence != null ? Math.round(p.confidence * 100) + '%' : '—'
  const db = dueBadge(p)
  return `
  <article class="due-card" data-id="${p.id}">
    <div class="due-head">
      <span class="duebadge ${db.cls}">${esc(db.text)}</span>
      <span class="due-when">复盘日 ${fmtDate(p.due_at)}</span>
      <span class="due-conf">当时置信度 ${conf}</span>
    </div>
    <p class="due-q">${esc(p.question)}</p>
    <p class="due-a">当时的结论：${esc(head)}</p>
    <button type="button" class="btn primary sm" data-review>去复盘</button>
  </article>`
}

/** 可靠性图：浅色条 = 声称的置信度，竖线 = 实际命中率。贴合即标定准确。 */
function calibrationPanel(s) {
  const rows = s.buckets
    .map((b) => {
      if (!b.n) {
        return `<div class="calib-row empty"><span class="calib-label">${b.label}</span><div class="calib-track"></div><span class="calib-val">—</span></div>`
      }
      const pred = b.predicted * 100
      const act = Math.min(b.actual * 100, 100)
      return `<div class="calib-row">
        <span class="calib-label">${b.label}</span>
        <div class="calib-track">
          <i class="bar-pred" style="width:${pred.toFixed(1)}%"></i>
          <i class="mark-act" style="left:${act.toFixed(1)}%"></i>
        </div>
        <span class="calib-val">${Math.round(act)}%<em>/${b.n}</em></span>
      </div>`
    })
    .join('')

  const bias = s.overconfidence
  let note = ''
  let noteCls = ''
  if (bias != null) {
    const p = Math.round(s.avgConfidence * 100)
    const a = Math.round(s.softRate * 100)
    if (bias > 0.12) {
      note = `⚠ 系统性过度自信：平均声称 ${p}%，软命中率只有 ${a}%。模型的置信度需要整体下调。`
      noteCls = 'over'
    } else if (bias < -0.12) {
      note = `偏保守：平均声称 ${p}%，实际软命中率 ${a}%。它的判断比它自己说的更有把握。`
      noteCls = 'under'
    } else {
      note = `标定良好：平均声称 ${p}%，软命中率 ${a}%，差距在可接受范围内。`
      noteCls = 'good'
    }
  }

  const ref =
    s.brier == null
      ? ''
      : s.brier < 0.25
        ? '优于「永远说 50%」的基线（0.25）——置信度带信息量'
        : '劣于「永远说 50%」的基线（0.25）——当前的置信度还不带信息量'

  return `
  <section class="panel calib-panel">
    <h3>可靠性校准</h3>
    <p class="hint">浅色条是声称的置信度，竖线是实际命中率。两者贴合才叫标定准确。</p>
    <div class="calib">${rows}</div>
    <div class="calib-legend">
      <span><i class="sw pred"></i>声称的置信度</span>
      <span><i class="sw act"></i>实际命中率</span>
    </div>
    <p class="calib-note ${noteCls}">${note}</p>
    <p class="calib-note sub">Brier 分数 <b>${s.brier != null ? s.brier.toFixed(3) : '—'}</b> · ${ref}</p>
    <p class="calib-note sub">判定口径：应验记 1，部分应验记 0.5，未应验记 0；硬命中率只数「应验」。</p>
  </section>`
}

/* ── 复盘弹窗 ───────────────────────────────────────────── */

function openReview(p) {
  const claim = p.payload?.headline || '（未留下明确结论）'
  const fals = p.payload?.falsify || []
  const conf = p.confidence != null ? Math.round(Number(p.confidence) * 100) + '%' : '—'

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="复盘预测">
      <div class="modal-head">
        <h3>复盘这条预测</h3>
        <button type="button" class="modal-x" data-close aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <div class="rv-meta">
          <span>提出于 ${fmtDate(p.created_at)}</span>
          <span>复盘日 ${fmtDate(p.due_at)}</span>
          <span>当时置信度 ${conf}</span>
        </div>

        <p class="rv-q">${esc(p.question)}</p>

        <div class="rv-claim">
          <span class="rv-tag">当时给出的结论</span>
          <p>${esc(claim)}</p>
        </div>

        ${
          fals.length
            ? `<div class="rv-claim warn">
                 <span class="rv-tag warn">它自己声明的推翻条件</span>
                 <ul>${fals.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
               </div>`
            : ''
        }

        <label class="field"><span>实际发生了什么</span>
          <textarea id="rv-outcome" rows="3" placeholder="写下可核对的事实——具体数值、事件、时间。这是你以后校准的唯一证据。">${esc(p.outcome || '')}</textarea>
        </label>

        <div class="rv-verdict">
          <span class="rv-tag">判定</span>
          <div class="rv-btns">
            ${['hit', 'partial', 'miss'].map((k) => `<button type="button" class="vbtn ${k}" data-v="${k}">${VERDICTS[k].label}</button>`).join('')}
          </div>
          <p class="hint">应验 = 结论整体成立；部分应验 = 方向对但幅度或时点有偏差；未应验 = 被推翻条件命中。</p>
        </div>

        <p class="msg error hidden" id="rv-err"></p>
      </div>
    </div>`

  document.body.appendChild(overlay)
  const ta = $('#rv-outcome', overlay)
  ta.focus()

  const onKey = (e) => {
    if (e.key === 'Escape') close()
  }
  function close() {
    document.removeEventListener('keydown', onKey)
    overlay.remove()
  }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  $('[data-close]', overlay).onclick = close

  overlay.querySelectorAll('.vbtn').forEach((b) => {
    b.onclick = async () => {
      const outcome = ta.value.trim()
      const errEl = $('#rv-err', overlay)
      // 强制留证：没有事实记录的判定无法用于校准，只会变成自我安慰
      if (!outcome) {
        errEl.textContent = '先写下实际发生了什么——没有证据的判定无法用于校准。'
        errEl.classList.remove('hidden')
        ta.focus()
        return
      }
      const btns = Array.from(overlay.querySelectorAll('.vbtn'))
      btns.forEach((x) => (x.disabled = true))
      try {
        const updated = await Store.reviewPrediction(p.id, { verdict: b.dataset.v, outcome })
        const item = state.predictions.find((x) => x.id === p.id)
        if (item) {
          Object.assign(item, updated || { verdict: b.dataset.v, outcome, reviewed_at: new Date().toISOString() })
        }
        close()
        renderView()
      } catch (err) {
        errEl.textContent = describeError(err)
        errEl.classList.remove('hidden')
        btns.forEach((x) => (x.disabled = false))
      }
    }
  })
}

function predRow(p) {
  const v = VERDICTS[p.verdict] || VERDICTS.pending
  const conf = p.confidence != null ? Math.round(p.confidence * 100) + '%' : '—'
  const when = new Date(p.created_at).toLocaleString('zh-CN', { hour12: false })
  const head = p.payload?.headline || p.question
  const db = dueBadge(p)

  return `
  <article class="pred-row ${db.cls === 'overdue' ? 'is-overdue' : ''}" data-id="${p.id}">
    <div class="row-main">
      <div class="row-top">
        <span class="verdict ${v.cls}">${v.label}</span>
        <span class="duebadge ${db.cls}">${esc(db.text)}</span>
        <span class="row-time">${esc(when)}</span>
        <span class="row-conf">置信度 ${conf}</span>
        <button type="button" class="btn ghost xs" data-del>删除</button>
      </div>
      <h3 class="row-q">${esc(p.question)}</h3>
      <p class="row-a">${esc(head)}</p>
      ${p.outcome ? `<p class="row-outcome"><b>实际</b>${esc(p.outcome)}</p>` : ''}
      <div class="row-actions">
        <button type="button" class="row-toggle link">展开详情</button>
        <button type="button" class="link strong" data-review>${v.cls === 'pending' ? '去复盘' : '修改判定'}</button>
        ${v.cls !== 'pending' ? '<button type="button" class="link" data-reset>撤销判定</button>' : ''}
      </div>
    </div>
    <div class="row-detail">
      ${p.payload ? renderDetailBody(p.payload) : '<p class="muted">无结构化数据</p>'}
    </div>
  </article>`
}

function renderDetailBody(p) {
  const list = (arr) => (arr && arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">—</p>')
  return `
    <div class="pred-grid">
      <section class="cell"><h3>时间线</h3>${
        p.timeline && p.timeline.length
          ? `<ol class="timeline">${p.timeline.map((t) => `<li><span class="when">${esc(t.when)}</span><span class="what">${esc(t.what)}</span></li>`).join('')}</ol>`
          : '<p class="muted">—</p>'
      }</section>
      <section class="cell"><h3>驱动变量</h3><div class="chips">${(p.drivers || []).map((d) => `<span class="tag">${esc(d)}</span>`).join('') || '<span class="muted">—</span>'}</div></section>
      <section class="cell wide"><h3>核心机制</h3><p>${esc(p.mechanism) || '—'}</p></section>
      <section class="cell"><h3>不确定性</h3>${list(p.uncertainty)}</section>
      <section class="cell"><h3>反身性</h3><p>${esc(p.reflexivity) || '—'}</p></section>
      <section class="cell wide"><h3>推翻条件</h3>${list(p.falsify)}</section>
    </div>`
}

/* ── 视图三：记忆 ───────────────────────────────────────── */

function renderMemory(main) {
  main.innerHTML = `
    <section class="hero sm">
      <h1>长期记忆</h1>
      <p class="sub">写在这里的内容，每次预测都会被带上。放稳定的事实与偏好，不要放会变的短期状态。</p>
    </section>

    <section class="mem-form">
      <div class="inline-form">
        <select id="mem-cat">
          ${MEMORY_CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`).join('')}
        </select>
        <input id="mem-text" type="text" placeholder="例如：我在重庆万州，在准备数学建模竞赛" maxlength="300">
        <button type="button" class="btn primary" id="mem-add">添加</button>
      </div>
      <p class="hint">已存 ${state.memories.length} 条；预测时按权重取前 30 条。${
        state.truncated.memories ? '<b>注意：列表上限 200 条，更新的条目被截断了。</b>' : ''
      }</p>
    </section>

    <section class="list" id="mem-list">
      ${state.memories.length ? state.memories.map(memRow).join('') : '<p class="empty">还没有记忆条目。</p>'}
    </section>
  `

  const textEl = $('#mem-text', main)
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#mem-add', main).click()
  })

  $('#mem-add', main).onclick = async () => {
    const content = textEl.value.trim()
    if (!content) return
    const btn = $('#mem-add', main)
    btn.disabled = true
    try {
      const row = await Store.addMemory({ category: $('#mem-cat', main).value, content })
      if (row) state.memories.unshift(row)
      renderView()
    } catch (err) {
      toast(describeError(err))
      btn.disabled = false
    }
  }

  $$('#mem-list .mem-row').forEach((row) => {
    const id = Number(row.dataset.id)
    const find = () => state.memories.find((m) => m.id === id)

    row.querySelector('[data-del]').onclick = async () => {
      const ok = await confirmDialog({
        title: '删除这条记忆？',
        body: '删除后，之后的预测不会再把它带进上下文。',
        confirmText: '删除',
        danger: true,
      })
      if (!ok) return
      try {
        await Store.removeMemory(id)
        state.memories = state.memories.filter((m) => m.id !== id)
        renderView()
      } catch (err) {
        toast(describeError(err))
      }
    }

    row.querySelector('[data-edit]').onclick = () => {
      const m = find()
      if (m) startMemoryEdit(row, m)
    }
  })
}

/** 就地编辑一条记忆。改完回车保存，Esc 放弃——不弹新窗口。 */
function startMemoryEdit(row, m) {
  const original = m.content
  const textEl = $('.mem-text', row)
  const actionsEl = $('.mem-actions', row)

  textEl.innerHTML = `<input type="text" class="mem-edit" maxlength="300" value="${esc(original)}">`
  const input = $('.mem-edit', textEl)
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)

  actionsEl.innerHTML = `
    <button type="button" class="link strong" data-save>保存</button>
    <button type="button" class="link" data-cancel>取消</button>`

  const finish = () => renderView()

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('[data-save]', actionsEl).click()
    if (e.key === 'Escape') finish()
  })

  $('[data-save]', actionsEl).onclick = async () => {
    const next = input.value.trim()
    if (!next) return toast('内容不能为空。')
    if (next === original) return finish()
    try {
      const updated = await Store.updateMemory(m.id, next)
      m.content = updated?.content ?? next
      finish()
    } catch (err) {
      toast(describeError(err))
    }
  }

  $('[data-cancel]', actionsEl).onclick = finish
}

function memRow(m) {
  const cat = MEMORY_CATEGORIES.find((c) => c.id === m.category)?.label || m.category
  return `
  <article class="mem-row" data-id="${m.id}">
    <span class="mem-cat">${esc(cat)}</span>
    <span class="mem-text">${esc(m.content)}</span>
    <span class="mem-actions">
      <button type="button" class="link" data-edit>编辑</button>
      <button type="button" class="link" data-del>删除</button>
    </span>
  </article>`
}

/* ── 导出 ───────────────────────────────────────────────────
   数据自主：使用者应该能随时把自己产生的东西带走，而不是被锁在这里。
   全部在浏览器本地用 Blob 生成，不上传、不经过任何服务器。 */

function downloadFile(name, text, mime) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器直接取消下载，延后释放更稳
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** 文件名用本地时间戳，避免多次导出互相覆盖 */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function exportPredictionsJSON() {
  const payload = {
    app: 'Anticipation of Uncertainty',
    exportedAt: new Date().toISOString(),
    truncated: state.truncated.predictions,
    count: state.predictions.length,
    predictions: state.predictions,
  }
  downloadFile(`aou-predictions-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json')
}

function csvCell(v) {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function exportPredictionsCSV() {
  const head = [
    'id', '提问', '领域', '时域', '时域天数', '置信度', '结论',
    '判定', '实际发生了什么', '提出时间', '复盘日', '复盘时间', '推翻条件',
  ]
  const rows = state.predictions.map((p) => [
    p.id,
    p.question,
    p.domain,
    p.horizon,
    p.horizon_days,
    p.confidence,
    p.payload?.headline ?? '',
    (VERDICTS[p.verdict] || VERDICTS.pending).label,
    p.outcome ?? '',
    p.created_at ?? '',
    p.due_at ?? '',
    p.reviewed_at ?? '',
    (p.payload?.falsify || []).join(' | '),
  ])
  const csv = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
  // 前置 BOM，否则 Excel 打开中文会乱码
  downloadFile(`aou-predictions-${stamp()}.csv`, '\uFEFF' + csv, 'text/csv;charset=utf-8')
}

function exportMemoriesJSON() {
  const payload = {
    app: 'Anticipation of Uncertainty',
    exportedAt: new Date().toISOString(),
    truncated: state.truncated.memories,
    count: state.memories.length,
    memories: state.memories,
  }
  downloadFile(`aou-memories-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json')
}

/* ── 视图四：我的 ───────────────────────────────────────── */

function renderMe(main) {
  const email = state.user?.email || '—'
  const loc = state.location
  const nick = state.profile?.nickname || ''
  const focus = state.profile?.focus || ''

  main.innerHTML = `
    <section class="hero sm">
      <h1>个人设置</h1>
      <p class="sub">账号信息与预测偏好。观测位置会影响天气、日照等本地化推导。</p>
    </section>

    <section class="panel">
      <h3>账号</h3>
      <div class="kv"><span>登录邮箱</span><b>${esc(email)}</b></div>
      <div class="kv"><span>数据归属</span><b>当前账号独有，其他用户不可见</b></div>
      <div class="row-actions"><button type="button" class="btn ghost" id="btn-out">退出登录</button></div>
    </section>

    <section class="panel">
      <h3>今日用量</h3>
      <div class="kv"><span>已用提问</span><b>${state.todayUsed} / ${DAILY_QUESTION_LIMIT} 次</b></div>
      <div class="kv"><span>今日剩余</span><b>${Math.max(0, DAILY_QUESTION_LIMIT - state.todayUsed)} 次</b></div>
      <p class="hint">每次预测都会真实调用一次大模型，计入本站所用云服务的资源点（每个应用每月额度有限）。
      为保证多人共用时不会被一个人刷穿，单账号每日上限 ${DAILY_QUESTION_LIMIT} 次，按本地时间 0:00 重置。
      被中断或推理失败的尝试不计数，但同样已经消耗了额度。</p>
    </section>

    <section class="panel">
      <h3>画像</h3>
      <label class="field"><span>称呼</span><input id="p-nick" type="text" value="${esc(nick)}" placeholder="模型如何称呼你" maxlength="30"></label>
      <label class="field"><span>长期关注</span><input id="p-focus" type="text" value="${esc(focus)}" placeholder="例如：宏观经济、技术趋势、竞赛规划" maxlength="120"></label>
      <label class="field"><span>观测位置</span>
        <select id="p-loc">
          ${PRESET_CITIES.map((c) => `<option value="${esc(c.label)}" ${c.label === loc.label ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
        </select>
      </label>
      <div class="row-actions">
        <span class="save-msg" id="save-msg"></span>
        <button type="button" class="btn primary" id="btn-save">保存设置</button>
      </div>
    </section>

    <section class="panel">
      <h3>数据接口</h3>
      <p class="hint">共 ${SOURCES.length} 路实时数据源。预测前按问题关键词自动挑选并并行抓取，
      单点失败不中断推理；其中 ${SOURCES.filter((s) => s.core).length} 路核心源每次必取。
      完整清单、方法论与校准口径都在「介绍」页。</p>
      <div class="row-actions">
        <span></span>
        <button type="button" class="btn" data-goto="intro">查看介绍页</button>
      </div>
    </section>

    <section class="panel">
      <h3>导出数据</h3>
      <p class="hint">你在这里产生的数据，随时可以带走。全部在你的浏览器里生成，不经过任何服务器。
      JSON 保留全部字段（含结构化结论与复盘记录），CSV 便于用表格软件打开。</p>
      <div class="export-actions">
        <button type="button" class="btn" id="exp-pred-json">预测档案 · JSON</button>
        <button type="button" class="btn" id="exp-pred-csv">预测档案 · CSV</button>
        <button type="button" class="btn" id="exp-mem-json">长期记忆 · JSON</button>
      </div>
    </section>
  `

  $('#btn-out', main).onclick = async () => {
    const ok = await confirmDialog({
      title: '退出登录？',
      body: '你的预测、记忆与设定都保存在云端，重新登录即可继续。',
      confirmText: '退出',
    })
    if (!ok) return
    await Auth.signOut()
  }

  $('#btn-save', main).onclick = async () => {
    const btn = $('#btn-save', main)
    const msg = $('#save-msg', main)
    btn.disabled = true
    try {
      const city = PRESET_CITIES.find((c) => c.label === $('#p-loc', main).value) || DEFAULT_LOCATION
      const prefs = { ...(state.profile?.prefs || {}), location: city }
      const saved = await Store.saveProfile({
        nickname: $('#p-nick', main).value.trim(),
        focus: $('#p-focus', main).value.trim(),
        prefs,
      })
      state.profile = saved || { ...state.profile, prefs }
      state.location = city
      msg.textContent = '已保存'
      msg.className = 'save-msg ok'
      setTimeout(() => (msg.textContent = ''), 2500)
    } catch (err) {
      msg.textContent = describeError(err)
      msg.className = 'save-msg error'
    } finally {
      btn.disabled = false
    }
  }

  bindGoto(main)

  $('#exp-pred-json', main).onclick = () => exportPredictionsJSON()
  $('#exp-pred-csv', main).onclick = () => exportPredictionsCSV()
  $('#exp-mem-json', main).onclick = () => exportMemoriesJSON()
}

/* ── 起跑 ───────────────────────────────────────────────── */

boot()
