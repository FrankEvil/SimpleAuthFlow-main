// email/providers/duckduckgo.js — DuckDuckGo 隐私别名邮箱适配器

import {
  mailFetch, authHeaders, normalizeEmail,
  normalizeDomain, fetchDuckDuckGoRelayEmails,
} from '../email-common.js';

export function createDuckDuckGoProvider(_context) {
  return {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    type: 'api',

    configFields: [
      { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://quack.duckduckgo.com' },
      { key: 'token', label: 'DDG Token', type: 'password', required: true, placeholder: 'DuckDuckGo API Token' },
      { key: 'aliasDomain', label: '别名域名', type: 'text', required: false, placeholder: 'duck.com' },
      { key: 'tempMailAddress', label: 'TempMail 中继地址', type: 'text', required: true, placeholder: '收件中继 Base URL' },
      { key: 'tempMailJwt', label: 'TempMail JWT', type: 'password', required: true, placeholder: '中继认证 JWT' },
    ],

    async generateEmail(config) {
      const { apiBase, token } = config;
      if (!apiBase) throw new Error('duckduckgo 缺少 API 地址');
      if (!token) throw new Error('duckduckgo 缺少 token');

      const aliasDomain = normalizeDomain(config.aliasDomain || 'duck.com') || 'duck.com';

      // 最多尝试 3 次，避免生成重复地址
      for (let attempt = 0; attempt < 3; attempt++) {
        const rs = await mailFetch('POST', `${apiBase}/api/email/addresses`, {
          headers: authHeaders(token, { 'Content-Type': 'application/json' }),
          body: {},
        });
        const localPart = String(rs.data?.address || '').trim().replace(/@.*$/, '');
        if (!localPart) throw new Error('duckduckgo 创建邮箱失败：未返回 alias');

        const addr = `${localPart}@${aliasDomain}`;

        await chrome.storage.session.set({
          provider_state_duckduckgo: { email: addr, localPart },
        });

        return addr;
      }
      throw new Error('duckduckgo 连续生成重复邮箱');
    },

    async fetchEmails(config, filters = {}) {
      const inboxBaseUrl = String(config.tempMailAddress || '').trim();
      const jwt = String(config.tempMailJwt || '').trim();

      return await fetchDuckDuckGoRelayEmails(inboxBaseUrl, jwt, 'duckduckgo');
    },
  };
}
