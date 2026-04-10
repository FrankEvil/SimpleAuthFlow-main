// email/providers/self-hosted-mail.js — 自建邮件 API 适配器

import {
  mailFetch, authHeaders, normalizeEmail,
  pickDomain, buildPrefix,
} from '../email-common.js';

export function createSelfHostedMailProvider(_context) {
  return {
    id: 'self_hosted_mail_api',
    name: 'Self-Hosted Mail API',
    type: 'api',

    configFields: [
      { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://mail.example.com' },
      { key: 'apiKey', label: 'API 密钥', type: 'password', required: true, placeholder: 'Bearer Token' },
      { key: 'domains', label: '域名列表', type: 'text', required: true, placeholder: '逗号分隔，如 example.com,mail.org' },
    ],

    async generateEmail(config, options = {}) {
      const domain = pickDomain(config);
      if (!domain) throw new Error('self_hosted_mail_api 缺少可用域名');
      const prefix = buildPrefix(options.prefix);
      return `${prefix}@${domain}`;
    },

    async fetchEmails(config, filters = {}) {
      const { apiBase, apiKey } = config;
      if (!apiBase || !apiKey) throw new Error('self_hosted_mail_api 缺少 API 配置');
      const email = filters.targetEmail;
      if (!email) return [];

      const base = apiBase.replace(/\/+$/, '');

      // 优先尝试完整邮件列表接口
      try {
        const rs = await mailFetch('GET',
          `${base}/api/emails/${encodeURIComponent(email)}/messages`,
          { headers: authHeaders(apiKey) });
        const data = rs.data;
        const arr = Array.isArray(data) ? data
          : (data?.messages && Array.isArray(data.messages)) ? data.messages
          : (data?.data?.messages && Array.isArray(data.data.messages)) ? data.data.messages
          : (data?.data && Array.isArray(data.data)) ? data.data
          : [];
        if (arr.length > 0) {
          return arr.map((m, i) => normalizeEmail(m, 'self_hosted_mail_api', i));
        }
      } catch (e) {
        _context?.addLog?.(`self_hosted_mail_api 邮件列表接口失败: ${e.message}`, 'warn');
      }

      // 回退：最新一封邮件接口
      try {
        const rs = await mailFetch('GET',
          `${base}/api/latest?address=${encodeURIComponent(email)}`,
          { headers: authHeaders(apiKey) });
        const d = rs.data;
        const mailObj = (d?.ok && d?.email && typeof d.email === 'object') ? d.email
          : (d?.email && typeof d.email === 'object') ? d.email
          : (d?.subject || d?.body || d?.text) ? d
          : null;
        if (mailObj) return [normalizeEmail(mailObj, 'self_hosted_mail_api', 0)];
      } catch (_e) { /* 回退也失败则返回空 */ }

      return [];
    },
  };
}
