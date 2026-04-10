// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[SimpleAuthFlow:bg]';
const BURNER_MAILBOX_URL = 'https://burnermailbox.com/mailbox';
const GMAIL_INBOX_URL = 'https://mail.google.com/mail/u/0/#inbox';
const DUCKDUCKGO_API_BASE = 'https://quack.duckduckgo.com';
const DEFAULT_DDG_ALIAS_DOMAIN = 'duck.com';
const DEFAULT_MAIL_PROVIDER = 'burner-mail';
const DEFAULT_VPS_URL = 'http://127.0.0.1:8317/management.html#/oauth';
const EXPECTED_CODEX_CONSENT_URL = 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent';
const BURNER_CHALLENGE_REQUIRED_MESSAGE = 'Burner Mailbox 需要进行安全验证。';
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const DEFAULT_STEP_TIMEOUT_MS = 200000;
const DEFAULT_VERIFICATION_RETRY_SCHEDULE_MS = [10000];
const MAX_FRESH_EMAIL_ATTEMPTS = 5;
const NO_FRESH_EMAIL_ERROR_MESSAGE = '无法再获取到新邮箱';
const PERSISTED_SETTING_KEYS = [
  'email',
  'mailProvider',
  'ddgApiBase',
  'ddgToken',
  'ddgAliasDomain',
  'ddgTempMailAddress',
  'ddgTempMailJwt',
  'duckGoogleApiBase',
  'duckGoogleToken',
  'duckGoogleAliasDomain',
  'vpsUrl',
  'customPassword',
];

initializeSessionStorageAccess();

let automationWindowId = null;

function getErrorMessage(error) {
  if (typeof error === 'string') return error;
  return error?.message || String(error || '');
}

function isExpectedFlowIssueMessage(message) {
  const text = (message || '').trim();
  if (!text) return false;

  return (
    text === STOP_ERROR_MESSAGE
    || text.includes('流程已被用户停止')
    || text.includes('Flow stopped by user')
    || text.includes('Burner Mailbox 需要进行安全验证')
    || text.includes('请在邮箱标签页完成验证后再继续')
    || text.includes('未在 Burner Mailbox 中找到匹配的验证码邮件')
    || text.includes('未在 DuckDuckGo 收件箱中找到匹配的验证码邮件')
    || text.includes('未在 Gmail 收件箱中找到匹配的验证码邮件')
    || (text.includes('Burner Mailbox 当前显示的是') && text.includes('预期应为'))
    || text.includes('在验证页面中找不到重发邮件按钮')
  );
}

// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending', 8: 'pending', 9: 'pending',
  },
  oauthUrl: null,
  email: null,
  password: null,
  accounts: [], // { email, password, createdAt }
  lastEmailTimestamp: null,
  localhostUrl: null,
  directAuthSuccess: false,
  flowStartTime: null,
  tabRegistry: {},
  logs: [],
  generatedEmails: [],
  mailProvider: DEFAULT_MAIL_PROVIDER,
  ddgApiBase: DUCKDUCKGO_API_BASE,
  ddgToken: '',
  ddgAliasDomain: DEFAULT_DDG_ALIAS_DOMAIN,
  ddgTempMailAddress: '',
  ddgTempMailJwt: '',
  duckGoogleApiBase: DUCKDUCKGO_API_BASE,
  duckGoogleToken: '',
  duckGoogleAliasDomain: DEFAULT_DDG_ALIAS_DOMAIN,
  lastSignupVerificationCode: null,
  vpsUrl: '',
  customPassword: '',
};

async function getState() {
  const [sessionState, persistedState] = await Promise.all([
    chrome.storage.session.get(null),
    chrome.storage.local.get(PERSISTED_SETTING_KEYS),
  ]);
  return { ...DEFAULT_STATE, ...persistedState, ...sessionState };
}

async function initializeSessionStorageAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      });
      console.log(LOG_PREFIX, 'Enabled storage.session for content scripts');
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to enable storage.session for content scripts:', err?.message || err);
  }
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

async function persistSettings(updates) {
  const persistedUpdates = {};
  for (const key of PERSISTED_SETTING_KEYS) {
    if (updates[key] !== undefined) {
      persistedUpdates[key] = updates[key];
    }
  }
  if (Object.keys(persistedUpdates).length > 0) {
    await chrome.storage.local.set(persistedUpdates);
  }
}

async function setStateAndPersist(updates) {
  await setState(updates);
  await persistSettings(updates);
}

async function ensureAutomationWindowId() {
  if (automationWindowId != null) {
    try {
      await chrome.windows.get(automationWindowId);
      return automationWindowId;
    } catch {
      automationWindowId = null;
    }
  }

  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      const tab = await chrome.tabs.get(entry.tabId);
      automationWindowId = tab.windowId;
      return automationWindowId;
    } catch {}
  }

  const win = await chrome.windows.getLastFocused();
  automationWindowId = win.id;
  return automationWindowId;
}

function normalizeVpsUrl(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getEffectiveVpsUrl(value) {
  return normalizeVpsUrl(value) || DEFAULT_VPS_URL;
}

function normalizeMailProvider(value) {
  return ['duckduckgo', 'duck_google'].includes(value) ? value : DEFAULT_MAIL_PROVIDER;
}

function normalizeDuckAliasDomain(value) {
  const domain = String(value || '').trim().toLowerCase().replace(/^@+/, '');
  return domain || DEFAULT_DDG_ALIAS_DOMAIN;
}

function normalizeUrlSetting(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function getMailProviderLabel(provider) {
  const normalized = normalizeMailProvider(provider);
  if (normalized === 'duckduckgo') return 'DuckDuckGo';
  if (normalized === 'duck_google') return 'Duck + Google';
  return 'Burner Mailbox';
}

function normalizeEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function isNoFreshEmailError(error) {
  return getErrorMessage(error).includes(NO_FRESH_EMAIL_ERROR_MESSAGE);
}

function isExpectedCodexConsentUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return `${parsed.origin}${parsed.pathname}` === EXPECTED_CODEX_CONSENT_URL;
  } catch {
    return false;
  }
}

function broadcastDataUpdate(payload) {
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload,
  }).catch(() => {});
}

async function setEmailState(email) {
  await setStateAndPersist({ email });
  broadcastDataUpdate({ email });
}

async function setMailProviderState(mailProvider) {
  const normalized = normalizeMailProvider(mailProvider);
  await setStateAndPersist({ mailProvider: normalized });
  broadcastDataUpdate({ mailProvider: normalized });
}

async function rememberGeneratedEmail(email) {
  const normalized = normalizeEmailAddress(email);
  if (!normalized) return;

  const state = await getState();
  const current = Array.isArray(state.generatedEmails) ? state.generatedEmails : [];
  if (current.includes(normalized)) return;

  const next = [...current, normalized];
  if (next.length > 500) {
    next.splice(0, next.length - 500);
  }
  await setState({ generatedEmails: next });
}

async function setPasswordState(password) {
  await setState({ password });
  broadcastDataUpdate({ password });
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const [prev, persisted] = await Promise.all([
    chrome.storage.session.get([
      'seenCodes',
      'seenInbucketMailIds',
    'seenBurnerMailIds',
    'accounts',
    'generatedEmails',
    'tabRegistry',
      'password',
    ]),
    chrome.storage.local.get(PERSISTED_SETTING_KEYS),
  ]);
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    seenCodes: prev.seenCodes || [],
    seenInbucketMailIds: prev.seenInbucketMailIds || [],
    seenBurnerMailIds: prev.seenBurnerMailIds || [],
    accounts: prev.accounts || [],
    generatedEmails: prev.generatedEmails || [],
    tabRegistry: prev.tabRegistry || {},
    email: persisted.email || '',
    mailProvider: normalizeMailProvider(persisted.mailProvider),
    ddgApiBase: normalizeUrlSetting(persisted.ddgApiBase) || DUCKDUCKGO_API_BASE,
    ddgToken: persisted.ddgToken || '',
    ddgAliasDomain: normalizeDuckAliasDomain(persisted.ddgAliasDomain),
    ddgTempMailAddress: normalizeUrlSetting(persisted.ddgTempMailAddress),
    ddgTempMailJwt: persisted.ddgTempMailJwt || '',
    duckGoogleApiBase: normalizeUrlSetting(persisted.duckGoogleApiBase) || DUCKDUCKGO_API_BASE,
    duckGoogleToken: persisted.duckGoogleToken || '',
    duckGoogleAliasDomain: normalizeDuckAliasDomain(persisted.duckGoogleAliasDomain),
    vpsUrl: persisted.vpsUrl || '',
    customPassword: persisted.customPassword || '',
    password: prev.password || null,
  });
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function clearTabRegistration(source) {
  const registry = await getTabRegistry();
  if (registry[source]) {
    delete registry[source];
    await setState({ tabRegistry: registry });
    console.log(LOG_PREFIX, `Tab registration cleared: ${source}`);
  }
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `${source} 页面脚本在 ${timeout / 1000}s 内没有响应，请刷新对应标签页后重试。`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

function cancelPendingCommands(reason = STOP_ERROR_MESSAGE) {
  for (const [source, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingCommands.delete(source);
    console.log(LOG_PREFIX, `Cancelled queued command for ${source}`);
  }
}

function isBurnerChallengeError(err) {
  const message = err?.message || String(err || '');
  return message.includes(BURNER_CHALLENGE_REQUIRED_MESSAGE);
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(source, url, options = {}) {
  const alive = await isTabAlive(source);
  if (alive) {
    try {
      const tabId = await getTabId(source);
      const currentTab = await chrome.tabs.get(tabId);
      const sameUrl = currentTab.url === url;
      const shouldReloadOnReuse = sameUrl && options.reloadIfSameUrl;

      const registry = await getTabRegistry();
      if (sameUrl) {
        await chrome.tabs.update(tabId, { active: true });
        console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}) on same URL`);

        if (shouldReloadOnReuse) {
          if (registry[source]) registry[source].ready = false;
          await setState({ tabRegistry: registry });
          await chrome.tabs.reload(tabId);

          await new Promise((resolve) => {
            const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
            const listener = (tid, info) => {
              if (tid === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        }

        if (options.inject) {
          if (registry[source]) registry[source].ready = false;
          await setState({ tabRegistry: registry });
          if (options.injectSource) {
            await chrome.scripting.executeScript({
              target: { tabId },
              func: (injectedSource) => {
                window.__MULTIPAGE_SOURCE = injectedSource;
              },
              args: [options.injectSource],
            });
          }
          await chrome.scripting.executeScript({
            target: { tabId },
            files: options.inject,
          });
          await new Promise(r => setTimeout(r, 500));
        }

        return tabId;
      }

      if (registry[source]) registry[source].ready = false;
      await setState({ tabRegistry: registry });

      await chrome.tabs.update(tabId, { url, active: true });
      console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

      await new Promise((resolve) => {
        const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
        const listener = (tid, info) => {
          if (tid === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      if (options.inject) {
        if (options.injectSource) {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (injectedSource) => {
              window.__MULTIPAGE_SOURCE = injectedSource;
            },
            args: [options.injectSource],
          });
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          files: options.inject,
        });
      }

      await new Promise(r => setTimeout(r, 500));
      return tabId;
    } catch (err) {
      const message = err?.message || String(err);
      if (!options._didRetry && /No tab with id|tab was closed|cannot be edited right now/i.test(message)) {
        console.warn(LOG_PREFIX, `Tab reuse failed for ${source}, clearing stale registration and retrying: ${message}`);
        await clearTabRegistration(source);
        return reuseOrCreateTab(source, url, { ...options, _didRetry: true });
      }
      throw err;
    }
  }

  // Create new tab
  const wid = await ensureAutomationWindowId();
  const tab = await chrome.tabs.create({ url, active: true, windowId: wid });
  const registry = await getTabRegistry();
  registry[source] = { tabId: tab.id, ready: false };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);

  // If dynamic injection needed (VPS panel), inject scripts after load
  if (options.inject) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    if (options.injectSource) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (injectedSource) => {
          window.__MULTIPAGE_SOURCE = injectedSource;
        },
        args: [options.injectSource],
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: options.inject,
    });
  }

  return tab.id;
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  return chrome.tabs.sendMessage(entry.tabId, message);
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function clearStopRequest() {
  stopRequested = false;
}

function throwIfStopped() {
  if (stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

async function sleepWithStop(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped();
    await new Promise(r => setTimeout(r, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(duration);
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('未找到用于调试点击的授权页标签。');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('步骤 8 的调试器兜底点击需要有效的按钮坐标。');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `步骤 8 的调试器兜底点击附加失败：${err.message}。` +
      '如果授权页标签已打开 DevTools，请先关闭后再重试。'
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function broadcastStopToContentScripts() {
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      await chrome.tabs.sendMessage(entry.tabId, {
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      });
    } catch {}
  }
}

let stopRequested = false;
let autoRunResumeMode = null;

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    const reporter = isExpectedFlowIssueMessage(getErrorMessage(err)) ? console.warn : console.error;
    reporter(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`页面脚本已就绪：${message.source}（标签 ${tabId}）`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      if (stopRequested) {
        await setStepStatus(message.step, 'stopped');
        notifyStepError(message.step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }
      await setStepStatus(message.step, 'completed');
      await addLog(`步骤 ${message.step} 已完成`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (isStopError(message.error)) {
        await setStepStatus(message.step, 'stopped');
        await addLog(`步骤 ${message.step} 已被用户停止`, 'warn');
        notifyStepError(message.step, message.error);
      } else {
        await setStepStatus(message.step, 'failed');
        await addLog(`步骤 ${message.step} 失败：${message.error}`, 'error');
        notifyStepError(message.step, message.error);
      }
      return { ok: true };
    }

    case 'GET_STATE': {
      return await getState();
    }

    case 'RESET': {
      clearStopRequest();
      await resetState();
      await addLog('流程已重置', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      clearStopRequest();
      const step = message.payload.step;
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setEmailState(message.payload.email);
      }
      await executeStep(step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      clearStopRequest();
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      clearStopRequest();
      if (message.payload.email) {
        await setEmailState(message.payload.email);
      }
      resumeAutoRun();  // fire-and-forget
      return { ok: true };
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = normalizeVpsUrl(message.payload.vpsUrl);
      if (message.payload.customPassword !== undefined) updates.customPassword = message.payload.customPassword;
      if (message.payload.mailProvider !== undefined) updates.mailProvider = normalizeMailProvider(message.payload.mailProvider);
      if (message.payload.ddgApiBase !== undefined) updates.ddgApiBase = normalizeUrlSetting(message.payload.ddgApiBase) || DUCKDUCKGO_API_BASE;
      if (message.payload.ddgToken !== undefined) updates.ddgToken = String(message.payload.ddgToken || '').trim();
      if (message.payload.ddgAliasDomain !== undefined) updates.ddgAliasDomain = normalizeDuckAliasDomain(message.payload.ddgAliasDomain);
      if (message.payload.ddgTempMailAddress !== undefined) updates.ddgTempMailAddress = normalizeUrlSetting(message.payload.ddgTempMailAddress);
      if (message.payload.ddgTempMailJwt !== undefined) updates.ddgTempMailJwt = String(message.payload.ddgTempMailJwt || '').trim();
      if (message.payload.duckGoogleApiBase !== undefined) updates.duckGoogleApiBase = normalizeUrlSetting(message.payload.duckGoogleApiBase) || DUCKDUCKGO_API_BASE;
      if (message.payload.duckGoogleToken !== undefined) updates.duckGoogleToken = String(message.payload.duckGoogleToken || '').trim();
      if (message.payload.duckGoogleAliasDomain !== undefined) updates.duckGoogleAliasDomain = normalizeDuckAliasDomain(message.payload.duckGoogleAliasDomain);
      await setStateAndPersist(updates);
      if (updates.mailProvider) {
        broadcastDataUpdate({ mailProvider: updates.mailProvider });
      }
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setEmailState(message.payload.email);
      return { ok: true, email: message.payload.email };
    }

    case 'FETCH_PROVIDER_EMAIL':
    case 'FETCH_BURNER_EMAIL': {
      clearStopRequest();
      const email = await fetchSelectedProviderEmail(message.payload || {});
      return { ok: true, email };
    }

    case 'CONTINUE_MAIL_PROVIDER_AFTER_CHALLENGE':
    case 'CONTINUE_BURNER_AFTER_CHALLENGE': {
      clearStopRequest();
      const email = await continueSelectedProviderAfterChallenge(message.payload || {});
      return { ok: true, email };
    }

    case 'STOP_FLOW': {
      await requestStop();
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `未知的消息类型：${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        broadcastDataUpdate({ oauthUrl: payload.oauthUrl });
      }
      break;
    case 3:
      if (payload.email) await setEmailState(payload.email);
      break;
    case 4:
      if (payload.emailTimestamp || payload.code) {
        await setState({
          ...(payload.emailTimestamp ? { lastEmailTimestamp: payload.emailTimestamp } : {}),
          ...(payload.code ? { lastSignupVerificationCode: payload.code } : {}),
        });
      }
      break;
    case 8:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl, directAuthSuccess: false });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      } else if (payload.directAuthSuccess) {
        await setState({ directAuthSuccess: true });
      }
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();
let resumeWaiter = null;

function waitForStepComplete(step, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

async function markRunningStepsStopped() {
  const state = await getState();
  const runningSteps = Object.entries(state.stepStatuses || {})
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(step, 'stopped');
  }
}

async function requestStop() {
  if (stopRequested) return;

  stopRequested = true;
  cancelPendingCommands();
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }

  await addLog('已请求停止，正在取消当前操作...', 'warn');
  await broadcastStopToContentScripts();

  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();

  if (resumeWaiter) {
    resumeWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    resumeWaiter = null;
  }
  autoRunResumeMode = null;

  await markRunningStepsStopped();
  autoRunActive = false;
  await setState({ autoRunning: false });
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: { phase: 'stopped', currentRun: autoRunCurrentRun, totalRuns: autoRunTotalRuns },
  }).catch(() => {});
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  throwIfStopped();
  await setStepStatus(step, 'running');
  await addLog(`步骤 ${step} 开始执行`);
  await humanStepDelay();

  const state = await getState();

  // Set flow start time on first step
  if (step === 1 && !state.flowStartTime) {
    await setState({ flowStartTime: Date.now() });
  }

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      case 8: await executeStep8(state); break;
      case 9: await executeStep9(state); break;
      default:
        throw new Error(`未知步骤：${step}`);
    }
  } catch (err) {
    if (isStopError(err)) {
      await setStepStatus(step, 'stopped');
      await addLog(`步骤 ${step} 已被用户停止`, 'warn');
      throw err;
    }
    await setStepStatus(step, 'failed');
    await addLog(`步骤 ${step} 失败：${err.message}`, 'error');
    throw err;
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
  throwIfStopped();
  const promise = waitForStepComplete(step, timeoutMs);
  await executeStep(step);
  await promise;
  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await sleepWithStop(delayAfter + Math.floor(Math.random() * 1200));
  }
}

async function probeBurnerMailboxState(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const normalizeText = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const extractEmail = (value) => normalizeText(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const findVisibleAction = (pattern) => {
        const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
        const selectors = [
          '.actions .cursor-pointer',
          '.actions div',
          '.actions button',
          '.actions a',
          '.in-app-actions .cursor-pointer',
          '.in-app-actions div',
          '.in-app-actions button',
          '.in-app-actions a',
          '.app-action button',
          '.app-action input[type="submit"]',
          'button',
          '[role="button"]',
          'a',
        ];

        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            if (!isVisible(el)) continue;
            const text = normalizeText(el.textContent || el.value || '');
            if (regex.test(text)) {
              return el;
            }
          }
        }

        return null;
      };
      const text = normalizeText(document.body?.innerText || document.body?.textContent || '');
      const title = normalizeText(document.title);
      const selectors = [
        '#email_id',
        '.actions #email_id',
        '.in-app-actions #email_id',
        '.in-app-actions .block.appearance-none',
        '.in-app-actions .relative .block.appearance-none',
        '.in-app-actions form .block.appearance-none',
        '.actions .block.appearance-none',
      ];
      const hasMailboxEmail = selectors.some(selector =>
        Array.from(document.querySelectorAll(selector)).some(el => /@/.test(normalizeText(el.textContent || el.value || '')))
      ) || Boolean(extractEmail(title));
      const hasMailboxAction = Boolean(document.querySelector('.btn_copy'))
        || Boolean(document.querySelector('form[wire\\:submit\\.prevent="random"] input[type="submit"]'))
        || Boolean(document.querySelector('form[wire\\:submit\\.prevent="random"] button'))
        || Boolean(findVisibleAction(/^(copy|复制)$/i))
        || Boolean(findVisibleAction(/^(refresh|刷新)$/i))
        || Boolean(findVisibleAction(/^(new|新的)$|new email|新邮件/i))
        || Boolean(findVisibleAction(/random|create a random email|随机|创建随机电子邮件/i));
      const successEl = document.querySelector('#challenge-success-text');
      const challengeFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[title*="security challenge" i]');
      const challengeInput = document.querySelector('input[name="cf-turnstile-response"], input[id*="cf-chl-widget"][type="hidden"]');
      const challengeSuccess = Boolean(successEl && isVisible(successEl))
        || /verification successful|验证成功|验证已成功|正在等待 burnermailbox\.com 响应|等待 burnermailbox\.com 响应/i.test(text);
      const challengeActive = /just a moment/i.test(title)
        || /进行安全验证|正在进行安全验证|安全验证|验证您不是机器人|验证你不是机器人|此网站使用安全服务来防止恶意机器人|ray id/i.test(title)
        || /performing security verification|verifies you are not a bot|verify you are not a bot|security service to protect against malicious bots|ray id|进行安全验证|正在进行安全验证|安全验证|验证您不是机器人|验证你不是机器人|此网站使用安全服务来防止恶意机器人/i.test(text)
        || Boolean(challengeFrame)
        || Boolean(challengeInput)
        || location.href.includes('__cf_chl');

      return {
        url: location.href,
        title,
        ready: hasMailboxEmail || hasMailboxAction,
        challengeActive,
        challengeSuccess,
      };
    },
  }).catch(() => null);

  return result?.[0]?.result || null;
}

async function waitForBurnerMailboxReadyAfterChallenge(timeout = 45000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const alive = await isTabAlive('burner-mail');
    if (!alive) {
      throw new Error('Burner Mailbox 标签页在安全验证期间被关闭。');
    }

    const tabId = await getTabId('burner-mail');
    if (!tabId) {
      throw new Error('安全验证期间无法访问 Burner Mailbox 标签页。');
    }

    const state = await probeBurnerMailboxState(tabId);
    if (state?.ready) {
      return state;
    }

    await sleepWithStop(1000);
  }

  throw new Error('Burner Mailbox 还没有返回邮箱页面。');
}

function getDuckDuckGoAliasConfig(state) {
  return {
    apiBase: normalizeUrlSetting(state.ddgApiBase) || DUCKDUCKGO_API_BASE,
    token: String(state.ddgToken || '').trim(),
    aliasDomain: normalizeDuckAliasDomain(state.ddgAliasDomain),
    tempMailAddress: normalizeUrlSetting(state.ddgTempMailAddress),
    tempMailJwt: String(state.ddgTempMailJwt || '').trim(),
  };
}

function getDuckGoogleAliasConfig(state) {
  return {
    apiBase: normalizeUrlSetting(state.duckGoogleApiBase) || DUCKDUCKGO_API_BASE,
    token: String(state.duckGoogleToken || '').trim(),
    aliasDomain: normalizeDuckAliasDomain(state.duckGoogleAliasDomain),
  };
}

function getSelectedMailConfig(state) {
  const provider = normalizeMailProvider(state.mailProvider);
  if (provider === 'duckduckgo') {
    return {
      provider,
      label: getMailProviderLabel(provider),
      ...getDuckDuckGoAliasConfig(state),
    };
  }
  if (provider === 'duck_google') {
    return {
      provider,
      source: 'gmail-mail',
      url: GMAIL_INBOX_URL,
      label: getMailProviderLabel(provider),
      ...getDuckGoogleAliasConfig(state),
    };
  }

  return {
    provider: DEFAULT_MAIL_PROVIDER,
    source: 'burner-mail',
    url: BURNER_MAILBOX_URL,
    label: getMailProviderLabel(DEFAULT_MAIL_PROVIDER),
  };
}

function validateDuckAliasConfig(mail, channelLabel = 'DuckDuckGo') {
  if (!mail.apiBase) return '请先配置 DuckDuckGo API 地址。';
  if (!mail.token) return '请先配置 DuckDuckGo token。';
  if (!mail.aliasDomain) return '请先配置 DuckDuckGo 邮箱域名。';
  if (channelLabel === 'DuckDuckGo' && !mail.tempMailAddress) return '请先配置 DuckDuckGo Temp Mail Address。';
  if (channelLabel === 'DuckDuckGo' && !mail.tempMailJwt) return '请先配置 DuckDuckGo Temp Mail JWT。';
  return '';
}

function validateSelectedMailConfig(mail) {
  if (mail.provider === 'duckduckgo') {
    return validateDuckAliasConfig(mail, 'DuckDuckGo');
  }
  return '';
}

function buildBearerAuthHeader(value) {
  const token = String(value || '').trim();
  if (!token) return '';
  return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail = typeof data === 'string'
      ? data
      : data?.error || data?.message || data?.detail || '';
    throw new Error(detail || `HTTP ${response.status}`);
  }

  return data;
}

function joinUrl(base, path) {
  return `${String(base || '').replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

function extractVerificationCodeFromText(text) {
  const source = text || '';
  const matchCn = source.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = source.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = source.match(/\b(\d{6})\b/);
  return match6 ? match6[1] : null;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMailHeader(raw, headerName) {
  const source = String(raw || '');
  if (!source) return '';
  const pattern = new RegExp(`^${headerName}:\\s*(.+)$`, 'im');
  return source.match(pattern)?.[1]?.trim() || '';
}

function normalizeTempMailRecord(message) {
  if (!message || typeof message !== 'object') return null;
  const record = message;
  const raw = typeof record.raw === 'string'
    ? record.raw
    : (typeof record.mime === 'string' ? record.mime : (typeof record.content === 'string' ? record.content : ''));
  const html = String(record.html || record.html_content || '').trim();
  const text = String(record.text || record.body || record.plain || '').trim() || htmlToText(html);
  const from = String(
    record.from
      || record.sender
      || record.from_address
      || extractMailHeader(raw, 'From')
      || record.source
      || ''
  ).trim();
  const subject = String(record.subject || record.title || extractMailHeader(raw, 'Subject') || '').trim();
  const date = String(
    record.receivedAt
      || record.received_at
      || record.createdAt
      || record.created_at
      || record.date
      || record.timestamp
      || extractMailHeader(raw, 'Date')
      || ''
  ).trim();

  return {
    id: record.id || record.mail_id || record.mailId || record.message_id || record.uuid || '',
    from,
    subject,
    text,
    html,
    raw,
    time: date,
  };
}

function findTempMailRecords(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeTempMailRecord).filter(Boolean);
    if (normalized.length) return normalized;
    for (const item of value) {
      const nested = findTempMailRecords(item);
      if (nested.length) return nested;
    }
    return [];
  }

  if (!value || typeof value !== 'object') return [];
  const keys = ['data', 'mails', 'items', 'list', 'rows', 'records', 'result', 'results', 'messages'];
  for (const key of keys) {
    if (value[key] !== undefined) {
      const nested = findTempMailRecords(value[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

async function fetchDuckDuckGoMessages(mail) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: buildBearerAuthHeader(mail.tempMailJwt),
  };
  const params = new URLSearchParams({ limit: '20', offset: '0' });
  const data = await fetchJson(`${joinUrl(mail.tempMailAddress, '/api/mails')}?${params.toString()}`, {
    method: 'GET',
    headers,
  });
  return findTempMailRecords(data);
}

function parseMailTimestamp(value, options = {}) {
  const { assumeUtcWithoutZone = false } = options;
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const text = String(value).trim();
  const normalized = assumeUtcWithoutZone
    && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function messageMatchesFilters(message, senderFilters = [], subjectFilters = []) {
  const from = String(message.from || '').toLowerCase();
  const subject = String(message.subject || '').toLowerCase();
  const body = `${message.text || ''} ${message.html || ''} ${message.raw || ''}`.toLowerCase();
  const senderMatch = senderFilters.some((value) => from.includes(String(value || '').toLowerCase()));
  const subjectMatch = subjectFilters.some((value) => subject.includes(String(value || '').toLowerCase()));
  const keywordMatch = /openai|chatgpt|verify|verification|confirm|login|验证码|代码|code/.test(`${from} ${subject} ${body}`);
  return senderMatch || subjectMatch || keywordMatch;
}

async function fetchDuckDuckGoEmail(options = {}) {
  throwIfStopped();
  const state = await getState();
  const provider = normalizeMailProvider(state.mailProvider);
  const mail = provider === 'duck_google' ? getDuckGoogleAliasConfig(state) : getDuckDuckGoAliasConfig(state);
  const validationError = validateDuckAliasConfig(
    mail,
    provider === 'duck_google' ? 'Duck + Google' : 'DuckDuckGo'
  );
  if (validationError) throw new Error(validationError);

  const { generateNew = true } = options;
  if (!generateNew && state.email && state.email.toLowerCase().endsWith(`@${mail.aliasDomain}`)) {
    await addLog(`DuckDuckGo：复用现有邮箱 ${state.email}`, 'ok');
    return state.email;
  }

  await addLog(`DuckDuckGo：正在创建别名邮箱（域名 ${mail.aliasDomain}）...`);
  const data = await fetchJson(joinUrl(mail.apiBase, '/api/email/addresses'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: buildBearerAuthHeader(mail.token),
    },
    body: JSON.stringify({}),
  });
  const localPart = String(data?.address || data?.data?.address || '').trim().replace(/@.*$/, '');
  if (!localPart) {
    throw new Error('DuckDuckGo 创建邮箱失败：未返回 alias。');
  }

  const email = `${localPart}@${mail.aliasDomain}`;
  await setEmailState(email);
  await addLog(`DuckDuckGo：已生成 ${email}`, 'ok');
  return email;
}

async function fetchSelectedProviderEmail(options = {}) {
  const state = await getState();
  const provider = normalizeMailProvider(state.mailProvider);
  const fetcher = ['duckduckgo', 'duck_google'].includes(provider) ? fetchDuckDuckGoEmail : fetchBurnerEmail;
  const { generateNew = true } = options;

  if (!generateNew) {
    const email = await fetcher(options);
    await rememberGeneratedEmail(email);
    return email;
  }

  const usedEmails = new Set([
    ...(Array.isArray(state.generatedEmails) ? state.generatedEmails : []).map(normalizeEmailAddress),
    ...((state.accounts || []).map((account) => normalizeEmailAddress(account?.email))),
  ].filter(Boolean));

  for (let attempt = 1; attempt <= MAX_FRESH_EMAIL_ATTEMPTS; attempt++) {
    const email = await fetcher(options);
    const normalized = normalizeEmailAddress(email);
    if (!usedEmails.has(normalized)) {
      await rememberGeneratedEmail(email);
      return email;
    }

    await addLog(
      `${getMailProviderLabel(provider)}：命中历史邮箱 ${email}，正在重试获取新邮箱（${attempt}/${MAX_FRESH_EMAIL_ATTEMPTS}）...`,
      'warn'
    );
  }

  throw new Error(`${NO_FRESH_EMAIL_ERROR_MESSAGE}，已连续 ${MAX_FRESH_EMAIL_ATTEMPTS} 次命中历史邮箱。`);
}

async function continueSelectedProviderAfterChallenge(options = {}) {
  const state = await getState();
  const provider = normalizeMailProvider(state.mailProvider);
  if (provider === 'duckduckgo') {
    return await fetchDuckDuckGoEmail(options);
  }
  return await continueBurnerAfterChallenge(options);
}

async function continueBurnerAfterChallenge(options = {}) {
  const { generateNew = true } = options;

  await addLog('Burner Mailbox: 正在等待人机验证页面结束...', 'info');
  await waitForBurnerMailboxReadyAfterChallenge(45000);
  await addLog('Burner Mailbox: 人机验证已通过，继续获取邮箱...', 'info');
  return await fetchBurnerEmail({ generateNew });
}

async function waitForBurnerChallengeResolution(contextLabel = 'Burner Mailbox') {
  let challengeResolved = false;

  while (!challengeResolved) {
    await addLog(`${contextLabel}: 检测到 Burner Mailbox 人机验证。请在邮箱页完成验证后点击“继续”`, 'warn');
    autoRunResumeMode = 'challenge';
    chrome.runtime.sendMessage({
      type: 'AUTO_RUN_STATUS',
      payload: {
        phase: 'waiting_challenge',
        currentRun: Math.max(1, autoRunCurrentRun || 1),
        totalRuns: Math.max(1, autoRunTotalRuns || 1),
      },
    }).catch(() => {});
    await waitForResume();

    await addLog('Burner Mailbox: 正在等待人机验证页面结束...', 'info');
    try {
      await waitForBurnerMailboxReadyAfterChallenge(45000);
      challengeResolved = true;
      autoRunResumeMode = null;
    } catch (waitErr) {
      await addLog(`Burner Mailbox 人机验证还没有完成：${waitErr.message}`, 'warn');
    }
  }
}

async function fetchBurnerEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;

  await addLog(`Burner Mailbox：正在打开邮箱（${generateNew ? '生成新邮箱' : '复用当前邮箱'}）...`);
  const tabId = await reuseOrCreateTab('burner-mail', BURNER_MAILBOX_URL, {
    reloadIfSameUrl: generateNew,
  });

  let result = null;
  let previousEmail = '';

  try {
    const prepared = await sendToContentScript('burner-mail', {
      type: 'PREPARE_BURNER_EMAIL',
      source: 'background',
      payload: { generateNew },
    });

    if (prepared?.email && !generateNew) {
      result = { email: prepared.email, generated: false };
    }

    previousEmail = prepared?.previousEmail || '';

    if (!result && generateNew) {
      try {
        await sendToContentScript('burner-mail', {
          type: 'CLICK_RANDOM_BURNER_EMAIL',
          source: 'background',
          payload: { previousEmail },
        });
      } catch (err) {
        await addLog(`Burner Mailbox 随机邮箱点击导致消息通道中断，正在等待页面稳定：${err.message}`, 'warn');
      }

      for (let attempt = 1; attempt <= 24; attempt++) {
        await sleepWithStop(500);
        await reuseOrCreateTab('burner-mail', BURNER_MAILBOX_URL);

        const readResult = await sendToContentScript('burner-mail', {
          type: 'READ_BURNER_EMAIL',
          source: 'background',
          payload: { previousEmail },
        }).catch(() => null);

        if (readResult?.email && (readResult.changed || !previousEmail)) {
          result = { email: readResult.email, generated: true };
          break;
        }
      }
    }
  } catch (err) {
    if (isBurnerChallengeError(err)) {
      throw err;
    }
    await addLog(`Burner Mailbox 内容脚本流程失败，改用页面脚本兜底：${err.message}`, 'warn');
  }

  if (result?.error || !result?.email) {
    const fallback = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (shouldGenerateNew, prevEmail) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const normalizeText = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const extractEmail = (value) => normalizeText(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const findByText = (selectors, pattern) => {
          const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
          for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
              if (!isVisible(el)) continue;
              const text = normalizeText(el.textContent || el.value || '');
              if (regex.test(text)) return el;
            }
          }
          return null;
        };
        const detectChallenge = () => {
          const title = normalizeText(document.title);
          const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || '');
          const challengeFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[title*="security challenge" i]');
          const challengeInput = document.querySelector('input[name="cf-turnstile-response"], input[id*="cf-chl-widget"][type="hidden"]');
          const successEl = document.querySelector('#challenge-success-text');
          const successVisible = !!successEl && isVisible(successEl);
          if (successVisible) {
            return false;
          }
          return /just a moment/i.test(title)
            || /进行安全验证|正在进行安全验证|安全验证|验证您不是机器人|验证你不是机器人|此网站使用安全服务来防止恶意机器人|ray id/i.test(title)
            || /performing security verification|verifies you are not a bot|verify you are not a bot|security service to protect against malicious bots|ray id|进行安全验证|正在进行安全验证|安全验证|验证您不是机器人|验证你不是机器人|此网站使用安全服务来防止恶意机器人/i.test(bodyText)
            || !!challengeFrame
            || !!challengeInput
            || location.href.includes('__cf_chl');
        };
        const readVisibleEmail = () => {
          const selectors = [
            '#email_id',
            '.actions #email_id',
            '.in-app-actions #email_id',
            '.in-app-actions .block.appearance-none',
            '.actions .block.appearance-none',
          ];
          for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
              const email = extractEmail(el.textContent || el.value || '');
              if (email) return email;
            }
          }
          return '';
        };
        const readAnyEmail = () => {
          return readVisibleEmail()
            || extractEmail(document.title)
            || extractEmail(document.body?.textContent || '');
        };

        if (detectChallenge()) {
          return { challengeRequired: true };
        }

        const previousEmailValue = prevEmail || readAnyEmail();
        if (previousEmailValue && !shouldGenerateNew) {
          return { email: previousEmailValue, generated: false };
        }

        const newButton = findByText(
          ['.actions .cursor-pointer', '.actions div', '.actions button', '.actions a'],
          /^(new|新的)$|new email|新邮件/i
        );
        if (!newButton) {
          return { error: '兜底流程未找到 Burner Mailbox 的 New 按钮。' };
        }

        newButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(900);

        const randomButton = findByText(
          [
            'form[wire\\:submit\\.prevent="random"] input[type="submit"]',
            'form[wire\\:submit\\.prevent="random"] button',
            '.app-action input[type="submit"]',
            '.app-action button',
          ],
          /random|create a random email|随机|创建随机电子邮件/i
        );
        if (!randomButton) {
          return { error: '兜底流程未找到 Burner Mailbox 的随机邮箱按钮。' };
        }

        randomButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        for (let i = 0; i < 80; i++) {
          if (detectChallenge()) {
            return { challengeRequired: true };
          }
          const current = readVisibleEmail() || readAnyEmail();
          const copyButton = findByText(
            ['.btn_copy', '.actions .cursor-pointer', '.actions div', '.actions button', '.actions a'],
            /^(copy|复制)$/i
          );
          if (current && current !== previousEmailValue) {
            if (copyButton) {
              copyButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
            return { email: current, generated: true };
          }
          await sleep(250);
        }

        const current = readVisibleEmail() || readAnyEmail();
        if (current) {
          return { email: current, generated: current !== previousEmailValue };
        }

        return { error: '兜底流程等待 Burner Mailbox 邮箱结果超时。' };
      },
      args: [generateNew, previousEmail],
    });

    result = fallback?.[0]?.result || null;
  }

  if (result?.challengeRequired) {
    throw new Error(`${BURNER_CHALLENGE_REQUIRED_MESSAGE} 请在邮箱标签页完成验证后再继续。`);
  }
  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.email) {
    throw new Error('未返回 Burner Mailbox 邮箱地址。');
  }

  await setEmailState(result.email);
  await addLog(`Burner Mailbox：${result.generated ? '已生成' : '已读取'} ${result.email}`, 'ok');
  return result.email;
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns) {
  if (autoRunActive) {
    await addLog('自动运行已在进行中', 'warn');
    return;
  }

  clearStopRequest();
  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  let successfulRuns = 0;
  let failedRuns = 0;
  await setState({ autoRunning: true });

  for (let run = 1; run <= totalRuns; run++) {
    autoRunCurrentRun = run;

    // Reset everything at the start of each run (keep VPS/password settings)
    const prevState = await getState();
    const keepSettings = {
      mailProvider: normalizeMailProvider(prevState.mailProvider),
      ddgApiBase: normalizeUrlSetting(prevState.ddgApiBase) || DUCKDUCKGO_API_BASE,
      ddgToken: prevState.ddgToken || '',
      ddgAliasDomain: normalizeDuckAliasDomain(prevState.ddgAliasDomain),
      ddgTempMailAddress: normalizeUrlSetting(prevState.ddgTempMailAddress),
      ddgTempMailJwt: prevState.ddgTempMailJwt || '',
      vpsUrl: prevState.vpsUrl,
      customPassword: prevState.customPassword,
      autoRunning: true,
    };
    await resetState();
    await setState(keepSettings);
    // Tell side panel to reset all UI
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
    await sleepWithStop(500);

    await addLog(`=== 自动运行 ${run}/${totalRuns}：阶段 1，获取 OAuth 链接并打开注册页 ===`, 'info');
    const status = (phase) => ({ type: 'AUTO_RUN_STATUS', payload: { phase, currentRun: run, totalRuns } });

    try {
      throwIfStopped();
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      await executeStepAndWait(1, 2000);
      await executeStepAndWait(2, 2000);

      let emailReady = false;
      while (!emailReady) {
        try {
          const mail = getSelectedMailConfig(await getState());
          const providerEmail = await fetchSelectedProviderEmail({ generateNew: true });
          await addLog(`=== 第 ${run}/${totalRuns} 轮：${mail.label} 邮箱已就绪：${providerEmail} ===`, 'ok');
          emailReady = true;
          autoRunResumeMode = null;
        } catch (err) {
          if (isBurnerChallengeError(err)) {
            await waitForBurnerChallengeResolution(`Run ${run}/${totalRuns}`);
            continue;
          }
          if (isNoFreshEmailError(err)) {
            throw err;
          }

          const mail = getSelectedMailConfig(await getState());
          await addLog(`${mail.label} 自动获取失败：${err.message}`, 'warn');
          break;
        }
      }

      if (!emailReady) {
        const mail = getSelectedMailConfig(await getState());
        await addLog(`=== 第 ${run}/${totalRuns} 轮已暂停：请获取 ${mail.label} 邮箱或手动粘贴后继续 ===`, 'warn');
        autoRunResumeMode = 'email';
        chrome.runtime.sendMessage(status('waiting_email')).catch(() => {});

        // Wait for RESUME_AUTO_RUN — sets a promise that resumeAutoRun resolves
        await waitForResume();

        const resumedState = await getState();
        if (!resumedState.email) {
          await addLog('无法继续：缺少邮箱地址。', 'error');
          break;
        }
        autoRunResumeMode = null;
      }

      await addLog(`=== 第 ${run}/${totalRuns} 轮：阶段 2，注册、验证、登录并完成流程 ===`, 'info');
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      const signupTabId = await getTabId('signup-page');
      if (signupTabId) {
        await chrome.tabs.update(signupTabId, { active: true });
      }

      await executeStepAndWait(3, 3000);
      await executeStepAndWait(4, 2000);
      await executeStepAndWait(5, 3000);
      await executeStepAndWait(6, 3000);
      await executeStepAndWait(7, 2000);
      await executeStepAndWait(8, 2000);
      await executeStepAndWait(9, 1000);

      successfulRuns += 1;
      await addLog(`=== 第 ${run}/${totalRuns} 轮已完成 ===`, 'ok');

    } catch (err) {
      if (isStopError(err)) {
        await addLog(`第 ${run}/${totalRuns} 轮已被用户停止`, 'warn');
        chrome.runtime.sendMessage(status('stopped')).catch(() => {});
        break;
      } else {
        failedRuns += 1;
        await addLog(`第 ${run}/${totalRuns} 轮失败：${err.message}`, 'error');
        if (isNoFreshEmailError(err)) {
          chrome.runtime.sendMessage(status('stopped')).catch(() => {});
          break;
        }
        if (run < totalRuns) {
          await addLog(`第 ${run}/${totalRuns} 轮失败后将休眠 5 秒，并继续下一轮。`, 'warn');
          chrome.runtime.sendMessage(status('running')).catch(() => {});
          await sleepWithStop(5000);
          continue;
        }
      }
      chrome.runtime.sendMessage(status('stopped')).catch(() => {});
      break;
    }
  }

  const completedRuns = successfulRuns;
  if (stopRequested) {
    await addLog(`=== 已停止，完成 ${completedRuns}/${autoRunTotalRuns} 轮 ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else if (completedRuns >= autoRunTotalRuns) {
    await addLog(`=== 全部 ${autoRunTotalRuns} 轮已成功完成 ===`, 'ok');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'complete', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else if (failedRuns > 0) {
    await addLog(`=== 自动运行结束：成功 ${completedRuns} 轮，失败 ${failedRuns} 轮，共 ${autoRunTotalRuns} 轮 ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else {
    await addLog(`=== 已停止，完成 ${completedRuns}/${autoRunTotalRuns} 轮 ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  }
  autoRunActive = false;
  await setState({ autoRunning: false });
  clearStopRequest();
}

function waitForResume() {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    resumeWaiter = { resolve, reject };
  });
}

async function resumeAutoRun() {
  throwIfStopped();
  if (autoRunResumeMode === 'email') {
    const state = await getState();
    if (!state.email) {
      await addLog('无法继续：缺少邮箱地址。请先在侧边栏粘贴邮箱。', 'error');
      return;
    }
  }
  if (resumeWaiter) {
    resumeWaiter.resolve();
    resumeWaiter = null;
    autoRunResumeMode = null;
  }
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function executeStep1(state) {
  const vpsUrl = getEffectiveVpsUrl(state.vpsUrl);
  await addLog('步骤 1：正在打开 VPS 面板...');
  await reuseOrCreateTab('vps-panel', vpsUrl, {
    inject: ['content/utils.js', 'content/vps-panel.js'],
    reloadIfSameUrl: true,
  });

  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  if (!state.oauthUrl) {
    throw new Error('缺少 OAuth 链接，请先完成步骤 1。');
  }
  await addLog('步骤 2：正在打开授权链接...');
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  if (!state.email) {
    throw new Error('缺少邮箱地址，请先在侧边栏粘贴邮箱。');
  }

  const password = state.customPassword || generatePassword();
  await setPasswordState(password);

  // Save account record
  const accounts = state.accounts || [];
  accounts.push({ email: state.email, password, createdAt: new Date().toISOString() });
  await setState({ accounts });

  await addLog(
    `步骤 3：正在填写邮箱 ${state.email}，密码为${state.customPassword ? '自定义' : '自动生成'}（${password.length} 个字符）`
  );
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email: state.email, password },
  });
}

// ============================================================
// Step 4: Get Signup Verification Code (mail provider polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  const mail = getSelectedMailConfig(state);
  const validationError = validateSelectedMailConfig(mail, state);
  if (validationError) {
    return { ...mail, error: validationError };
  }
  return mail;
}

function isNoMatchingEmailError(error) {
  const message = error?.message || String(error || '');
  return (
    message.includes('No matching verification email found')
    || message.includes('No new matching email found')
    || message.includes('未在 Burner Mailbox 中找到匹配的验证码邮件')
    || message.includes('未找到匹配的验证码邮件')
    || message.includes('未在 DuckDuckGo 收件箱中找到匹配的验证码邮件')
    || message.includes('未在 Gmail 收件箱中找到匹配的验证码邮件')
  );
}

async function openMailTab(mail) {
  const alive = await isTabAlive(mail.source);
  if (alive) {
    if (mail.navigateOnReuse) {
      return await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    } else {
      const tabId = await getTabId(mail.source);
      await chrome.tabs.update(tabId, { active: true });
      return tabId;
    }
  } else {
    return await reuseOrCreateTab(mail.source, mail.url, {
      inject: mail.inject,
      injectSource: mail.injectSource,
    });
  }
}

async function waitForSignupVerificationSurfaceReady(tabId, timeout = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status !== 'complete') {
        await sleepWithStop(200);
        continue;
      }

      const probe = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };

          const resendSelectors = [
            'button[name="intent"][value="resend"]',
            'button[type="submit"][name="intent"][value="resend"]',
            'button[value="resend"]',
            'button[form][name="intent"][value="resend"]',
          ];
          const hasResendButton = resendSelectors.some((selector) =>
            Array.from(document.querySelectorAll(selector)).some((el) => {
              const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
              return !disabled && isVisible(el);
            })
          );

          const hasCodeInput = Array.from(document.querySelectorAll(
            'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[inputmode="numeric"], input[maxlength="1"]'
          )).some(isVisible);

          return {
            ready: hasResendButton || hasCodeInput,
            href: location.href,
            readyState: document.readyState,
          };
        },
      });

      if (probe?.[0]?.result?.ready) {
        return probe[0].result;
      }
    } catch {}

    await sleepWithStop(250);
  }

  throw new Error('验证码页面尚未稳定，无法触发重发验证码。');
}

async function clickResendOnSignupPage(step, clicks = 1) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    await addLog(`步骤 ${step}：授权页标签已关闭，跳过预先重发验证码。`, 'warn');
    return false;
  }

  await chrome.tabs.update(signupTabId, { active: true });
  try {
    await waitForSignupVerificationSurfaceReady(signupTabId, 15000);
    for (let i = 0; i < clicks; i++) {
      const result = await chrome.tabs.sendMessage(signupTabId, {
        type: 'RESEND_VERIFICATION_EMAIL',
        step,
        source: 'background',
        payload: { clicks: 1 },
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      if (!result?.rect) {
        throw new Error('未返回重发邮件按钮坐标。');
      }

      await clickWithDebugger(signupTabId, result.rect);
      await addLog(`步骤 ${step}：后台已执行重发邮件真实点击（${i + 1}/${clicks}）："${result.buttonText || '未命名按钮'}"`, 'info');
      await sleepWithStop(900);
    }
    return true;
  } catch (err) {
    await addLog(`步骤 ${step}：预先重发验证码已跳过：${err.message}`, 'warn');
    return false;
  }
}

async function requestVerificationEmailResend(step, clicks = 2) {
  const clicked = await clickResendOnSignupPage(step, clicks);
  if (!clicked) {
    throw new Error('授权页标签已关闭，无法请求重新发送验证码。');
  }
}

async function submitVerificationCodeAndConfirm(step, code) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error(step === 4 ? '注册页标签已关闭，无法填写验证码。' : '授权页标签已关闭，无法填写验证码。');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  const result = await sendToContentScript('signup-page', {
    type: 'FILL_CODE',
    step,
    source: 'background',
    payload: { code },
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  if (result?.invalidCode) {
    await addLog(`步骤 ${step}：验证码校验失败：${result.message || '代码不正确'}，将继续等待新验证码。`, 'warn');
    return { accepted: false, invalidCode: true, message: result.message || '代码不正确' };
  }

  return { accepted: true, ...(result || {}) };
}

async function pollDuckDuckGoVerificationCode(mail, step, options) {
  const {
    filterAfterTimestamp,
    senderFilters,
    subjectFilters,
    excludedCodes = new Set(),
    excludedMailIds = new Set(),
  } = options;

  const messages = await fetchDuckDuckGoMessages(mail);
  for (const message of messages) {
    const messageTimestamp = parseMailTimestamp(message.time, { assumeUtcWithoutZone: true });
    if (filterAfterTimestamp && messageTimestamp && messageTimestamp < filterAfterTimestamp) {
      continue;
    }
    if (!messageMatchesFilters(message, senderFilters, subjectFilters)) {
      continue;
    }
    if (message.id && excludedMailIds.has(String(message.id))) {
      continue;
    }

    const content = [
      message.subject || '',
      message.from || '',
      message.text || '',
      htmlToText(message.html || ''),
      message.raw || '',
    ].join('\n');
    const code = extractVerificationCodeFromText(content);
    if (!code) continue;
    if (excludedCodes.has(code)) {
      continue;
    }

    await addLog(`步骤 ${step}：已从 DuckDuckGo 收件箱获取验证码：${code}`, 'ok');
    return {
      code,
      emailTimestamp: messageTimestamp || Date.now(),
      mailId: message.id ? String(message.id) : '',
    };
  }

  throw new Error('未在 DuckDuckGo 收件箱中找到匹配的验证码邮件。');
}

async function pollWebInboxVerificationCode(mail, step, options) {
  const {
    filterAfterTimestamp,
    senderFilters,
    subjectFilters,
    targetEmail,
    excludedCodes = [],
    excludedMailIds = [],
  } = options;

  await addLog(`步骤 ${step}：正在查询 ${mail.label} 收件箱...`);
  const result = await sendToContentScript(mail.source, {
    type: 'POLL_EMAIL',
    step,
    source: 'background',
    payload: {
      filterAfterTimestamp,
      senderFilters,
      subjectFilters,
      targetEmail,
      maxAttempts: 1,
      intervalMs: 1000,
      excludedCodes,
      excludedMailIds,
    },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  return result;
}

async function refreshGmailInbox(step, mail) {
  const gmailTabId = await openMailTab(mail);
  if (!gmailTabId) {
    throw new Error('Gmail 标签页不存在，无法刷新收件箱。');
  }

  const refreshTarget = await sendToContentScript(mail.source, {
    type: 'GET_REFRESH_BUTTON_RECT',
    step,
    source: 'background',
    payload: {},
  });

  if (refreshTarget?.error) {
    throw new Error(refreshTarget.error);
  }
  if (!refreshTarget?.rect) {
    throw new Error('未返回 Gmail 刷新按钮坐标。');
  }

  await clickWithDebugger(gmailTabId, refreshTarget.rect);
  await addLog(`步骤 ${step}：已执行 Gmail 收件箱刷新真实点击（${refreshTarget.buttonText || '刷新'}）。`, 'info');
  await sleepWithStop(1000);
}

async function pollVerificationCodeWithRetry(step, state, options) {
  const {
    filterAfterTimestamp,
    senderFilters,
    subjectFilters,
    targetEmail,
    successLogMessage,
    failureLabel,
    mailPollAttempts = 2,
    mailPollIntervalMs = 4000,
    resendClicks = 2,
    retryWaitScheduleMs = DEFAULT_VERIFICATION_RETRY_SCHEDULE_MS,
    excludedCodes = [],
    excludedMailIds = [],
    submitCode,
  } = options;

  const mail = getMailConfig(state);
  if (mail.error) throw new Error(mail.error);

  const advanceFilterAfterTimestamp = (currentValue, emailTimestamp) => {
    const numericTimestamp = Number(emailTimestamp);
    if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) {
      return currentValue || 0;
    }
    return Math.max(currentValue || 0, numericTimestamp + 1);
  };

  if (mail.provider === 'duckduckgo') {
    const totalDurationMs = DEFAULT_STEP_TIMEOUT_MS;
    const pollIntervalMs = 4000;
    const resendScheduleMs = DEFAULT_VERIFICATION_RETRY_SCHEDULE_MS;
    const startedAt = Date.now();
    const triggeredResends = new Set();
    const failedCodes = new Set();
    const failedMailIds = new Set();
    let currentFilterAfterTimestamp = filterAfterTimestamp || 0;

    while (Date.now() - startedAt <= totalDurationMs) {
      const elapsedMs = Date.now() - startedAt;

      for (const resendAt of resendScheduleMs) {
        if (elapsedMs >= resendAt && !triggeredResends.has(resendAt)) {
          await addLog(`步骤 ${step}：已到第 ${Math.round(resendAt / 1000)} 秒，正在请求重发 ${resendClicks} 次...`, 'warn');
          await requestVerificationEmailResend(step, resendClicks);
          triggeredResends.add(resendAt);
          await humanStepDelay(500, 1100);
        }
      }

      try {
        await addLog(`步骤 ${step}：正在查询 ${mail.label} 收件箱...`);
        const result = await pollDuckDuckGoVerificationCode(mail, step, {
          filterAfterTimestamp: currentFilterAfterTimestamp,
          senderFilters,
          subjectFilters,
          excludedCodes: new Set([...excludedCodes, ...failedCodes]),
          excludedMailIds: new Set([...excludedMailIds, ...failedMailIds]),
        });

        if (result?.error) {
          throw new Error(result.error);
        }

        if (result?.code) {
          if (result.emailTimestamp) {
            await setState({ lastEmailTimestamp: result.emailTimestamp });
          }
          await addLog(successLogMessage(result.code), 'ok');
          if (typeof submitCode === 'function') {
            const submitResult = await submitCode(result.code);
            if (submitResult?.accepted) {
              return result.code;
            }
            if (submitResult?.invalidCode) {
              failedCodes.add(result.code);
              if (result.mailId) {
                failedMailIds.add(String(result.mailId));
              }
              currentFilterAfterTimestamp = advanceFilterAfterTimestamp(
                currentFilterAfterTimestamp,
                result.emailTimestamp
              );
            } else {
              throw new Error(submitResult?.message || '验证码提交失败。');
            }
          } else {
            return result.code;
          }
        }
      } catch (err) {
        if (isBurnerChallengeError(err)) {
          await waitForBurnerChallengeResolution(`Step ${step}`);
          continue;
        }
        if (!isNoMatchingEmailError(err)) {
          throw err;
        }
      }

      if (Date.now() - startedAt >= totalDurationMs) {
        break;
      }
      await sleepWithStop(pollIntervalMs);
    }

    throw new Error(`${failureLabel}，3 分钟内未拿到可用验证码。`);
  }

  if (mail.provider === 'duck_google') {
    const totalDurationMs = DEFAULT_STEP_TIMEOUT_MS;
    const pollIntervalMs = 4000;
    const resendScheduleMs = DEFAULT_VERIFICATION_RETRY_SCHEDULE_MS;
    const startedAt = Date.now();
    const triggeredResends = new Set();
    const failedCodes = new Set();
    const failedMailIds = new Set();
    let currentFilterAfterTimestamp = filterAfterTimestamp || 0;

    await openMailTab(mail);

    while (Date.now() - startedAt <= totalDurationMs) {
      try {
        await refreshGmailInbox(step, mail);
        const result = await pollWebInboxVerificationCode(mail, step, {
          filterAfterTimestamp: currentFilterAfterTimestamp,
          senderFilters,
          subjectFilters,
          targetEmail,
          excludedCodes: [...excludedCodes, ...failedCodes],
          excludedMailIds: [...excludedMailIds, ...failedMailIds],
        });

        if (result?.code) {
          if (result.emailTimestamp) {
            await setState({ lastEmailTimestamp: result.emailTimestamp });
          }
          await addLog(successLogMessage(result.code), 'ok');
          if (typeof submitCode === 'function') {
            const submitResult = await submitCode(result.code);
            if (submitResult?.accepted) {
              return result.code;
            }
            if (submitResult?.invalidCode) {
              failedCodes.add(result.code);
              if (result.mailId) {
                failedMailIds.add(String(result.mailId));
              }
              currentFilterAfterTimestamp = advanceFilterAfterTimestamp(
                currentFilterAfterTimestamp,
                result.emailTimestamp
              );
              await openMailTab(mail);
            } else {
              throw new Error(submitResult?.message || '验证码提交失败。');
            }
          } else {
            return result.code;
          }
        }
      } catch (err) {
        if (isBurnerChallengeError(err)) {
          await waitForBurnerChallengeResolution(`Step ${step}`);
          await openMailTab(mail);
          continue;
        }
        if (!isNoMatchingEmailError(err)) {
          throw err;
        }
      }

      const elapsedMs = Date.now() - startedAt;
      for (const resendAt of resendScheduleMs) {
        if (elapsedMs >= resendAt && !triggeredResends.has(resendAt)) {
          await addLog(`步骤 ${step}：已到第 ${Math.round(resendAt / 1000)} 秒，正在返回授权页请求重发 ${resendClicks} 次...`, 'warn');
          await requestVerificationEmailResend(step, resendClicks);
          triggeredResends.add(resendAt);
          await humanStepDelay(500, 1100);
          await openMailTab(mail);
        }
      }

      if (Date.now() - startedAt >= totalDurationMs) {
        break;
      }
      await sleepWithStop(pollIntervalMs);
    }

    throw new Error(`${failureLabel}，${Math.round(totalDurationMs / 1000)} 秒内未拿到可用验证码。`);
  }

  const totalDurationMs = DEFAULT_STEP_TIMEOUT_MS;
  const startedAt = Date.now();
  const triggeredResends = new Set();
  const failedCodes = new Set();
  const failedMailIds = new Set();
  let currentFilterAfterTimestamp = filterAfterTimestamp || 0;

  while (Date.now() - startedAt <= totalDurationMs) {
    await addLog(`步骤 ${step}：正在打开 ${mail.label}...`);
    await openMailTab(mail);

    let foundCode = null;
    try {
      const result = await sendToContentScript(mail.source, {
        type: 'POLL_EMAIL',
        step,
        source: 'background',
        payload: {
          filterAfterTimestamp: currentFilterAfterTimestamp,
          senderFilters,
          subjectFilters,
          targetEmail,
          maxAttempts: mailPollAttempts,
          intervalMs: mailPollIntervalMs,
          excludedCodes: [...excludedCodes, ...failedCodes],
          excludedMailIds: [...excludedMailIds, ...failedMailIds],
        },
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      if (result?.code) {
        if (result.emailTimestamp) {
          await setState({ lastEmailTimestamp: result.emailTimestamp });
        }
        await addLog(successLogMessage(result.code), 'ok');
        if (typeof submitCode === 'function') {
          const submitResult = await submitCode(result.code);
          if (submitResult?.accepted) {
            foundCode = result.code;
          } else if (submitResult?.invalidCode) {
            failedCodes.add(result.code);
            if (result.mailId) {
              failedMailIds.add(String(result.mailId));
            }
            currentFilterAfterTimestamp = advanceFilterAfterTimestamp(
              currentFilterAfterTimestamp,
              result.emailTimestamp
            );
            foundCode = null;
          } else {
            throw new Error(submitResult?.message || '验证码提交失败。');
          }
        } else {
          foundCode = result.code;
        }
      }
    } catch (err) {
      if (isBurnerChallengeError(err)) {
        await waitForBurnerChallengeResolution(`Step ${step}`);
        continue;
      }
      if (!isNoMatchingEmailError(err)) {
        throw err;
      }
    }

    if (foundCode) {
      return foundCode;
    }

    const elapsedMs = Date.now() - startedAt;
    for (const resendAt of retryWaitScheduleMs) {
      if (elapsedMs >= resendAt && !triggeredResends.has(resendAt)) {
        await addLog(`步骤 ${step}：已到第 ${Math.round(resendAt / 1000)} 秒，正在请求重发 ${resendClicks} 次...`, 'warn');
        await requestVerificationEmailResend(step, resendClicks);
        triggeredResends.add(resendAt);
        await humanStepDelay(500, 1100);
      }
    }

    if (Date.now() - startedAt >= totalDurationMs) {
      break;
    }
    await sleepWithStop(mailPollIntervalMs);
  }

  throw new Error(`${failureLabel}，${Math.round(totalDurationMs / 1000)} 秒内未拿到可用验证码。`);
}

async function executeStep4(state) {
  const code = await pollVerificationCodeWithRetry(4, state, {
    filterAfterTimestamp: state.flowStartTime || 0,
    senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt'],
    subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
    targetEmail: state.email,
    successLogMessage: (value) => `步骤 4：已获取验证码：${value}`,
    failureLabel: '未收到注册验证码邮件',
    mailPollAttempts: 5,
    mailPollIntervalMs: 4000,
    resendClicks: 1,
    retryWaitScheduleMs: DEFAULT_VERIFICATION_RETRY_SCHEDULE_MS,
    submitCode: (value) => submitVerificationCodeAndConfirm(4, value),
  });
  await setState({ lastSignupVerificationCode: code });
  await setStepStatus(4, 'completed');
  notifyStepComplete(4, { code });
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`步骤 5：已生成姓名 ${firstName} ${lastName}，生日 ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 6: Login ChatGPT (Background opens tab, chatgpt.js handles login)
// ============================================================

async function executeStep6(state) {
  if (!state.oauthUrl) {
    throw new Error('缺少 OAuth 链接，请先完成步骤 1。');
  }
  if (!state.email) {
    throw new Error('缺少邮箱，请先完成步骤 3。');
  }

  await addLog('步骤 6：正在打开 OAuth 链接进行登录...');
  // Reuse the signup-page tab — navigate it to the OAuth URL
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  // signup-page.js will inject (same auth.openai.com domain) and handle login
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 6,
    source: 'background',
    payload: { email: state.email, password: state.password },
  });
}

// ============================================================
// Step 7: Get Login Verification Code (Burner Mailbox polls, then fills in auth page)
// ============================================================

async function executeStep7(state) {
  const code = await pollVerificationCodeWithRetry(7, state, {
    filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
    senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt'],
    subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm', 'login'],
    targetEmail: state.email,
    successLogMessage: (value) => `步骤 7：已获取登录验证码：${value}`,
    failureLabel: '未收到登录验证码邮件',
    mailPollAttempts: 5,
    mailPollIntervalMs: 4000,
    resendClicks: 1,
    retryWaitScheduleMs: DEFAULT_VERIFICATION_RETRY_SCHEDULE_MS,
    excludedCodes: state.lastSignupVerificationCode ? [state.lastSignupVerificationCode] : [],
    submitCode: (value) => submitVerificationCodeAndConfirm(7, value),
  });
  await setStepStatus(7, 'completed');
  notifyStepComplete(7, { code });
}

// ============================================================
// Step 8: Complete OAuth (auto click + localhost listener)
// ============================================================

let webNavListener = null;

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('缺少 OAuth 链接，请先完成步骤 1。');
  }

  await addLog('步骤 8：正在设置 localhost 回调监听...');

  // Register webNavigation listener (scoped to this step)
  return new Promise((resolve, reject) => {
    let resolved = false;
    let monitorTimer = null;

    const cleanupListener = () => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
      }
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
    };

    const finalizeStep8 = async (payload = {}) => {
      if (resolved) return;
      resolved = true;
      cleanupListener();
      clearTimeout(timeout);

      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl, directAuthSuccess: false });
        await addLog(`步骤 8：已捕获 localhost 回调地址：${payload.localhostUrl}`, 'ok');
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      } else if (payload.successPage) {
        await setState({ directAuthSuccess: true });
        await addLog('步骤 8：检测到授权成功页面，步骤 8 和步骤 9 将直接视为完成。', 'ok');
        await setStepStatus(9, 'completed');
      }

      await setStepStatus(8, 'completed');
      notifyStepComplete(8, {
        ...payload,
        directAuthSuccess: Boolean(payload.successPage && !payload.localhostUrl),
      });
      resolve();
    };

    const timeout = setTimeout(() => {
      cleanupListener();
      reject(new Error('120 秒内未捕获到 localhost 回调，步骤 8 的点击可能被拦截。'));
    }, 120000);

    webNavListener = (details) => {
      if (details.url.startsWith('http://localhost')) {
        console.log(LOG_PREFIX, `Captured localhost redirect: ${details.url}`);
        finalizeStep8({ localhostUrl: details.url }).catch(reject);
      }
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);

    // After step 7, the auth page shows a consent screen ("使用 ChatGPT 登录到 Codex")
    // with a "继续" button. We locate the button in-page, then click it through
    // the debugger Input API directly.
    (async () => {
      try {
        let signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await chrome.tabs.update(signupTabId, { active: true });
          await addLog('步骤 8：已切换到授权页，准备执行调试器点击...');
        } else {
          signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
          await addLog('步骤 8：已重新打开授权页标签，准备执行调试器点击...');
        }

        const currentTab = await chrome.tabs.get(signupTabId);
        const currentUrl = currentTab?.url || '';
        if (!isExpectedCodexConsentUrl(currentUrl)) {
          throw new Error(`步骤 8 当前页面不是 Codex 授权确认页。当前：${currentUrl}，预期：${EXPECTED_CODEX_CONSENT_URL}`);
        }

        const clickResult = await sendToContentScript('signup-page', {
          type: 'STEP8_FIND_AND_CLICK',
          source: 'background',
          payload: {},
        });

        if (clickResult?.error) {
          throw new Error(clickResult.error);
        }

        if (!resolved) {
          await clickWithDebugger(signupTabId, clickResult?.rect);
          await addLog('步骤 8：调试器点击已发送，正在等待回调跳转...');

          monitorTimer = setInterval(() => {
            if (resolved) return;

            (async () => {
              try {
                const currentTab = await chrome.tabs.get(signupTabId);
                const currentUrl = currentTab?.url || '';
                if (currentUrl.startsWith('http://localhost')) {
                  await finalizeStep8({ localhostUrl: currentUrl });
                  return;
                }

                const probe = await chrome.scripting.executeScript({
                  target: { tabId: signupTabId },
                  func: () => {
                    const bodyText = document.body?.innerText || '';
                    const headingText = Array.from(document.querySelectorAll('h1, h2')).map(el => el.textContent || '').join(' ');
                    return {
                      url: location.href,
                      successPage: /authentication successful!?/i.test(bodyText) || /authentication successful!?/i.test(headingText),
                    };
                  },
                }).catch(() => null);

                const result = probe?.[0]?.result;
                const probedUrl = result?.url || currentUrl;
                if (probedUrl.startsWith('http://localhost')) {
                  await finalizeStep8({ localhostUrl: probedUrl, successPage: Boolean(result?.successPage) });
                  return;
                }

                if (result?.successPage) {
                  await finalizeStep8({ successPage: true, localhostUrl: probedUrl.startsWith('http://localhost') ? probedUrl : null });
                }
              } catch {}
            })();
          }, 700);
        }
      } catch (err) {
        clearTimeout(timeout);
        cleanupListener();
        reject(err);
      }
    })();
  });
}

// ============================================================
// Step 9: VPS Verify (via vps-panel.js)
// ============================================================

async function executeStep9(state) {
  if (state.directAuthSuccess && !state.localhostUrl) {
    await addLog('步骤 9：已跳过，因为步骤 8 已直接进入授权成功页面。', 'ok');
    await setStepStatus(9, 'completed');
    notifyStepComplete(9, { skipped: true, directAuthSuccess: true });
    return;
  }

  if (!state.localhostUrl) {
    throw new Error('缺少 localhost 回调地址，请先完成步骤 8。');
  }
  const vpsUrl = getEffectiveVpsUrl(state.vpsUrl);

  await addLog('步骤 9：正在打开 VPS 面板...');
  const existingTabId = await getTabId('vps-panel');
  const alive = existingTabId && await isTabAlive('vps-panel');
  const tabId = alive
    ? existingTabId
    : await reuseOrCreateTab('vps-panel', vpsUrl, {
      inject: ['content/utils.js', 'content/vps-panel.js'],
    });

  if (alive) {
    await chrome.tabs.update(tabId, { active: true });
  }

  await addLog('步骤 9：正在填写回调地址...');
  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 9,
    source: 'background',
    payload: { localhostUrl: state.localhostUrl },
  });
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
