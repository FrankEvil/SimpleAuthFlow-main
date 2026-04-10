// email/providers/tempmail-lol.js — Tempmail.lol 适配器

import { mailFetch, normalizeEmail } from '../email-common.js';

export function createTempmailLolProvider(_context) {
  return {
    id: 'tempmail_lol',
    name: 'Tempmail.lol',
    type: 'api',

    configFields: [
      { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://api.tempmail.lol/v2' },
    ],

    async generateEmail(config) {
      const { apiBase } = config;
      if (!apiBase) throw new Error('tempmail_lol 缺少 API 地址');

      const rs = await mailFetch('POST', `${apiBase}/inbox/create`, {
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: {},
      });
      const d = rs.data || {};
      const email = String(d.address || d.email || '').trim();
      const token = String(d.token || '').trim();
      if (!email || !token) throw new Error('tempmail_lol 创建邮箱失败');

      await chrome.storage.session.set({
        provider_state_tempmail_lol: { token, email },
      });

      return email;
    },

    async fetchEmails(config, filters = {}) {
      const { apiBase } = config;
      if (!apiBase) throw new Error('tempmail_lol 缺少 API 地址');

      const stateData = await chrome.storage.session.get('provider_state_tempmail_lol');
      const state = stateData.provider_state_tempmail_lol || {};
      const token = state.token;
      if (!token) throw new Error('tempmail_lol 缺少 token，请先生成邮箱');

      const rs = await mailFetch('GET',
        `${apiBase}/inbox?token=${encodeURIComponent(token)}`);
      const arr = (rs.data?.emails && Array.isArray(rs.data.emails))
        ? rs.data.emails : [];

      return arr.map((m, i) => normalizeEmail(m, 'tempmail_lol', i));
    },
  };
}
