import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('manifest 和侧边栏关键文案已汉化', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const sidepanelHtml = read('sidepanel/sidepanel.html');
  const sidepanelJs = read('sidepanel/sidepanel.js');

  assert.match(manifest.description, /简化.*OAuth.*流程/u);

  const englishUiTokens = [
    '>Auto<',
    '>Stop<',
    '>Workflow<',
    '>Console<',
    '>Continue<',
    '>Clear<',
    '>Get OAuth Link<',
    '>Open Signup<',
    '>Fill Email / Password<',
    '>Get Signup Code<',
    '>Fill Name / Birthday<',
    '>Login via OAuth<',
    '>Get Login Code<',
    '>VPS Verify<',
    'title="Number of runs"',
    'title="Run all steps automatically"',
    'title="Stop current flow"',
    'title="Reset all steps"',
    'title="Toggle theme"',
    'placeholder="Auto fetch from Burner Mailbox or paste manually"',
    'placeholder="Leave blank to auto-generate"',
  ];

  for (const token of englishUiTokens) {
    assert.equal(
      sidepanelHtml.includes(token),
      false,
      `侧边栏 HTML 仍包含英文文案: ${token}`
    );
  }

  const englishStatusTokens = [
    "'Ready'",
    "'Waiting...'",
    "'Show'",
    "'Hide'",
    "'Running...'",
    "'Please paste an email address or use Auto first'",
    "'Please fetch or paste a Burner Mailbox email first!'",
    "'Stopping current flow...'",
    "'Use Auto to fetch a Burner Mailbox email, or paste manually, then continue'",
    "'All steps completed!'",
  ];

  for (const token of englishStatusTokens) {
    assert.equal(
      sidepanelJs.includes(token),
      false,
      `侧边栏脚本仍包含英文状态文案: ${token}`
    );
  }
});

test('核心流程日志与错误提示已至少完成基础汉化', () => {
  const backgroundJs = read('background.js');
  const signupPageJs = read('content/signup-page.js');
  const burnerMailJs = read('content/burner-mail.js');
  const vpsPanelJs = read('content/vps-panel.js');

  const englishRuntimeTokens = [
    'Burner Mailbox security verification required.',
    'Flow stopped by user.',
    'Step 1: Waiting for VPS panel to load',
    'Step 2: Looking for Register/Sign up button...',
    'Could not find the Burner Mailbox "New" button.',
    'Authentication successful!',
  ];

  for (const token of englishRuntimeTokens) {
    const exists = [
      backgroundJs,
      signupPageJs,
      burnerMailJs,
      vpsPanelJs,
    ].some(content => content.includes(token));

    assert.equal(exists, false, `运行时脚本仍包含英文提示: ${token}`);
  }
});
