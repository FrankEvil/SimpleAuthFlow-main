// email/providers/custom-domain.js — 自定义域名 + TempMail Plus 中继适配器

import { buildPrefix, fetchFromTempMailPlus } from '../email-common.js';

export function createCustomDomainProvider(_context) {
  return {
    id: 'custom_domain_tempmail',
    name: '自定义域名 (TempMail)',
    type: 'api',

    configFields: [
      { key: 'domains', label: '域名列表', type: 'text', required: true, placeholder: '逗号分隔，如 example.com,mail.org' },
      { key: 'tmAddr', label: 'TempMail 取件邮箱', type: 'text', required: true, placeholder: 'xxx@tempmail.plus' },
      { key: 'tmEpin', label: 'TempMail PIN', type: 'password', required: false, placeholder: '取件 PIN（可选）' },
    ],

    async generateEmail(config, options = {}) {
      const domains = (config.domains || '').split(/[\n,;]+/)
        .map(d => d.trim().replace(/^[@.]+/, '').replace(/\.+$/, ''))
        .filter(Boolean);
      if (domains.length === 0) throw new Error('custom_domain_tempmail 缺少可用域名');

      const domain = domains[Math.floor(Math.random() * domains.length)];
      const prefix = buildPrefix(options.prefix);

      return `${prefix}@${domain}`;
    },

    async fetchEmails(config, _filters = {}) {
      const tmAddr = String(config.tmAddr || '').trim();
      const tmEpin = String(config.tmEpin || '').trim();

      return await fetchFromTempMailPlus(tmAddr, tmEpin, 'custom_domain_tempmail');
    },
  };
}
