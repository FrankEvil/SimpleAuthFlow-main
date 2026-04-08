import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const backgroundJs = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('步骤 4 和步骤 7 在轮询邮箱前会先触发验证码重发', () => {
  assert.match(backgroundJs, /async function clickResendOnSignupPage\(step, clicks = 1\)/);
  assert.match(
    backgroundJs,
    /async function executeStep4\(state\)\s*{[\s\S]*?await clickResendOnSignupPage\(4(?:,\s*\d+)?\);[\s\S]*?pollVerificationCodeWithRetry\(4,/,
    '步骤 4 没有在轮询前主动触发重发'
  );
  assert.match(
    backgroundJs,
    /async function executeStep7\(state\)\s*{[\s\S]*?await clickResendOnSignupPage\(7(?:,\s*\d+)?\);[\s\S]*?pollVerificationCodeWithRetry\(7,/,
    '步骤 7 没有在轮询前主动触发重发'
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
    /const wid = await ensureAutomationWindowId\(\);\s*const tab = await chrome\.tabs\.create\(\{\s*url: vpsUrl,\s*active: true,\s*windowId: wid\s*\}\);/,
    '步骤 9 创建 VPS 标签时没有固定到 automationWindowId'
  );
});
