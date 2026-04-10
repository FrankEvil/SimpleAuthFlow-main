// email/providers/burner-mailbox.js — Burner Mailbox 适配器（内容脚本型）

/**
 * Burner Mailbox 是特殊的 Provider：通过内容脚本操作 burnermailbox.com 页面 DOM。
 * generateEmail / fetchEmails 均委托给 background 的标签页管理和消息通信。
 * 集成时需要 context 提供 sendToContentScript / reuseOrCreateTab 等能力。
 */

const BURNER_MAILBOX_URL = 'https://burnermailbox.com/mailbox';

export function createBurnerMailboxProvider(context) {
  return {
    id: 'burner_mailbox',
    name: 'Burner Mailbox',
    type: 'content-script',

    configFields: [
      // Burner Mailbox 无需用户配置，开箱即用
    ],

    /**
     * 生成新邮箱地址
     * 需要 context 提供：reuseOrCreateTab, sendToContentScript
     * @returns {Promise<string>} 邮箱地址
     */
    async generateEmail(_config) {
      if (!context?.reuseOrCreateTab || !context?.sendToContentScript) {
        throw new Error('Burner Mailbox 需要在完整的扩展环境中运行（需要标签页管理能力）');
      }

      // 打开或复用 Burner Mailbox 标签页
      await context.reuseOrCreateTab('burner-mail', BURNER_MAILBOX_URL);

      // 通知内容脚本准备邮箱
      const prepareResult = await context.sendToContentScript('burner-mail', {
        type: 'EXECUTE_STEP',
        source: 'background',
        step: 'FETCH_BURNER_EMAIL',
        payload: { generateNew: true },
      });

      if (prepareResult?.error) throw new Error(prepareResult.error);
      if (!prepareResult?.email) throw new Error('Burner Mailbox 未返回邮箱地址');
      return prepareResult.email;
    },

    /**
     * 获取邮件列表（轮询验证码）
     * 委托给内容脚本的 pollBurnerMailbox
     * @returns {Promise<import('../email-common.js').UnifiedEmail[]>}
     */
    async fetchEmails(_config, filters = {}) {
      if (!context?.reuseOrCreateTab || !context?.sendToContentScript) {
        throw new Error('Burner Mailbox 需要在完整的扩展环境中运行');
      }

      await context.reuseOrCreateTab('burner-mail', BURNER_MAILBOX_URL);

      const result = await context.sendToContentScript('burner-mail', {
        type: 'POLL_EMAIL',
        source: 'background',
        payload: {
          filterAfterTimestamp: filters.filterAfterTimestamp || 0,
          senderFilters: filters.senderFilters || [],
          subjectFilters: filters.subjectFilters || [],
          targetEmail: filters.targetEmail || '',
          maxAttempts: filters.maxAttempts || 2,
          intervalMs: filters.intervalMs || 4000,
        },
      });

      if (result?.error) throw new Error(result.error);

      // 内容脚本返回 { ok, code, emailTimestamp, mailId }
      // 将其转为统一邮件格式
      if (result?.ok && result?.code) {
        return [{
          id: `burner_mailbox:${result.mailId || Date.now()}`,
          subject: 'Verification Email',
          from: 'noreply@openai.com',
          text: result.code,
          time: result.emailTimestamp || Date.now(),
        }];
      }

      return [];
    },
  };
}
