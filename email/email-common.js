// email/email-common.js — 邮箱模块公共工具：统一格式、验证码提取、HTTP 辅助

/**
 * 统一邮件格式
 * @typedef {Object} UnifiedEmail
 * @property {string} id       - 渠道前缀 + 原始 ID，如 "yyds:abc123"
 * @property {string} subject  - 邮件主题
 * @property {string} from     - 发送人
 * @property {string} text     - 纯文本内容
 * @property {number} time     - 时间戳 (ms)
 */

// ── 验证码提取 ──────────────────────────────────────────────

/**
 * 从文本中提取 6 位验证码，兼容中英文格式
 */
export function extractVerificationCode(text) {
  if (!text) return null;
  // HTML 特征码（OpenAI 邮件背景色块）
  const m0 = text.match(/background-color:\s*#F3F3F3[^>]*>[\s\S]*?(\d{6})[\s\S]*?<\/p>/i);
  if (m0?.[1] && m0[1] !== '177010') return m0[1];
  // 中文格式
  const mCn = text.match(/(?:代码为|验证码)[^0-9]*?[\s：:]*(\d{6})/);
  if (mCn?.[1]) return mCn[1];
  // 英文格式
  const mEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (mEn) return mEn[1] || mEn[2];
  // Subject 行
  const mSub = text.match(/Subject:.*?(\d{6})/i);
  if (mSub?.[1] && mSub[1] !== '177010') return mSub[1];
  // 标签包裹
  const pats = [/>\s*(\d{6})\s*</g, /(?<![#&])\b(\d{6})\b/g];
  for (const pat of pats) {
    let mt;
    while ((mt = pat.exec(text)) !== null) {
      if (mt[1] && mt[1] !== '177010') return mt[1];
    }
  }
  // 回退：4-8 位数字
  const fb = text.match(/\b(\d{4,8})\b/);
  return fb ? fb[1] : null;
}

// ── HTML / 文本处理 ─────────────────────────────────────────

/**
 * 在 Service Worker 环境中将 HTML 转为纯文本（无 DOM 可用）
 */
export function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 将邮件对象各字段组合为可供验证码提取的文本
 */
export function mailToText(mailObj) {
  if (!mailObj || typeof mailObj !== 'object') return '';
  const parts = [];
  for (const k of ['subject', 'body', 'text', 'html', 'intro', 'content', 'html_content']) {
    const v = mailObj[k];
    if (v == null) continue;
    if (Array.isArray(v)) { v.forEach(it => parts.push(String(it || ''))); continue; }
    if (typeof v === 'object') { parts.push(JSON.stringify(v)); continue; }
    parts.push(String(v));
  }
  const f = mailObj.from;
  if (f && typeof f === 'object') {
    parts.push(String(f.name || ''), String(f.address || f.email || ''));
  } else if (f) {
    parts.push(String(f));
  }
  return parts.filter(Boolean).join(' ').trim();
}

// ── 时间处理 ────────────────────────────────────────────────

/**
 * 将各种时间格式统一为毫秒时间戳
 */
export function toTimestamp(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') {
    if (v > 1e15) return v;               // 已是毫秒
    if (v > 1e12) return Math.round(v);    // 接近毫秒
    if (v > 0) return v * 1000;            // 秒 → 毫秒
    return 0;
  }
  const s = String(v).trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (n > 1e12) return Math.round(n);
    return n > 0 ? Math.round(n * 1000) : 0;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 从邮件原始对象中提取时间戳（毫秒）
 */
export function extractMailTimestamp(mailObj) {
  if (!mailObj || typeof mailObj !== 'object') return 0;
  for (const k of ['received_at', 'receivedAt', 'created_at', 'createdAt', 'date', 'timestamp', 'time']) {
    if (mailObj[k] != null) {
      const ts = toTimestamp(mailObj[k]);
      if (ts > 0) return ts;
    }
  }
  return 0;
}

// ── 统一邮件格式映射 ────────────────────────────────────────

/**
 * 将各渠道的原始邮件对象映射为统一格式
 * @param {Object} raw    - 原始邮件对象
 * @param {string} source - 渠道 ID（如 "yyds_mail"）
 * @param {number} [idx]  - 序号（回退 ID 用）
 * @returns {UnifiedEmail}
 */
export function normalizeEmail(raw, source, idx = 0) {
  const fromField = raw.from;
  let from;
  if (fromField && typeof fromField === 'object') {
    from = fromField.address || fromField.email || fromField.name || '未知';
  } else {
    from = raw.from_address || raw.from_mail || raw.from || raw.sender || '未知';
  }

  const rawId = raw.id || raw.message_id || raw.mail_id || raw.uuid || raw.mailId || '';
  const id = `${source}:${rawId || idx}`;

  const textContent = raw.text || raw.body || raw.content || '';
  const htmlContent = raw.html || raw.html_content || '';
  const text = textContent || stripHtml(htmlContent);

  return {
    id,
    subject: raw.subject || raw.title || '(无主题)',
    from: String(from),
    text,
    time: extractMailTimestamp(raw),
  };
}

// ── 域名工具 ────────────────────────────────────────────────

export function normalizeDomain(v) {
  return String(v || '').trim().replace(/^[@.]+/, '').replace(/\.+$/, '');
}

export function normalizeDomains(v) {
  const out = [];
  const add = (x) => {
    const d = normalizeDomain(x);
    if (d && !out.includes(d)) out.push(d);
  };
  if (Array.isArray(v)) { v.forEach(add); return out; }
  String(v || '').split(/[\n,;]+/).forEach(add);
  return out;
}

export function pickDomain(cfg = {}) {
  const arr = normalizeDomains(cfg.domains || []);
  if (arr.length > 0) return arr[Math.floor(Math.random() * arr.length)];
  return normalizeDomain(cfg.domain || '');
}

export function randomLocalPart(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * 构建邮箱地址前缀：清洗输入或自动生成
 */
export function buildPrefix(input = '') {
  let p = String(input || '').trim().toLowerCase();
  p = p.replace(/[^a-z0-9._-]/g, '').replace(/^[@.]+/, '').replace(/\.+$/, '');
  return p || ('oc' + randomLocalPart(10));
}

// ── HTTP 工具 ────────────────────────────────────────────────

/**
 * 通用 fetch 封装，用于 API 类 Provider 在 Service Worker 中调用
 */
export async function mailFetch(method, url, options = {}) {
  const init = {
    method: method || 'GET',
    headers: { 'Accept': 'application/json', ...(options.headers || {}) },
  };
  if (options.body) {
    init.body = JSON.stringify(options.body);
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
  }

  const controller = new AbortController();
  const timeout = options.timeout || 20000;
  const timer = setTimeout(() => controller.abort(), timeout);
  init.signal = controller.signal;

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('请求超时');
    throw new Error('网络错误: ' + err.message);
  }
  clearTimeout(timer);

  let data = null;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : {};
  } catch (_e) { /* 解析失败忽略 */ }

  if (response.ok) return { status: response.status, data, text: '' };

  const msg = (data && (data.error || data.message || data.detail)) || ('HTTP ' + response.status);
  throw new Error(msg);
}

/**
 * 构建 Bearer 认证请求头
 */
export function authHeaders(token, extra = {}) {
  const h = { 'Accept': 'application/json', ...extra };
  const t = (token || '').trim();
  if (t) h.Authorization = /^bearer\s+/i.test(t) ? t : ('Bearer ' + t);
  return h;
}

/**
 * 拼接 URL
 */
export function joinUrl(baseUrl, pathname) {
  const base = String(baseUrl || '').trim();
  if (!base) return String(pathname || '').trim();
  const normalizedBase = /\/$/.test(base) ? base : (base + '/');
  const normalizedPath = String(pathname || '').replace(/^\/+/, '');
  return new URL(normalizedPath, normalizedBase).toString();
}

// ── TempMail Plus 中继（DuckDuckGo 和 custom-domain 共用）──

const TEMPMAIL_PLUS_API = 'https://tempmail.plus/api';

/**
 * 通过 TempMail Plus API 获取邮件列表
 */
export async function fetchFromTempMailPlus(tmAddr, tmEpin, source = 'tempmail') {
  const addr = String(tmAddr || '').trim();
  const epin = String(tmEpin || '').trim();
  if (!addr) throw new Error(`${source} 缺少 TempMail 取件邮箱`);

  // 获取收件箱列表
  const inboxUrl = `${TEMPMAIL_PLUS_API}/mails?email=${encodeURIComponent(addr)}&epin=${epin || ''}`;
  const inbox = await mailFetch('GET', inboxUrl);
  const mailList = (inbox.data && Array.isArray(inbox.data.mail_list)) ? inbox.data.mail_list : [];

  const results = [];
  for (let i = 0; i < mailList.length; i++) {
    const m = mailList[i];
    let detail = {};
    try {
      const detailUrl = `${TEMPMAIL_PLUS_API}/mails/${m.mail_id}?email=${encodeURIComponent(addr)}&epin=${epin || ''}`;
      const detResp = await mailFetch('GET', detailUrl);
      detail = detResp.data || {};
    } catch (_e) { /* 详情获取失败用摘要 */ }

    results.push(normalizeEmail({
      id: m.mail_id,
      subject: detail.subject || m.subject || '(无主题)',
      from: detail.from_mail || m.from_mail || '未知',
      text: detail.text || '',
      html: detail.html || '',
      time: m.time || '',
    }, source, i));
  }
  return results;
}

// ── DuckDuckGo TempMail 中继获取邮件 ───────────────────────

/**
 * 从 TempMail 中继获取 DuckDuckGo 转发的邮件
 * 响应格式不确定，递归查找邮件数组
 */
export async function fetchDuckDuckGoRelayEmails(inboxBaseUrl, jwt, source = 'duckduckgo') {
  if (!inboxBaseUrl) throw new Error('duckduckgo 缺少 Temp Mail Address');
  if (!jwt) throw new Error('duckduckgo 缺少 Temp Mail JWT');

  const headers = authHeaders(jwt, { 'Content-Type': 'application/json' });
  const url = joinUrl(inboxBaseUrl, '/api/mails') + '?limit=20&offset=0';
  const rs = await mailFetch('GET', url, { headers });

  const records = findTempMailRecords(rs.data);
  return records.map((m, i) => normalizeEmail(m, source, i));
}

/**
 * 递归查找 TempMail 中继响应中的邮件数组
 */
function findTempMailRecords(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeTempMailRecord).filter(Boolean);
    if (normalized.length > 0) return normalized;
    for (const item of value) {
      const nested = findTempMailRecords(item);
      if (nested.length > 0) return nested;
    }
    return [];
  }
  if (!value || typeof value !== 'object') return [];
  for (const key of ['data', 'mails', 'items', 'list', 'rows', 'records', 'result', 'results']) {
    if (value[key] !== undefined) {
      const nested = findTempMailRecords(value[key]);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

/**
 * 标准化 TempMail 中继记录
 */
function normalizeTempMailRecord(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const text = String(msg.text || msg.body || msg.plain || '').trim()
    || stripHtml(String(msg.html || msg.html_content || ''));
  const from = String(msg.from || msg.sender || msg.from_address || '未知').trim();
  const subject = String(msg.subject || msg.title || '(无主题)').trim();
  const date = String(msg.receivedAt || msg.received_at || msg.createdAt
    || msg.created_at || msg.date || msg.timestamp || '').trim();
  return {
    id: msg.id || msg.mail_id || msg.mailId || '',
    subject,
    from,
    text,
    html: String(msg.html || msg.html_content || ''),
    time: date,
  };
}
