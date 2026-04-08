// content/vps-panel.js — Content script for VPS panel (steps 1, 9)
// Injected on: VPS panel (user-configured URL)
//
// Actual DOM structure (after login click):
// <div class="card">
//   <div class="card-header">
//     <span class="OAuthPage-module__cardTitle___yFaP0">Codex OAuth</span>
//     <button class="btn btn-primary"><span>登录</span></button>
//   </div>
//   <div class="OAuthPage-module__cardContent___1sXLA">
//     <div class="OAuthPage-module__authUrlBox___Iu1d4">
//       <div class="OAuthPage-module__authUrlLabel___mYFJB">授权链接:</div>
//       <div class="OAuthPage-module__authUrlValue___axvUJ">https://auth.openai.com/...</div>
//       <div class="OAuthPage-module__authUrlActions___venPj">
//         <button class="btn btn-secondary btn-sm"><span>复制链接</span></button>
//         <button class="btn btn-secondary btn-sm"><span>打开链接</span></button>
//       </div>
//     </div>
//     <div class="OAuthPage-module__callbackSection___8kA31">
//       <input class="input" placeholder="http://localhost:1455/auth/callback?code=...&state=...">
//       <button class="btn btn-secondary btn-sm"><span>提交回调 URL</span></button>
//     </div>
//   </div>
// </div>

console.log('[SimpleAuthFlow:vps-panel] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP') {
    resetStopState();
    handleStep(message.step, message.payload).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      if (isStopError(err)) {
        log(`步骤 ${message.step}：已被用户停止。`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleStep(step, payload) {
  switch (step) {
    case 1: return await step1_getOAuthLink();
    case 9: return await step9_vpsVerify(payload);
    default:
      throw new Error(`vps-panel.js 不处理步骤 ${step}`);
  }
}

// ============================================================
// Step 1: Get OAuth Link
// ============================================================

async function step1_getOAuthLink() {
  log('步骤 1：正在等待 VPS 面板加载完成（自动登录可能需要一点时间）...');

  // The page may start at #/login and auto-redirect to #/oauth.
  // Wait for the Codex OAuth card to appear (up to 30s for auto-login + redirect).
  let loginBtn = null;
  try {
    // Wait for any card-header containing "Codex" to appear
    const header = await waitForElementByText('.card-header', /codex/i, 30000);
    loginBtn = header.querySelector('button.btn.btn-primary, button.btn');
    log('步骤 1：已找到 Codex OAuth 卡片');
  } catch {
    throw new Error(
      '30 秒后仍未出现 Codex OAuth 卡片，页面可能仍在加载或尚未登录。' +
      '当前 URL：' + location.href
    );
  }

  if (!loginBtn) {
    throw new Error('已找到 Codex OAuth 卡片，但其中没有登录按钮。URL：' + location.href);
  }

  // Check if button is disabled (already clicked / loading)
  if (loginBtn.disabled) {
    log('步骤 1：登录按钮已禁用（可能已在加载），正在等待授权链接...');
  } else {
    await humanPause(500, 1400);
    simulateClick(loginBtn);
    log('步骤 1：已点击登录按钮，正在等待授权链接...');
  }

  // Wait for the auth URL to appear in the specific div
  let authUrlEl = null;
  try {
    authUrlEl = await waitForElement('[class*="authUrlValue"]', 15000);
  } catch {
    throw new Error(
      '点击登录后未出现授权链接。' +
      '请检查 VPS 面板是否已登录，以及 Codex 服务是否正在运行。URL：' + location.href
    );
  }

  const oauthUrl = (authUrlEl.textContent || '').trim();
  if (!oauthUrl || !oauthUrl.startsWith('http')) {
    throw new Error(`获取到的 OAuth 链接无效："${oauthUrl.slice(0, 50)}"。预期应以 http 开头。`);
  }

  log(`步骤 1：已获取 OAuth 链接：${oauthUrl.slice(0, 80)}...`, 'ok');
  reportComplete(1, { oauthUrl });
}

// ============================================================
// Step 9: VPS Verify — paste localhost URL and submit
// ============================================================

async function step9_vpsVerify(payload) {
  // Get localhostUrl from payload (passed directly by background) or fallback to state
  let localhostUrl = payload?.localhostUrl;
  if (!localhostUrl) {
    log('步骤 9：payload 中没有 localhostUrl，正在从状态中读取...');
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    localhostUrl = state.localhostUrl;
  }
  if (!localhostUrl) {
    throw new Error('未找到 localhost 回调地址，请先完成步骤 8。');
  }
  log(`步骤 9：已获取 localhost 回调地址：${localhostUrl.slice(0, 60)}...`);

  log('步骤 9：正在查找回调地址输入框...');

  // Find the callback URL input
  // Actual DOM: <input class="input" placeholder="http://localhost:1455/auth/callback?code=...&state=...">
  let urlInput = null;
  try {
    urlInput = await waitForElement('[class*="callbackSection"] input.input', 10000);
  } catch {
    try {
      urlInput = await waitForElement('input[placeholder*="localhost"]', 5000);
    } catch {
      throw new Error('在 VPS 面板中找不到回调地址输入框。URL：' + location.href);
    }
  }

  await humanPause(600, 1500);
  fillInput(urlInput, localhostUrl);
  log(`步骤 9：已填写回调地址：${localhostUrl.slice(0, 80)}...`);

  // Find and click "提交回调 URL" button
  let submitBtn = null;
  try {
    submitBtn = await waitForElementByText(
      '[class*="callbackActions"] button, [class*="callbackSection"] button',
      /提交/,
      5000
    );
  } catch {
    try {
      submitBtn = await waitForElementByText('button.btn', /提交回调/, 5000);
    } catch {
      throw new Error('找不到“提交回调 URL”按钮。URL：' + location.href);
    }
  }

  await humanPause(450, 1200);
  simulateClick(submitBtn);
  log('步骤 9：已点击“提交回调 URL”，正在等待认证结果...');

  // Wait for "认证成功！" status badge to appear
  try {
    await waitForElementByText('.status-badge, [class*="status"]', /认证成功/, 30000);
    log('步骤 9：认证成功。', 'ok');
  } catch {
    // Check if there's an error message instead
    const statusEl = document.querySelector('.status-badge, [class*="status"]');
    const statusText = statusEl ? statusEl.textContent : 'unknown';
    if (/成功|success/i.test(statusText)) {
      log('步骤 9：认证成功。', 'ok');
    } else {
      log(`步骤 9：提交后的状态为“${statusText}”，可能仍在处理中。`, 'warn');
    }
  }

  reportComplete(9);
}
