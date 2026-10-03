// ─────────────────────────────────────────────────────────────
// 云服务公开配置 + 品牌常量
// 这三个字段由云服务开通时下发（publicConfig），是唯一允许进入前端的凭证。
// publishableKey 只标识「哪个应用」，本身不带权限；服务端会强校验 Origin。
// ─────────────────────────────────────────────────────────────
export const PUBLIC_CONFIG = {
  resourceId: 'wbcs_50tmwB6ghr1r7grqcV5WeT',
  endpoint: 'https://world-model-54082.app.workbuddy.host',
  publishableKey:
    'wbpk_DwZLHHxG3thy2Z7Fv1EkWd_Al4SrmNMT5UNoj3Zl7h1zpJUG7aWgD3E',
}

/* ── 品牌 ────────────────────────────────────────────────
   产品名固定为英文正名，短名用于顶栏/图标等空间受限处。 */
export const APP_NAME = 'Anticipation of Uncertainty'
export const APP_SHORT = 'AoU'
export const APP_TAGLINE = 'UNCERTAINTY FORECASTING'
export const APP_NAME_CN = '不确定性前瞻'
export const APP_ONE_LINER = '把「未来会怎样」变成一个到期可核对、错了能说清哪里错了的命题。'

// 默认观测点：重庆 · 万州
export const DEFAULT_LOCATION = {
  label: '重庆 · 万州',
  latitude: 30.8076,
  longitude: 108.4086,
}

/* ── 使用额度 ────────────────────────────────────────────
   本应用每一次预测都会真实调用一次大模型，计入站点所有者的云服务资源点。
   对单个账号设每日上限，是为了让一批人共用时不会被一个人刷穿。
   复刻部署的人可以按自己的额度情况调整这个数。 */
export const DAILY_QUESTION_LIMIT = 10

// 单次提问的长度上限，避免把超长文本塞进上下文白烧额度
export const MAX_QUESTION_CHARS = 300

// 关注领域（用于档案分类与界面标签）
export const DOMAINS = [
  { id: 'general', label: '综合' },
  { id: 'market', label: '市场' },
  { id: 'weather', label: '天气气候' },
  { id: 'tech', label: '技术' },
  { id: 'society', label: '社会' },
  { id: 'science', label: '科学' },
  { id: 'personal', label: '个人' },
]
