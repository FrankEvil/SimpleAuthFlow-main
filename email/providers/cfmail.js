// email/providers/cfmail.js — CloudFlare Mail 适配器

import {
  mailFetch, authHeaders, normalizeEmail,
  normalizeDomain, normalizeDomains,
} from '../email-common.js';

export function createCfmailProvider(_context) {
  return {
    id: 'cfmail',
    name: 'CloudFlare Mail',
    type: 'api',

    configFields: [
      { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://cf-mail.example.com' },
      { key: 'apiKey', label: 'API 密钥', type: 'password', required: true, placeholder: 'Bearer Token' },
      { key: 'domains', label: '偏好域名', type: 'text', required: false, placeholder: '逗号分隔（可选，自动从 API 获取）' },
    ],

    async generateEmail(config) {
      const { apiBase, apiKey } = config;
      if (!apiBase) throw new Error('cfmail 缺少 API 地址');
      if (!apiKey) throw new Error('cfmail 缺少 API 密钥');

      const base = apiBase.replace(/\/+$/, '');
      const headers = authHeaders(apiKey, { 'Content-Type': 'application/json' });

      // 获取可用域名列表
      const dsRs = await mailFetch('GET', `${base}/api/domains`, { headers });
      const availDomains = Array.isArray(dsRs.data)
        ? dsRs.data.map(x => normalizeDomain(String(x || '')))
        : [];

      // 优先使用配置中的偏好域名
      const preferred = normalizeDomains(config.domains || []);
      let useDomain = '';
      for (const d of preferred) {
        if (availDomains.includes(d)) { useDomain = d; break; }
      }
      if (!useDomain && availDomains.length > 0) useDomain = availDomains[0];

      const idx = availDomains.indexOf(useDomain);
      if (idx < 0) throw new Error('cfmail 域名不在接口返回列表中');

      // 生成邮箱
      const geRs = await mailFetch('GET', `${base}/api/generate?domainIndex=${idx}`, { headers });
      const body = geRs.data || {};
      const email = String(body.email || body.address || '').trim();
      if (!email) throw new Error('cfmail 创建邮箱失败');

      await chrome.storage.session.set({
        provider_state_cfmail: { email },
      });

      return email;
    },

    async fetchEmails(config, filters = {}) {
      const { apiBase, apiKey } = config;
      if (!apiBase) throw new Error('cfmail 缺少 API 地址');
      if (!apiKey) throw new Error('cfmail 缺少 API 密钥');

      const base = apiBase.replace(/\/+$/, '');
      const email = filters.targetEmail;
      if (!email) return [];

      const headers = authHeaders(apiKey, { 'Content-Type': 'application/json' });
      const rs = await mailFetch('GET',
        `${base}/api/emails?mailbox=${encodeURIComponent(email)}&limit=20`,
        { headers });
      const arr = Array.isArray(rs.data) ? rs.data : [];

      // 逐条获取详情
      const results = [];
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        const mid = m?.id ? String(m.id) : '';
        if (!mid) { results.push(normalizeEmail(m, 'cfmail', i)); continue; }
        try {
          const dt = await mailFetch('GET', `${base}/api/email/${mid}`, { headers });
          results.push(normalizeEmail(dt.data || m, 'cfmail', i));
        } catch (_e) {
          results.push(normalizeEmail(m, 'cfmail', i));
        }
      }
      return results;
    },
  };
}
