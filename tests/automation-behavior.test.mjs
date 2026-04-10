import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const backgroundJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');
const signupPageJs = fs.readFileSync(path.join(rootDir, 'content', 'signup-page.js'), 'utf8');
const burnerMailJs = fs.readFileSync(path.join(rootDir, 'content', 'burner-mail.js'), 'utf8');
const gmailMailJs = fs.readFileSync(path.join(rootDir, 'content', 'gmail-mail.js'), 'utf8');
const utilsJs = fs.readFileSync(path.join(rootDir, 'content', 'utils.js'), 'utf8');
const sidepanelJs = fs.readFileSync(path.join(rootDir, 'sidepanel', 'sidepanel.js'), 'utf8');
const sidepanelHtml = fs.readFileSync(path.join(rootDir, 'sidepanel', 'sidepanel.html'), 'utf8');
const manifestJson = fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('步骤 4 和步骤 7 不会在进入后立刻触发验证码重发', () => {
  assert.match(backgroundJs, /async function clickResendOnSignupPage\(step, clicks = 1\)/);
  assert.doesNotMatch(
    backgroundJs,
    /async function executeStep4\(state\)\s*{[\s\S]*?await clickResendOnSignupPage\(4(?:,\s*\d+)?\);/,
    '步骤 4 仍然在进入后立刻触发重发'
  );
  assert.doesNotMatch(
    backgroundJs,
    /async function executeStep7\(state\)\s*{[\s\S]*?await clickResendOnSignupPage\(7(?:,\s*\d+)?\);/,
    '步骤 7 仍然在进入后立刻触发重发'
  );
  assert.match(
    backgroundJs,
    /const result = await chrome\.tabs\.sendMessage\(signupTabId, \{[\s\S]*?type: 'RESEND_VERIFICATION_EMAIL'[\s\S]*?await clickWithDebugger\(signupTabId, result\.rect\);/,
    '重发验证码没有改为返回坐标后由后台执行真实点击'
  );
});

test('步骤 4 和步骤 7 会延长邮箱轮询到 20 秒，并将失败后的补发次数降为 1 次', () => {
  assert.match(
    backgroundJs,
    /async function executeStep4\(state\)\s*{[\s\S]*?mailPollAttempts:\s*5,[\s\S]*?mailPollIntervalMs:\s*4000,[\s\S]*?resendClicks:\s*1,/,
    '步骤 4 没有使用 20 秒轮询和单次补发配置'
  );
  assert.match(
    backgroundJs,
    /async function executeStep7\(state\)\s*{[\s\S]*?mailPollAttempts:\s*5,[\s\S]*?mailPollIntervalMs:\s*4000,[\s\S]*?resendClicks:\s*1,/,
    '步骤 7 没有使用 20 秒轮询和单次补发配置'
  );
  assert.match(
    backgroundJs,
    /while \(Date\.now\(\) - startedAt <= totalDurationMs\) \{[\s\S]*?await addLog\(`步骤 \$\{step\}：正在打开 \$\{mail\.label\}\.\.\.`\);[\s\S]*?await requestVerificationEmailResend\(step, resendClicks\);/,
    '普通网页邮箱验证码轮询没有改为持续等待并按配置执行单次补发'
  );
});

test('邮箱轮询超时的中文报错会被识别为可重试错误', () => {
  assert.match(
    backgroundJs,
    /function isNoMatchingEmailError\(error\)\s*{[\s\S]*?message\.includes\('未在 Burner Mailbox 中找到匹配的验证码邮件'\)[\s\S]*?message\.includes\('未找到匹配的验证码邮件'\)/,
    '中文的邮箱未匹配报错没有被纳入可重试判断'
  );
});

test('新建自动化标签页会固定到同一个浏览器窗口', () => {
  assert.match(backgroundJs, /let automationWindowId = null;/);
  assert.match(backgroundJs, /async function ensureAutomationWindowId\(\)/);
  assert.match(
    backgroundJs,
    /const wid = await ensureAutomationWindowId\(\);\s*const tab = await chrome\.tabs\.create\(\{\s*url,\s*active: true,\s*windowId: wid\s*\}\);/,
    'reuseOrCreateTab 没有把新标签固定到 automationWindowId'
  );
  assert.match(
    backgroundJs,
    /const registry = await getTabRegistry\(\);\s*registry\[source\] = \{ tabId: tab\.id, ready: false \};\s*await setState\(\{ tabRegistry: registry \}\);/,
    '新建标签后没有预注册 tabRegistry，可能导致重复开标签'
  );
});

test('步骤 9 复用已有 VPS 标签时不会重复注入内容脚本', () => {
  assert.match(
    backgroundJs,
    /const existingTabId = await getTabId\('vps-panel'\);\s*const alive = existingTabId && await isTabAlive\('vps-panel'\);\s*const tabId = alive\s*\?\s*existingTabId\s*:\s*await reuseOrCreateTab\('vps-panel', vpsUrl, \{\s*inject: \['content\/utils\.js', 'content\/vps-panel\.js'\],\s*\}\);/,
    '步骤 9 没有在复用已有标签时跳过重复注入'
  );
  assert.match(
    backgroundJs,
    /if \(alive\) {\s*await chrome\.tabs\.update\(tabId, \{ active: true \}\);\s*}/,
    '步骤 9 复用已有标签时没有仅激活标签'
  );
});

test('步骤 8 只会在 Codex 授权确认页执行继续点击', () => {
  assert.match(
    backgroundJs,
    /const EXPECTED_CODEX_CONSENT_URL = 'https:\/\/auth\.openai\.com\/sign-in-with-chatgpt\/codex\/consent';/,
    '后台没有声明步骤 8 的目标授权确认 URL'
  );
  assert.match(
    backgroundJs,
    /if \(!isExpectedCodexConsentUrl\(currentUrl\)\) {\s*throw new Error\(`步骤 8 当前页面不是 Codex 授权确认页。当前：\$\{currentUrl\}，预期：\$\{EXPECTED_CODEX_CONSENT_URL\}`\);/,
    '后台没有在步骤 8 点击前校验当前 URL'
  );
  assert.match(
    signupPageJs,
    /const EXPECTED_CODEX_CONSENT_URL = 'https:\/\/auth\.openai\.com\/sign-in-with-chatgpt\/codex\/consent';[\s\S]*?if \(currentUrl !== EXPECTED_CODEX_CONSENT_URL\) {\s*throw new Error\(`当前页面不是 Codex 授权确认页。当前：\$\{currentUrl\}，预期：\$\{EXPECTED_CODEX_CONSENT_URL\}`\);/,
    '内容脚本没有在步骤 8 查找继续按钮前校验当前 URL'
  );
});

test('重发验证码按钮会滚动到可见区域并优先使用原生点击', () => {
  assert.match(
    signupPageJs,
    /const selector = 'button\[name="intent"\]\[value="resend"\], button\[type="submit"\]\[name="intent"\]\[value="resend"\], button\[value="resend"\], button\[form\]\[name="intent"\]\[value="resend"\]';/,
    '重发验证码按钮选择器没有限制为 value=resend'
  );
  assert.match(
    signupPageJs,
    /const resendBtn = await waitForResendButton\(10000\);\s*await waitForResendButtonReady\(resendBtn, 800, 12000\);/,
    '重发验证码按钮在点击前没有等待稳定可交互'
  );
  assert.doesNotMatch(
    signupPageJs,
    /const selector = 'button\[name="intent"\]\[value="resend"\], button\[value="resend"\], button\[type="submit"\]\[name="intent"\]';/,
    '重发验证码按钮选择器仍然会误选 value=validate 的继续按钮'
  );
  assert.match(
    signupPageJs,
    /resendBtn\.scrollIntoView\(\{ block: 'center', inline: 'center' \}\);[\s\S]*?const rect = getSerializableRect\(resendBtn\);[\s\S]*?clickMode: 'debugger',[\s\S]*?rect,/,
    '重发验证码按钮没有改为返回调试器点击坐标'
  );
  assert.doesNotMatch(
    signupPageJs,
    /resendBtn\.click\(\)/,
    '重发验证码按钮仍然在使用原生 click 导致表单提交'
  );
  assert.doesNotMatch(
    signupPageJs,
    /simulateClick\(resendBtn\)/,
    '重发验证码按钮仍然在使用页面内 synthetic click'
  );
});

test('生日 spinbutton 会通过 ArrowUp 或 ArrowDown 调整到目标值', () => {
  assert.match(
    signupPageJs,
    /async function setSpinButton\(el, value\) \{[\s\S]*?readSpinButtonValue[\s\S]*?key = Number\.isNaN\(currentValue\) \|\| currentValue < targetValue \? 'ArrowUp' : 'ArrowDown'[\s\S]*?el\.setAttribute\('aria-valuenow', String\(targetValue\)\);/,
    '生日 spinbutton 仍未使用箭头步进方式设置目标值'
  );
});

test('第 5 步会在点击完成帐户创建后等待页面进入下一阶段再完成', () => {
  assert.match(
    signupPageJs,
    /const initialUrl = location\.href;[\s\S]*?simulateClick\(completeBtn\);[\s\S]*?await waitForStep5Transition\(initialUrl, 30000\);[\s\S]*?reportComplete\(5\);/,
    '第 5 步没有在页面跳转后再上报完成'
  );
  assert.match(
    signupPageJs,
    /async function waitForStep5Transition\(initialUrl, timeout = 30000\)/,
    '缺少第 5 步页面跳转等待逻辑'
  );
});

test('邮箱服务支持在 Burner Mailbox 和 DuckDuckGo 之间切换', () => {
  assert.match(
    sidepanelHtml,
    /<select id="input-mail-provider" class="data-select">[\s\S]*?<option value="burner-mail">Burner Mailbox<\/option>[\s\S]*?<option value="duckduckgo">DuckDuckGo<\/option>[\s\S]*?<option value="duck_google">Duck \+ Google<\/option>/,
    '侧边栏没有提供 Burner Mailbox、DuckDuckGo 和 Duck + Google 的切换入口'
  );
  assert.match(
    sidepanelHtml,
    /id="input-duck-google-api-base"[\s\S]*?id="input-duck-google-token"[\s\S]*?id="input-duck-google-alias-domain"/,
    'Duck + Google 没有独立的 Duck 参数输入框'
  );
  assert.match(
    backgroundJs,
    /const DUCKDUCKGO_API_BASE = 'https:\/\/quack\.duckduckgo\.com';[\s\S]*?const DEFAULT_MAIL_PROVIDER = 'burner-mail';/,
    '后台没有声明 DuckDuckGo 提供商默认配置'
  );
  assert.match(
    backgroundJs,
    /async function fetchSelectedProviderEmail\(options = \{\}\) \{[\s\S]*?const fetcher = \['duckduckgo', 'duck_google'\]\.includes\(provider\) \? fetchDuckDuckGoEmail : fetchBurnerEmail;[\s\S]*?for \(let attempt = 1; attempt <= MAX_FRESH_EMAIL_ATTEMPTS; attempt\+\+\) \{/,
    '后台没有按所选邮箱服务分发获取邮箱逻辑'
  );
  assert.match(
    backgroundJs,
    /async function pollDuckDuckGoVerificationCode\(mail, step, options\) \{[\s\S]*?fetchDuckDuckGoMessages\(mail\)[\s\S]*?未在 DuckDuckGo 收件箱中找到匹配的验证码邮件/,
    '后台没有实现 DuckDuckGo 验证码轮询逻辑'
  );
  assert.match(
    backgroundJs,
    /parseMailTimestamp\(message\.time, \{ assumeUtcWithoutZone: true \}\)/,
    'DuckDuckGo 邮件时间没有按 UTC 无时区格式解析'
  );
  assert.match(
    backgroundJs,
    /id: record\.id \|\| record\.mail_id \|\| record\.mailId \|\| record\.message_id \|\| record\.uuid \|\| ''/,
    'DuckDuckGo 邮件记录没有兼容 message_id 字段'
  );
  assert.match(
    backgroundJs,
    /if \(provider === 'duck_google'\) {\s*return \{\s*provider,\s*source: 'gmail-mail',\s*url: GMAIL_INBOX_URL,\s*label: getMailProviderLabel\(provider\),[\s\S]*?\};\s*}/,
    '后台没有为 Duck + Google 渠道返回 Gmail 收件箱配置'
  );
  assert.match(
    backgroundJs,
    /function getDuckGoogleAliasConfig\(state\) \{[\s\S]*?duckGoogleApiBase[\s\S]*?duckGoogleToken[\s\S]*?duckGoogleAliasDomain/,
    '后台没有为 Duck + Google 渠道使用独立参数'
  );
  assert.match(
    sidepanelJs,
    /const usesDuckDuckGoConfig = provider === 'duckduckgo';[\s\S]*?const usesDuckGoogleConfig = provider === 'duck_google';/,
    '侧边栏没有把 DuckDuckGo 和 Duck + Google 的配置区分显示'
  );
  assert.match(
    manifestJson,
    /"matches": \[\s*"https:\/\/mail\.google\.com\/\*"\s*\],\s*"js": \["content\/utils\.js", "content\/gmail-mail\.js"\]/,
    'manifest 没有注入 Gmail 页面脚本'
  );
  assert.match(
    utilsJs,
    /if \(url\.includes\('mail\.google\.com'\)\) return 'gmail-mail';/,
    '共享工具没有识别 Gmail 页面来源'
  );
  assert.match(
    gmailMailJs,
    /async function pollGmailMailbox\(step, payload\)/,
    '没有实现 Gmail 页面验证码轮询脚本'
  );
  assert.match(
    gmailMailJs,
    /case 'GET_REFRESH_BUTTON_RECT':\s*return getRefreshButtonRect\(\);/,
    'Gmail 页面脚本没有提供刷新按钮坐标接口'
  );
  assert.match(
    gmailMailJs,
    /function isElementVisible\(el\) \{/,
    'Gmail 页面脚本缺少可见性判断函数'
  );
  assert.match(
    gmailMailJs,
    /const GMAIL_LIST_TIMESTAMP_TOLERANCE_MS = 20 \* 1000;/,
    'Gmail 页面脚本没有把列表时间误差容差限制为 20 秒'
  );
  assert.match(
    gmailMailJs,
    /const textSelectors = \[[\s\S]*?'td\.xW span'[\s\S]*?'\.xW span'[\s\S]*?'span\[email\] \+ span'[\s\S]*?'td\[title\]'[\s\S]*?'\[role="gridcell"\] span'[\s\S]*?\];/,
    'Gmail 页面脚本没有补充列表时间文本兜底提取'
  );
  assert.match(
    gmailMailJs,
    /const result = await extractCodeFromRow\(row, \{ requireTimestamp: Boolean\(filterAfterTimestamp\) \}\);[\s\S]*?const timestamp = parseTimestamp\(result\.timestamp\);[\s\S]*?if \(filterAfterTimestamp\) {\s*if \(!timestamp\) {[\s\S]*?continue;\s*}\s*if \(\(timestamp \+ GMAIL_LIST_TIMESTAMP_TOLERANCE_MS\) < filterAfterTimestamp\) {[\s\S]*?continue;\s*}\s*}/,
    'Gmail 页面轮询在有时间窗口时没有强制校验邮件时间'
  );
  assert.match(
    gmailMailJs,
    /async function ensureOnMailList\(timeout = 10000\)/,
    'Gmail 页面脚本没有在解析前确保返回邮件列表'
  );
  assert.match(
    gmailMailJs,
    /const result = await extractCodeFromRow\(row, \{ requireTimestamp: Boolean\(filterAfterTimestamp\) \}\);[\s\S]*?if \(!result\?\.code\) {[\s\S]*?continue;\s*}/,
    'Gmail 页面脚本没有改为只从列表解析验证码'
  );
  assert.match(
    gmailMailJs,
    /return \{\s*ok: false,\s*code: null,\s*mailId: '',\s*\};/,
    'Gmail 页面脚本在未命中验证码时仍然没有返回空结果继续轮询'
  );
  assert.doesNotMatch(
    gmailMailJs,
    /throw new Error\('未在 Gmail 收件箱中找到匹配的验证码邮件。'\);/,
    'Gmail 页面脚本在未命中验证码时仍然直接抛错'
  );
  assert.doesNotMatch(
    gmailMailJs,
    /waitForMailDetail|已从 Gmail 邮件详情找到验证码|allowOpenDetail/,
    'Gmail 页面脚本仍然保留了打开邮件详情的兜底逻辑'
  );
  assert.match(
    gmailMailJs,
    /const fullCn = text\.match\(\/\^\(\\d\{4\}\)年\(\\d\{1,2\}\)月\(\\d\{1,2\}\)日/,
    'Gmail 页面脚本没有解析中文完整日期时间'
  );
  assert.match(
    gmailMailJs,
    /const monthDayCn = text\.match\(\/\^\(\\d\{1,2\}\)月\(\\d\{1,2\}\)日/,
    'Gmail 页面脚本没有解析中文月日时间'
  );
  assert.match(
    gmailMailJs,
    /const timeAmPm = text\.match\(\/\^\(\\d\{1,2\}\):\(\\d\{2\}\)\\s\?\(AM\|PM\)\$\/i\);/,
    'Gmail 页面脚本没有解析 AM\/PM 时间'
  );
  assert.match(
    gmailMailJs,
    /本轮 Gmail 未命中验证码，跳过统计|最后一轮 Gmail 未命中验证码，跳过统计/,
    'Gmail 页面脚本没有输出未命中验证码的跳过统计日志'
  );
});

test('配置项会持久化到 storage.local 并在重载后恢复', () => {
  assert.match(
    backgroundJs,
    /const PERSISTED_SETTING_KEYS = \[[\s\S]*?'email'[\s\S]*?'mailProvider'[\s\S]*?'ddgApiBase'[\s\S]*?'vpsUrl'[\s\S]*?'customPassword'[\s\S]*?\];/,
    '后台没有声明需要持久化的配置键'
  );
  assert.match(
    backgroundJs,
    /async function getState\(\) \{[\s\S]*?chrome\.storage\.session\.get\(null\)[\s\S]*?chrome\.storage\.local\.get\(PERSISTED_SETTING_KEYS\)[\s\S]*?return \{ \.\.\.DEFAULT_STATE, \.\.\.persistedState, \.\.\.sessionState \};/,
    'getState 没有在重载后合并 storage.local 配置'
  );
  assert.match(
    backgroundJs,
    /async function persistSettings\(updates\) \{[\s\S]*?await chrome\.storage\.local\.set\(persistedUpdates\);/,
    '配置没有写入 storage.local'
  );
  assert.match(
    backgroundJs,
    /case 'SAVE_SETTING': \{[\s\S]*?await setStateAndPersist\(updates\);/,
    '保存设置时没有同步持久化'
  );
});

test('DuckDuckGo 验证码会在 3 分钟内每 4 秒轮询，并在固定时点重发', () => {
  assert.match(
    backgroundJs,
    /const DEFAULT_STEP_TIMEOUT_MS = 200000;[\s\S]*?const DEFAULT_VERIFICATION_RETRY_SCHEDULE_MS = \[10000\];/,
    '默认超时或验证码单次重发时点常量没有统一声明'
  );
  assert.match(
    backgroundJs,
    /const failedCodes = new Set\(\);[\s\S]*?const failedMailIds = new Set\(\);/,
    'DuckDuckGo 验证码轮询没有记录失败的验证码或邮件'
  );
  assert.match(
    backgroundJs,
    /const advanceFilterAfterTimestamp = \(currentValue, emailTimestamp\) => \{[\s\S]*?return Math\.max\(currentValue \|\| 0, numericTimestamp \+ 1\);[\s\S]*?\};/,
    '验证码轮询没有在验证码失效后推进时间下限'
  );
  assert.match(
    backgroundJs,
    /excludedCodes: new Set\(\[\.\.\.excludedCodes, \.\.\.failedCodes\]\),[\s\S]*?excludedMailIds: new Set\(\[\.\.\.excludedMailIds, \.\.\.failedMailIds\]\),/,
    'DuckDuckGo 验证码轮询没有排除失败过的验证码或邮件'
  );
  assert.match(
    backgroundJs,
    /if \(submitResult\?\.invalidCode\) {\s*failedCodes\.add\(result\.code\);[\s\S]*?failedMailIds\.add\(String\(result\.mailId\)\);[\s\S]*?currentFilterAfterTimestamp = advanceFilterAfterTimestamp\(/,
    '验证码错误后没有排除已失败的邮件或验证码'
  );
  assert.match(
    backgroundJs,
    /if \(mail\.provider === 'duck_google'\) \{[\s\S]*?let currentFilterAfterTimestamp = filterAfterTimestamp \|\| 0;[\s\S]*?filterAfterTimestamp: currentFilterAfterTimestamp,[\s\S]*?currentFilterAfterTimestamp = advanceFilterAfterTimestamp\(/,
    'Duck + Google 验证码轮询没有在验证码失效后推进时间下限'
  );
  assert.match(
    backgroundJs,
    /retryWaitScheduleMs = DEFAULT_VERIFICATION_RETRY_SCHEDULE_MS/,
    '验证码重试等待时点没有统一使用公共常量'
  );
  assert.match(
    backgroundJs,
    /function waitForStepComplete\(step, timeoutMs = DEFAULT_STEP_TIMEOUT_MS\)/,
    '步骤完成等待没有统一使用默认超时常量'
  );
  assert.match(
    backgroundJs,
    /async function executeStepAndWait\(step, delayAfter = 2000, timeoutMs = DEFAULT_STEP_TIMEOUT_MS\)/,
    'executeStepAndWait 没有统一使用默认超时常量'
  );
  assert.doesNotMatch(
    backgroundJs,
    /await executeStepAndWait\(4, 2000, 300000\)|await executeStepAndWait\(7, 2000, 300000\)/,
    '自动运行里的步骤 4 或步骤 7 仍然写死了单独超时'
  );
  assert.match(
    backgroundJs,
    /async function refreshGmailInbox\(step, mail\) \{[\s\S]*?type: 'GET_REFRESH_BUTTON_RECT'[\s\S]*?await clickWithDebugger\(gmailTabId, refreshTarget\.rect\);/,
    'Duck + Google 没有实现 Gmail 刷新真实点击'
  );
  assert.match(
    backgroundJs,
    /await clickWithDebugger\(gmailTabId, refreshTarget\.rect\);[\s\S]*?await sleepWithStop\(1000\);/,
    'Gmail 刷新后没有只等待 1 秒就开始解析'
  );
  assert.match(
    backgroundJs,
    /if \(mail\.provider === 'duck_google'\) \{[\s\S]*?await openMailTab\(mail\);[\s\S]*?await refreshGmailInbox\(step, mail\);[\s\S]*?const result = await pollWebInboxVerificationCode\(mail, step,[\s\S]*?已到第 \$\{Math\.round\(resendAt \/ 1000\)\} 秒，正在返回授权页请求重发/,
    'Duck + Google 没有按先刷新解析、后判断固定重发时间的顺序执行'
  );
  assert.match(
    backgroundJs,
    /const totalDurationMs = DEFAULT_STEP_TIMEOUT_MS;[\s\S]*?const startedAt = Date\.now\(\);[\s\S]*?const triggeredResends = new Set\(\);[\s\S]*?const failedCodes = new Set\(\);[\s\S]*?const failedMailIds = new Set\(\);[\s\S]*?let currentFilterAfterTimestamp = filterAfterTimestamp \|\| 0;[\s\S]*?excludedCodes: \[\.\.\.excludedCodes, \.\.\.failedCodes\],[\s\S]*?excludedMailIds: \[\.\.\.excludedMailIds, \.\.\.failedMailIds\],[\s\S]*?currentFilterAfterTimestamp = advanceFilterAfterTimestamp\(/,
    '普通网页邮箱轮询没有在验证码失效后同步推进时间下限并排除失败邮件'
  );
  assert.match(
    backgroundJs,
    /for \(const resendAt of retryWaitScheduleMs\) \{[\s\S]*?if \(elapsedMs >= resendAt && !triggeredResends\.has\(resendAt\)\) \{[\s\S]*?await requestVerificationEmailResend\(step, resendClicks\);[\s\S]*?triggeredResends\.add\(resendAt\);/,
    '验证码轮询没有限制为固定时点单次重发'
  );
});

test('步骤 7 会排除步骤 4 已经使用过的验证码', () => {
  assert.match(
    backgroundJs,
    /await setState\(\{ lastSignupVerificationCode: code \}\);/,
    '步骤 4 成功后没有记录已使用的注册验证码'
  );
  assert.match(
    backgroundJs,
    /excludedCodes: state\.lastSignupVerificationCode \? \[state\.lastSignupVerificationCode\] : \[\]/,
    '步骤 7 没有排除步骤 4 已使用的验证码'
  );
  assert.match(
    burnerMailJs,
    /excludedCodes = \[\],[\s\S]*?excludedMailIds = \[\],[\s\S]*?if \(excludedMailIds\.includes\(rowId\)\) continue;[\s\S]*?if \(excludedCodes\.includes\(code\)\) continue;/,
    'Burner Mailbox 轮询没有排除已使用的验证码或邮件'
  );
});

test('生成邮箱会重试 5 次避开历史邮箱，仍然重复则整体停止', () => {
  assert.match(
    backgroundJs,
    /const MAX_FRESH_EMAIL_ATTEMPTS = 5;[\s\S]*?const NO_FRESH_EMAIL_ERROR_MESSAGE = '无法再获取到新邮箱';/,
    '后台没有声明历史邮箱重试上限和致命错误文案'
  );
  assert.match(
    backgroundJs,
    /for \(let attempt = 1; attempt <= MAX_FRESH_EMAIL_ATTEMPTS; attempt\+\+\) \{[\s\S]*?if \(!usedEmails\.has\(normalized\)\) \{[\s\S]*?return email;[\s\S]*?命中历史邮箱/,
    '生成邮箱时没有在历史邮箱命中后继续重试'
  );
  assert.match(
    backgroundJs,
    /throw new Error\(`\$\{NO_FRESH_EMAIL_ERROR_MESSAGE\}，已连续 \$\{MAX_FRESH_EMAIL_ATTEMPTS\} 次命中历史邮箱。`\);/,
    '生成邮箱在连续命中历史邮箱后没有抛出致命错误'
  );
  assert.match(
    backgroundJs,
    /if \(isNoFreshEmailError\(err\)\) {\s*chrome\.runtime\.sendMessage\(status\('stopped'\)\)\.catch\(\(\) => \{\}\);\s*break;\s*}/,
    '自动运行在无法获取新邮箱时没有整体停止'
  );
});

test('自动运行单轮失败后会休眠 5 秒并继续下一轮', () => {
  assert.match(
    backgroundJs,
    /let successfulRuns = 0;[\s\S]*?let failedRuns = 0;/,
    '自动运行没有分别统计成功和失败轮次'
  );
  assert.match(
    backgroundJs,
    /if \(run < totalRuns\) {\s*await addLog\(`第 \$\{run\}\/\$\{totalRuns\} 轮失败后将休眠 5 秒，并继续下一轮。`, 'warn'\);[\s\S]*?await sleepWithStop\(5000\);[\s\S]*?continue;/,
    '自动运行单轮失败后没有休眠 5 秒并继续下一轮'
  );
  assert.doesNotMatch(
    backgroundJs,
    /failedRun = run;[\s\S]*?break; \/\/ Stop on error/,
    '自动运行仍然在单轮失败后直接整体停止'
  );
});

test('预期内流程失败会降级为前台提示而不是扩展错误噪音', () => {
  assert.match(
    utilsJs,
    /function isExpectedFlowIssueMessage\(message\)[\s\S]*?Burner Mailbox 需要进行安全验证[\s\S]*?未在 Burner Mailbox 中找到匹配的验证码邮件[\s\S]*?未在 DuckDuckGo 收件箱中找到匹配的验证码邮件[\s\S]*?Burner Mailbox 当前显示的是/,
    '内容脚本没有识别常见的预期流程失败'
  );
  assert.match(
    utilsJs,
    /const reporter = isExpectedFlowIssueMessage\(errorMessage\) \? console\.warn : console\.error;/,
    '内容脚本没有把预期失败降级为 warn'
  );
  assert.match(
    sidepanelJs,
    /window\.addEventListener\('unhandledrejection', \(event\) => \{[\s\S]*?isExpectedFlowIssueMessage\(message\)[\s\S]*?event\.preventDefault\(\);/,
    '侧边栏没有拦截预期内的未处理 Promise 拒绝'
  );
});
