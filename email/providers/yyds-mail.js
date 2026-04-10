// email/providers/yyds-mail.js — YYDS Mail 适配器

import {
  mailFetch, authHeaders, normalizeEmail,
  pickDomain, buildPrefix,
} from '../email-common.js';

export function createYydsMailProvider(_context) {
  return {
    id: 'yyds_mail',
    name: 'YYDS Mail',
    type: 'api',

    configFields: [
      { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://maliapi.215.im/v1' },
      { key: 'apiKey', label: 'API 密钥', type: 'password', required: false, placeholder: 'X-API-Key（可选）' },
      { key: 'domains', label: '域名列表', type: 'text', required: false, placeholder: '逗号分隔（可选）' },
    ],

    /**
     * 创建邮箱账号并返回地址
     * 创建成功后将 token 存入 session storage 供 fetchEmails 使用
     */
    async generateEmail(config, options = {}) {
      const { apiBase, apiKey } = config;
      if (!apiBase) throw new Error('yyds_mail 缺少 API 地址');

      const prefix = buildPrefix(options.prefix);
      const body = { address: prefix };
      const domain = pickDomain(config);
      if (domain) body.domain = domain;

      const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      };
      if (apiKey) headers['X-API-Key'] = apiKey;

      const rs = await mailFetch('POST', `${apiBase}/accounts`, { headers, body });
      const d = rs.data?.data || rs.data || {};
      const email = (d.address || '').trim();
      const token = (d.token || '').trim();
      if (!email || !token) throw new Error('yyds_mail 创建邮箱失败');

      // 将 token 存入 session，fetchEmails 时使用
      await chrome.storage.session.set({
        provider_state_yyds_mail: {
          token,
          accountId: d.id || '',
          email,
        },
      });

      return email;
    },

    async fetchEmails(config, filters = {}) {
      const { apiBase, apiKey } = config;
      if (!apiBase) throw new Error('yyds_mail 缺少 API 地址');

      // 读取 token
      const stateData = await chrome.storage.session.get('provider_state_yyds_mail');
      const state = stateData.provider_state_yyds_mail || {};
      const token = state.token;
      if (!token) throw new Error('yyds_mail 缺少 mailbox token，请先生成邮箱');

      const headers = authHeaders(token);
      if (apiKey) headers['X-API-Key'] = apiKey;

      const rs = await mailFetch('GET', `${apiBase}/messages`, { headers });
      const b = rs.data || {};
      const arr = Array.isArray(b.data) ? b.data
        : (b.data?.messages && Array.isArray(b.data.messages)) ? b.data.messages
        : (Array.isArray(b.messages) ? b.messages : []);

      return arr.map((m, i) => normalizeEmail(m, 'yyds_mail', i));
    },
  };
}
