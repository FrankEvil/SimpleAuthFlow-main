// email/email-provider.js — Provider 注册表与调度

import { createBurnerMailboxProvider } from './providers/burner-mailbox.js';
import { createSelfHostedMailProvider } from './providers/self-hosted-mail.js';
import { createYydsMailProvider } from './providers/yyds-mail.js';
import { createTempmailLolProvider } from './providers/tempmail-lol.js';
import { createDuckmailProvider } from './providers/duckmail.js';
import { createCfmailProvider } from './providers/cfmail.js';
import { createDuckDuckGoProvider } from './providers/duckduckgo.js';
import { createCustomDomainProvider } from './providers/custom-domain.js';
import { extractVerificationCode, mailToText } from './email-common.js';

// ── Provider 工厂注册表 ─────────────────────────────────────

const PROVIDER_FACTORIES = {
  burner_mailbox: createBurnerMailboxProvider,
  self_hosted_mail_api: createSelfHostedMailProvider,
  yyds_mail: createYydsMailProvider,
  tempmail_lol: createTempmailLolProvider,
  duckmail: createDuckmailProvider,
  cfmail: createCfmailProvider,
  duckduckgo: createDuckDuckGoProvider,
  custom_domain_tempmail: createCustomDomainProvider,
};

// 缓存当前激活的 Provider 实例
let _activeProvider = null;
let _activeProviderId = null;

// ── 配置读写 ────────────────────────────────────────────────

/**
 * 获取当前选中的 Provider ID
 */
export async function getActiveProviderId() {
  const settings = await chrome.storage.local.get('emailProvider');
  return settings.emailProvider || 'burner_mailbox';
}

/**
 * 获取指定 Provider 的用户配置
 */
export async function getProviderConfig(providerId) {
  const settings = await chrome.storage.local.get('providerConfigs');
  return (settings.providerConfigs && settings.providerConfigs[providerId]) || {};
}

/**
 * 保存 Provider 配置
 */
export async function saveProviderConfig(providerId, config) {
  const settings = await chrome.storage.local.get('providerConfigs');
  const configs = settings.providerConfigs || {};
  configs[providerId] = config;
  await chrome.storage.local.set({ providerConfigs: configs });
}

/**
 * 保存当前选中的 Provider ID
 */
export async function setActiveProviderId(providerId) {
  if (!PROVIDER_FACTORIES[providerId]) {
    throw new Error(`未知的邮箱渠道: ${providerId}`);
  }
  await chrome.storage.local.set({ emailProvider: providerId });
  // 清除缓存使下次 getActiveProvider 重新创建
  _activeProvider = null;
  _activeProviderId = null;
}

// ── Provider 实例管理 ───────────────────────────────────────

/**
 * 获取当前激活的 Provider 实例
 * @param {Object} context - background 提供的上下文（addLog, sendToContentScript 等）
 */
export async function getActiveProvider(context) {
  const providerId = await getActiveProviderId();
  if (_activeProvider && _activeProviderId === providerId) {
    return _activeProvider;
  }
  const factory = PROVIDER_FACTORIES[providerId];
  if (!factory) throw new Error(`未知的邮箱渠道: ${providerId}`);
  _activeProvider = factory(context);
  _activeProviderId = providerId;
  return _activeProvider;
}

/**
 * 获取所有 Provider 的元数据（用于设置页渲染）
 * @param {Object} context
 * @returns {Array<{id, name, configFields}>}
 */
export function getAllProviderMeta(context) {
  return Object.entries(PROVIDER_FACTORIES).map(([id, factory]) => {
    const p = factory(context);
    return {
      id,
      name: p.name,
      type: p.type,
      configFields: p.configFields || [],
    };
  });
}

/**
 * 获取所有 Provider ID 列表
 */
export function getAllProviderIds() {
  return Object.keys(PROVIDER_FACTORIES);
}

// ── 验证码轮询（Provider 无关的上层逻辑）─────────────────────

/**
 * 通过当前 Provider 轮询邮件获取验证码
 *
 * @param {Object} options
 * @param {Object} options.context       - background 上下文
 * @param {number} options.step          - 当前步骤号
 * @param {number} options.filterAfterTimestamp - 只处理此时间之后的邮件
 * @param {string[]} options.senderFilters     - 发送人关键词
 * @param {string[]} options.subjectFilters    - 主题关键词
 * @param {string} options.targetEmail         - 目标邮箱地址
 * @param {number} [options.maxAttempts=20]    - 每轮最大轮询次数
 * @param {number} [options.intervalMs=3000]   - 轮询间隔（ms）
 * @param {Function} options.successLogMessage - 成功日志格式化函数
 * @param {string} options.failureLabel        - 失败提示文本
 * @returns {Promise<string>} 验证码
 */
export async function pollVerificationCode(options) {
  const {
    context, step, filterAfterTimestamp, senderFilters, subjectFilters,
    targetEmail, successLogMessage, failureLabel,
    maxAttempts = 20, intervalMs = 3000,
  } = options;

  const provider = await getActiveProvider(context);
  const config = await getProviderConfig(provider.id);

  const filters = {
    filterAfterTimestamp,
    senderFilters: senderFilters || [],
    subjectFilters: subjectFilters || [],
    targetEmail,
    maxAttempts,
    intervalMs,
  };

  await context.addLog(`步骤 ${step}：正在通过 ${provider.name} 检查邮件...`);

  const emails = await provider.fetchEmails(config, filters);

  for (const email of emails) {
    // 用完整文本提取验证码
    const searchText = email.text || '';
    const code = extractVerificationCode(searchText);
    if (code) {
      // 检查时间过滤
      if (filterAfterTimestamp && email.time && email.time < filterAfterTimestamp) {
        continue;
      }
      // 检查发送人过滤
      if (senderFilters && senderFilters.length > 0) {
        const fromLower = email.from.toLowerCase();
        if (!senderFilters.some(f => fromLower.includes(f.toLowerCase()))) {
          continue;
        }
      }
      await context.addLog(successLogMessage(code), 'ok');
      return code;
    }
  }

  throw new Error(failureLabel);
}

// ── 设置相关消息处理辅助 ────────────────────────────────────

/**
 * 获取完整设置（CPA 地址 + 邮箱配置），供设置页使用
 */
export async function getSettings() {
  const data = await chrome.storage.local.get(['cpaUrl', 'emailProvider', 'providerConfigs']);
  return {
    cpaUrl: data.cpaUrl || '',
    emailProvider: data.emailProvider || 'burner_mailbox',
    providerConfigs: data.providerConfigs || {},
  };
}

/**
 * 保存完整设置
 */
export async function saveSettings(settings) {
  const toSave = {};
  if (settings.cpaUrl !== undefined) toSave.cpaUrl = settings.cpaUrl;
  if (settings.emailProvider !== undefined) {
    if (!PROVIDER_FACTORIES[settings.emailProvider]) {
      throw new Error(`未知的邮箱渠道: ${settings.emailProvider}`);
    }
    toSave.emailProvider = settings.emailProvider;
    // 清除 Provider 缓存
    _activeProvider = null;
    _activeProviderId = null;
  }
  if (settings.providerConfigs !== undefined) {
    toSave.providerConfigs = settings.providerConfigs;
  }
  await chrome.storage.local.set(toSave);
}
