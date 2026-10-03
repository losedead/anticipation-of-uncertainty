// ─────────────────────────────────────────────────────────────
// 认证模块（Web 端仅支持邮箱体系）
// 四条路径齐备：密码登录 / 邮箱验证码登录 / 邮箱验证码注册（带密码）/ 找回密码
// ─────────────────────────────────────────────────────────────
import { getCloud, describeError } from './cloud.js'
import { LOGOMARK } from './brand.js'

let pendingOtp = null // { email, verificationId, isExistingUser }
let resendTimer = null

export async function getSession() {
  const { data, error } = await getCloud().auth.getSession()
  if (error) return null
  return data ?? null
}

export async function signOut() {
  await getCloud().auth.signOut()
}

export function onAuthChange(cb) {
  return getCloud().auth.onAuthStateChange(cb)
}

/* ── 视图 ───────────────────────────────────────────────── */

const TABS = [
  { id: 'password', label: '密码登录' },
  { id: 'otp', label: '验证码登录' },
  { id: 'signup', label: '注册' },
]

export function renderAuthView(root, { onSignedIn } = {}) {
  let mode = 'password'
  let busy = false

  root.innerHTML = `
    <div class="auth-shell">
      <aside class="auth-intro">
        <div class="auth-intro-inner">
          <div class="brand brand-lg">
            <span class="brand-mark">${LOGOMARK}</span>
            <span class="brand-text">
              <b>Anticipation of Uncertainty</b>
              <i>UNCERTAINTY FORECASTING</i>
            </span>
          </div>

          <h2 class="auth-headline">别再把猜测<br>说得像判断。</h2>

          <p class="auth-lead">
            完整的方法论、数据源与校准口径都在<a href="#" id="to-intro" class="auth-intro-link">介绍页</a>。
            这里只说注册之后你立刻能得到什么。
          </p>

          <ul class="auth-points">
            <li>
              <b>一台完整的预测工作台</b>
              <span>提问、档案、复盘、长期记忆四个视图即刻可用，不需要任何配置。</span>
            </li>
            <li>
              <b>一个只属于你的空间</b>
              <span>预测、记忆、档案按账号物理隔离——数据库层强制，其他注册用户看不见你的任何一条数据。</span>
            </li>
            <li>
              <b>每天若干次提问额度</b>
              <span>每次提问都是一次真实的全流程推演。额度每日重置，用量在工作台实时可见。</span>
            </li>
            <li>
              <b>随时带走你的数据</b>
              <span>预测档案与记忆可一键导出为 JSON / CSV，数据在你手里，不在站里。</span>
            </li>
          </ul>

          <p class="auth-fine">邮箱是唯一登录方式 · 不收集姓名、手机号等身份信息 · 不对外提供任何数据</p>
        </div>
      </aside>

      <section class="auth-panel">
        <div class="auth-card">
          <div class="auth-card-head">
            <span class="auth-badge">AoU</span>
            <div>
              <h1>进入工作台</h1>
              <p>登录后开始提问、建档与复盘</p>
            </div>
          </div>

          <div class="tabs" id="auth-tabs">
            ${TABS.map((t) => `<button type="button" class="tab" data-mode="${t.id}">${t.label}</button>`).join('')}
          </div>
          <form class="auth-form" id="auth-form" novalidate>
            <div id="auth-fields"></div>
            <button type="submit" class="btn primary block" id="auth-submit">继续</button>
          </form>
          <p class="auth-msg" id="auth-msg"></p>
          <p class="auth-foot">邮箱是唯一登录方式；数据按账号隔离，仅你本人可见。</p>
        </div>
      </section>
    </div>
  `

  const tabsEl = root.querySelector('#auth-tabs')
  const fieldsEl = root.querySelector('#auth-fields')
  const msgEl = root.querySelector('#auth-msg')
  const submitEl = root.querySelector('#auth-submit')
  const formEl = root.querySelector('#auth-form')

  // 左栏「介绍页」链接 → 由 app.js 接管（未登录时回到公开落地页）
  root.querySelector('#to-intro')?.addEventListener('click', (e) => {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('aou:show-intro'))
  })

  const setTab = (m) => {
    mode = m
    pendingOtp = null
    tabsEl.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === m))
    renderFields()
    setMsg('')
  }

  const setMsg = (text, kind = '') => {
    msgEl.textContent = text || ''
    msgEl.className = 'auth-msg' + (kind ? ' ' + kind : '')
  }

  const setBusy = (v) => {
    busy = v
    submitEl.disabled = v
    submitEl.textContent = v ? '处理中…' : mode === 'signup' ? '注册并登录' : '继续'
    fieldsEl.querySelectorAll('button, input').forEach((el) => {
      if (el.dataset.neverDisable) return
      el.disabled = v
    })
  }

  function renderFields() {
    if (mode === 'password') {
      fieldsEl.innerHTML = `
        <label class="field"><span>邮箱</span><input type="email" id="f-email" autocomplete="email" placeholder="you@example.com" required></label>
        <label class="field"><span>密码</span><input type="password" id="f-password" autocomplete="current-password" placeholder="至少 8 位" required></label>
        <div class="row-between">
          <span></span>
          <button type="button" class="link" id="to-reset">忘记密码？</button>
        </div>`
      fieldsEl.querySelector('#to-reset').onclick = () => setMode('reset')
    } else if (mode === 'otp') {
      fieldsEl.innerHTML = `
        <label class="field"><span>邮箱</span><input type="email" id="f-email" autocomplete="email" placeholder="you@example.com" required></label>
        <label class="field"><span>验证码</span>
          <div class="inline">
            <input type="text" id="f-token" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位数字" required>
            <button type="button" class="btn ghost" id="btn-send">获取验证码</button>
          </div>
        </label>`
      fieldsEl.querySelector('#btn-send').onclick = sendOtp
    } else if (mode === 'signup') {
      fieldsEl.innerHTML = `
        <label class="field"><span>邮箱</span><input type="email" id="f-email" autocomplete="email" placeholder="you@example.com" required></label>
        <label class="field"><span>验证码</span>
          <div class="inline">
            <input type="text" id="f-token" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位数字" required>
            <button type="button" class="btn ghost" id="btn-send">获取验证码</button>
          </div>
        </label>
        <label class="field"><span>设置密码</span><input type="password" id="f-password" autocomplete="new-password" placeholder="至少 8 位" required></label>`
      fieldsEl.querySelector('#btn-send').onclick = sendOtp
    } else if (mode === 'reset') {
      fieldsEl.innerHTML = `
        <label class="field"><span>邮箱</span><input type="email" id="f-email" autocomplete="email" placeholder="you@example.com" required></label>
        <label class="field"><span>验证码</span>
          <div class="inline">
            <input type="text" id="f-token" inputmode="numeric" placeholder="6 位数字" required>
            <button type="button" class="btn ghost" id="btn-send">获取验证码</button>
          </div>
        </label>
        <label class="field"><span>新密码</span><input type="password" id="f-password" autocomplete="new-password" placeholder="至少 8 位" required></label>
        <div class="row-between"><button type="button" class="link" id="to-login">返回登录</button><span></span></div>`
      fieldsEl.querySelector('#btn-send').onclick = sendOtp
      fieldsEl.querySelector('#to-login').onclick = () => setMode('password')
    }
    setBusy(false)
  }

  function setMode(m) {
    mode = m
    tabsEl.style.display = m === 'reset' ? 'none' : ''
    tabsEl.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === m))
    renderFields()
    setMsg('')
  }

  /* OTP 发送：只在「获取验证码」按钮触发；提交按钮绝不再发码 */
  async function sendOtp() {
    const email = fieldsEl.querySelector('#f-email')?.value?.trim()
    if (!email) return setMsg('请先填写邮箱。', 'error')
    const btn = fieldsEl.querySelector('#btn-send')
    btn.disabled = true
    btn.textContent = '发送中…'
    try {
      const sent = await getCloud().auth.sendOtp({ email })
      if (sent.error) throw sent.error
      pendingOtp = {
        email,
        verificationId: sent.data.verificationId,
        isExistingUser: sent.data.isExistingUser,
      }
      setMsg('验证码已发送，请查收邮箱。', 'ok')
      let left = 60
      clearInterval(resendTimer)
      resendTimer = setInterval(() => {
        left -= 1
        if (left <= 0) {
          clearInterval(resendTimer)
          btn.disabled = false
          btn.textContent = '重新发送'
        } else {
          btn.textContent = `${left}s`
        }
      }, 1000)
    } catch (err) {
      setMsg(describeError(err), 'error')
      btn.disabled = false
      btn.textContent = '获取验证码'
    }
  }

  /* 表单提交：只做验证 / 登录 / 注册，不发新码 */
  formEl.onsubmit = async (e) => {
    e.preventDefault()
    if (busy) return
    const email = fieldsEl.querySelector('#f-email')?.value?.trim()
    const password = fieldsEl.querySelector('#f-password')?.value
    const token = fieldsEl.querySelector('#f-token')?.value?.trim()

    if (!email) return setMsg('请填写邮箱。', 'error')

    setBusy(true)
    setMsg('')
    try {
      if (mode === 'password') {
        if (!password) throw new Error('请填写密码。')
        const { data, error } = await getCloud().auth.signInWithPassword({ email, password })
        if (error) throw error
        return onSignedIn?.(data?.user ?? null)
      }

      if (mode === 'reset') {
        if (!token || !password) throw new Error('请填写验证码与新密码。')
        if (!pendingOtp || pendingOtp.email !== email) {
          throw new Error('请先获取当前邮箱的验证码。')
        }
        const started = await getCloud().auth.resetPasswordForEmail(email)
        if (started.error) throw started.error
        const done = await started.data.updateUser({ nonce: token, password })
        if (done.error) throw done.error
        pendingOtp = null
        return onSignedIn?.(done.data?.user ?? null)
      }

      // OTP 登录 / 注册
      if (!token) throw new Error('请填写验证码。')
      if (!pendingOtp || pendingOtp.email !== email) {
        throw new Error('请先获取当前邮箱的验证码。')
      }
      if (mode === 'signup' && !password) throw new Error('请设置密码（至少 8 位）。')

      const payload = {
        email: pendingOtp.email,
        verificationId: pendingOtp.verificationId,
        isExistingUser: pendingOtp.isExistingUser,
        token,
      }
      // 仅新账号在注册路径带上密码；已有账号走登录，不覆盖密码
      if (mode === 'signup' && pendingOtp.isExistingUser === false) payload.password = password

      const done = await getCloud().auth.verifyOtp(payload)
      if (done.error) throw done.error
      pendingOtp = null
      onSignedIn?.(done.data?.user ?? null)
    } catch (err) {
      setMsg(describeError(err), 'error')
      setBusy(false)
    }
  }

  tabsEl.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode)
  })

  setMode('password')
}
