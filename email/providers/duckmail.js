// email/providers/duckmail.js — Duckmail 适配器

import {
  mailFetch, authHeaders, normalizeEmail,
  pickDomain, buildPrefix,
} from '../email-common.js';

export function createDuckmailProvider(_context) {
  return {
    id: 'duckmail',
    name: 'Duckmail',
    type: 'api',

    configFields: [
      { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://api.duckmail.sbs' },
      { key: 'bearer', label: 'Admin Bearer Token', type: 'password', required: true, placeholder: '管理员 Bearer Token' },
      { key: 'domains', label: '域名列表', type: 'text', required: true, placeholder: '如 duckmail.sbs' },
    ],

    async generateEmail(config, options = {}) {
      const { apiBase, bearer } = config;
      if (!apiBase) throw new Error('duckmail 缺少 API 地址');
      if (!bearer) throw new Error('duckmail 缺少 bearer');

      const domain = pickDomain(config);
      if (!domain) throw new Error('duckmail 缺少可用域名');

      const prefix = buildPrefix(options.prefix);
      const email = `${prefix}@${domain}`;
      const pass = generateMailPassword();

      // 创建账号
      await mailFetch('POST', `${apiBase}/accounts`, {
        headers: authHeaders(bearer, { 'Content-Type': 'application/json' }),
        body: { address: email, password: pass },
      });

      // 获取 token
      const tkRs = await mailFetch('POST', `${apiBase}/token`, {
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: { address: email, password: pass },
      });
      const token = String(tkRs.data?.token || '').trim();
      if (!token) throw new Error('duckmail token 获取失败');

      await chrome.storage.session.set({
        provider_state_duckmail: { token, email, password: pass },
      });

      return email;
    },

    async fetchEmails(config, filters = {}) {
      const { apiBase } = config;
      if (!apiBase) throw new Error('duckmail 缺少 API 地址');

      const stateData = await chrome.storage.session.get('provider_state_duckmail');
      const state = stateData.provider_state_duckmail || {};
      const token = state.token;
      if (!token) throw new Error('duckmail 缺少 token，请先生成邮箱');

      const rs = await mailFetch('GET', `${apiBase}/messages`, {
        headers: authHeaders(token),
      });
      const b = rs.data || {};
      const arr = Array.isArray(b['hydra:member']) ? b['hydra:member']
        : Array.isArray(b.member) ? b.member
        : Array.isArray(b.data) ? b.data
        : [];

      // 逐条获取详情
      const results = [];
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        const mid = String(m.id || m['@id'] || '').split('/').pop();
        if (!mid) { results.push(normalizeEmail(m, 'duckmail', i)); continue; }
        try {
          const dt = await mailFetch('GET', `${apiBase}/messages/${mid}`, {
            headers: authHeaders(token),
          });
          results.push(normalizeEmail(dt.data || m, 'duckmail', i));
        } catch (_e) {
          results.push(normalizeEmail(m, 'duckmail', i));
        }
      }
      return results;
    },
  };
}

function generateMailPassword(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
