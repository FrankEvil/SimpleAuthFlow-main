// content/gmail-mail.js — Gmail inbox polling for verification emails
// Injected on: mail.google.com/*

const GMAIL_PREFIX = '[SimpleAuthFlow:gmail-mail]';
const GMAIL_LIST_TIMESTAMP_TOLERANCE_MS = 20 * 1000;

console.log(GMAIL_PREFIX, 'Content script loaded on', location.href);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'POLL_EMAIL' && message.type !== 'GET_REFRESH_BUTTON_RECT') return;

  resetStopState();
  handleMessage(message).then((result) => {
    sendResponse(result);
  }).catch((err) => {
    if (isStopError(err)) {
      log('Gmail：已被用户停止。', 'warn');
      sendResponse({ stopped: true, error: err.message });
      return;
    }

    reportError(message.step, err.message);
    sendResponse({ error: err.message });
  });

  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'POLL_EMAIL':
      return pollGmailMailbox(message.step, message.payload || {});
    case 'GET_REFRESH_BUTTON_RECT':
      return getRefreshButtonRect();
    default:
      throw new Error(`不支持的消息类型：${message.type}`);
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function extractVerificationCode(text) {
  const source = text || '';
  const matchCn = source.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = source.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = source.match(/\b(\d{6})\b/);
  return match6 ? match6[1] : null;
}

function isGmailLoggedOut() {
  const bodyText = normalizeText(document.body?.innerText || '');
  return /choose an account|to continue to gmail|使用您的 google 帐号|登录/i.test(bodyText)
    && !findSearchBox();
}

function findSearchBox() {
  return document.querySelector(
    'input[aria-label*="Search mail" i], input[placeholder*="Search mail" i], input[name="q"], textarea[name="q"]'
  );
}

function findRefreshButton() {
  return Array.from(document.querySelectorAll('div[role="button"], button')).find((el) => {
    if (!isElementVisible(el)) return false;
    const text = normalizeText(
      el.getAttribute('aria-label')
      || el.getAttribute('data-tooltip')
      || el.getAttribute('title')
      || el.textContent
      || ''
    );
    return /refresh|刷新/i.test(text);
  });
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error('Gmail 刷新按钮没有可点击尺寸。');
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

async function waitForGmailReady(timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isGmailLoggedOut()) {
      throw new Error('Gmail 未登录，请先在 Gmail 页面完成登录后再继续。');
    }

    const searchBox = findSearchBox();
    const rows = getVisibleMailRows();
    if (searchBox || rows.length > 0) {
      return;
    }

    await sleep(250);
  }

  throw new Error('Gmail 页面未在预期时间内准备就绪。');
}

async function getRefreshButtonRect() {
  await waitForGmailReady(20000);
  await ensureOnMailList(10000);
  const refreshButton = findRefreshButton();
  if (!refreshButton) {
    throw new Error('在 Gmail 页面中找不到刷新按钮。');
  }
  refreshButton.scrollIntoView({ block: 'center', inline: 'center' });
  await sleep(200);
  return {
    rect: getSerializableRect(refreshButton),
    buttonText: normalizeText(
      refreshButton.getAttribute('aria-label')
      || refreshButton.getAttribute('data-tooltip')
      || refreshButton.textContent
      || '刷新'
    ),
    url: location.href,
  };
}

function setTextControlValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function buildSearchQuery(senderFilters = [], subjectFilters = []) {
  const parts = new Set([
    'openai',
    'chatgpt',
    ...senderFilters,
    ...subjectFilters,
  ].map((value) => normalizeText(value)).filter(Boolean));

  const queryTerms = [...parts].map((part) => `"${part}"`).join(' OR ');
  return `in:anywhere newer_than:2d ${queryTerms ? `(${queryTerms})` : ''}`.trim();
}

async function ensureSearchQuery(query) {
  const searchBox = await waitForElement(
    'input[aria-label*="Search mail" i], input[placeholder*="Search mail" i], input[name="q"], textarea[name="q"]',
    15000
  );

  const currentValue = normalizeText(searchBox.value || '');
  if (currentValue === normalizeText(query)) {
    return;
  }

  searchBox.scrollIntoView({ block: 'center', inline: 'center' });
  searchBox.focus();
  await sleep(150);
  setTextControlValue(searchBox, query);
  await sleep(100);
  searchBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  searchBox.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  await sleep(1500);
}

function getVisibleMailRows() {
  const selectors = ['tr[role="row"]', 'table tr.zA'];
  const rows = [];
  for (const selector of selectors) {
    for (const row of document.querySelectorAll(selector)) {
      if (!isElementVisible(row)) continue;
      const text = normalizeText(row.innerText || row.textContent || '');
      if (!text || text.length < 8) continue;
      rows.push(row);
    }
    if (rows.length > 0) break;
  }
  return rows;
}

function isMailListVisible() {
  return getVisibleMailRows().length > 0;
}

function getRowId(row) {
  return row.getAttribute('data-legacy-thread-id')
    || row.getAttribute('data-legacy-message-id')
    || row.getAttribute('data-message-id')
    || normalizeText(row.innerText || row.textContent || '').slice(0, 120);
}

function rowMatchesFilters(rowText, senderFilters = [], subjectFilters = []) {
  const lower = rowText.toLowerCase();
  const senderMatch = senderFilters.some((value) => lower.includes(String(value || '').toLowerCase()));
  const subjectMatch = subjectFilters.some((value) => lower.includes(String(value || '').toLowerCase()));
  const keywordMatch = /openai|chatgpt|verify|verification|confirm|login|验证码|代码|code/.test(lower);
  return senderMatch || subjectMatch || keywordMatch;
}

function extractTimestampFromRow(row) {
  const candidate = Array.from(row.querySelectorAll('[title], time[datetime], [data-time]'))
    .map((el) => el.getAttribute('title') || el.getAttribute('datetime') || el.getAttribute('data-time') || '')
    .find(Boolean);
  if (candidate) {
    return normalizeText(candidate);
  }

  const textSelectors = [
    'td.xW span',
    '.xW span',
    'span[email] + span',
    'td[title]',
    '[role="gridcell"] span',
  ];

  for (const selector of textSelectors) {
    for (const el of row.querySelectorAll(selector)) {
      const text = normalizeText(el.innerText || el.textContent || '');
      if (!text) continue;
      if (
        /^\d{1,2}:\d{2}$/.test(text)
        || /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(text)
        || /^\d{1,2}月\d{1,2}日/.test(text)
        || /^[A-Z][a-z]{2}\s+\d{1,2}$/.test(text)
        || /^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}$/.test(text)
      ) {
        return text;
      }
    }
  }

  return '';
}

async function returnToMailList(timeout = 10000) {
  const backButton = Array.from(document.querySelectorAll('div[role="button"], button'))
    .find((button) => isElementVisible(button) && /back to inbox|返回收件箱|返回/i.test(button.getAttribute('aria-label') || button.textContent || ''));

  if (backButton) {
    simulateClick(backButton);
  } else {
    history.back();
  }

  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isMailListVisible()) return;
    await sleep(200);
  }
}

async function ensureOnMailList(timeout = 10000) {
  if (isMailListVisible()) return;
  await returnToMailList(timeout);
  if (!isMailListVisible()) {
    throw new Error('Gmail 当前不在邮件列表页，无法解析收件箱数据。');
  }
}

async function extractCodeFromRow(row, options = {}) {
  const { requireTimestamp = false } = options;
  const rowCode = extractVerificationCode(normalizeText(row.innerText || row.textContent || ''));
  const rowTimestamp = extractTimestampFromRow(row);
  if (rowCode && (!requireTimestamp || rowTimestamp)) {
    return { code: rowCode, timestamp: rowTimestamp, mailId: getRowId(row) };
  }
  return { code: null, timestamp: rowTimestamp, mailId: getRowId(row) };
}

function parseTimestamp(value) {
  const text = normalizeText(value);
  if (!text) return null;

  const fullCn = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:周.|星期.)?\s*(\d{1,2}):(\d{2})$/);
  if (fullCn) {
    const [, year, month, day, hour, minute] = fullCn;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0,
      0
    ).getTime();
  }

  const monthDayCn = text.match(/^(\d{1,2})月(\d{1,2})日(?:周.|星期.)?\s*(\d{1,2}):(\d{2})$/);
  if (monthDayCn) {
    const now = new Date();
    const [, month, day, hour, minute] = monthDayCn;
    return new Date(
      now.getFullYear(),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0,
      0
    ).getTime();
  }

  const timeOnlyCn = text.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnlyCn) {
    const now = new Date();
    const [, hour, minute] = timeOnlyCn;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(hour),
      Number(minute),
      0,
      0
    ).getTime();
  }

  const timeAmPm = text.match(/^(\d{1,2}):(\d{2})\s?(AM|PM)$/i);
  if (timeAmPm) {
    const now = new Date();
    let [, hour, minute, ampm] = timeAmPm;
    hour = Number(hour);
    minute = Number(minute);
    ampm = String(ampm || '').toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
      0,
      0
    ).getTime();
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

async function pollGmailMailbox(step, payload) {
  const {
    senderFilters = [],
    subjectFilters = [],
    filterAfterTimestamp = 0,
    maxAttempts = 1,
    intervalMs = 3000,
    excludedCodes = [],
    excludedMailIds = [],
  } = payload;

  await waitForGmailReady(20000);
  await ensureOnMailList(10000);
  log(`步骤 ${step}：开始轮询 Gmail（最多 ${maxAttempts} 次）`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    log(`正在轮询 Gmail... 第 ${attempt}/${maxAttempts} 次`);
    const skipStats = {
      missingRowId: 0,
      excludedMailId: 0,
      filterMismatch: 0,
      noCode: 0,
      excludedCode: 0,
      noTimestamp: 0,
      olderThanWindow: 0,
    };

    const rows = getVisibleMailRows();
    for (const row of rows) {
      const rowId = getRowId(row);
      if (!rowId) {
        skipStats.missingRowId += 1;
        continue;
      }
      if (excludedMailIds.includes(rowId)) {
        skipStats.excludedMailId += 1;
        continue;
      }

      const rowText = normalizeText(row.innerText || row.textContent || '');
      if (!rowMatchesFilters(rowText, senderFilters, subjectFilters)) {
        skipStats.filterMismatch += 1;
        continue;
      }

      const result = await extractCodeFromRow(row, { requireTimestamp: Boolean(filterAfterTimestamp) });
      if (!result?.code) {
        skipStats.noCode += 1;
        continue;
      }
      if (excludedCodes.includes(result.code)) {
        skipStats.excludedCode += 1;
        continue;
      }

      const timestamp = parseTimestamp(result.timestamp);
      if (filterAfterTimestamp) {
        if (!timestamp) {
          skipStats.noTimestamp += 1;
          continue;
        }
        if ((timestamp + GMAIL_LIST_TIMESTAMP_TOLERANCE_MS) < filterAfterTimestamp) {
          skipStats.olderThanWindow += 1;
          continue;
        }
      }

      log(`步骤 ${step}：已从 Gmail 找到验证码：${result.code}`, 'ok');
      return {
        ok: true,
        code: result.code,
        emailTimestamp: timestamp || Date.now(),
        mailId: result.mailId || rowId,
      };
    }

    if (attempt < maxAttempts) {
      log(`步骤 ${step}：本轮 Gmail 未命中验证码，跳过统计 ${JSON.stringify(skipStats)}`, 'info');
      await sleep(intervalMs);
      continue;
    }

    log(`步骤 ${step}：最后一轮 Gmail 未命中验证码，跳过统计 ${JSON.stringify(skipStats)}`, 'info');
  }

  return {
    ok: false,
    code: null,
    mailId: '',
  };
}
