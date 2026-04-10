// options/options.js — 设置页逻辑（通过消息与 background 通信）

const selectProvider = document.getElementById('select-provider');
const providerConfigContainer = document.getElementById('provider-config');
const inputCpaUrl = document.getElementById('input-cpa-url');
const btnSave = document.getElementById('btn-save');
const btnReset = document.getElementById('btn-reset');
const btnTheme = document.getElementById('btn-theme');

let providerMeta = [];       // 所有 Provider 的元数据
let providerConfigs = {};    // 每个 Provider 的已保存配置
let currentProviderId = '';   // 当前选中的 Provider

// ── 初始化 ──────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

async function init() {
  restoreTheme();
  btnTheme.addEventListener('click', toggleTheme);
  btnSave.addEventListener('click', handleSave);
  btnReset.addEventListener('click', handleReset);
  selectProvider.addEventListener('change', handleProviderChange);

  await loadProviderMeta();
  await loadSettings();
}

// ── Provider 元数据加载 ─────────────────────────────────────

async function loadProviderMeta() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_PROVIDER_META',
      source: 'options',
    });
    if (response?.error) throw new Error(response.error);
    providerMeta = response?.providers || [];
  } catch (err) {
    // background 尚未集成时使用内置元数据
    providerMeta = getBuiltinProviderMeta();
  }
  renderProviderSelect();
}

/**
 * 内置 Provider 元数据（background 未集成前的回退方案）
 */
function getBuiltinProviderMeta() {
  return [
    {
      id: 'burner_mailbox', name: 'Burner Mailbox', type: 'content-script',
      configFields: [],
    },
    {
      id: 'self_hosted_mail_api', name: 'Self-Hosted Mail API', type: 'api',
      configFields: [
        { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://mail.example.com' },
        { key: 'apiKey', label: 'API 密钥', type: 'password', required: true, placeholder: 'Bearer Token' },
        { key: 'domains', label: '域名列表', type: 'text', required: true, placeholder: '逗号分隔' },
      ],
    },
    {
      id: 'yyds_mail', name: 'YYDS Mail', type: 'api',
      configFields: [
        { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://maliapi.215.im/v1' },
        { key: 'apiKey', label: 'API 密钥', type: 'password', required: false, placeholder: 'X-API-Key（可选）' },
        { key: 'domains', label: '域名列表', type: 'text', required: false, placeholder: '逗号分隔（可选）' },
      ],
    },
    {
      id: 'tempmail_lol', name: 'Tempmail.lol', type: 'api',
      configFields: [
        { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://api.tempmail.lol/v2' },
      ],
    },
    {
      id: 'duckmail', name: 'Duckmail', type: 'api',
      configFields: [
        { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://api.duckmail.sbs' },
        { key: 'bearer', label: 'Admin Bearer Token', type: 'password', required: true, placeholder: '管理员 Bearer Token' },
        { key: 'domains', label: '域名列表', type: 'text', required: true, placeholder: '如 duckmail.sbs' },
      ],
    },
    {
      id: 'cfmail', name: 'CloudFlare Mail', type: 'api',
      configFields: [
        { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://cf-mail.example.com' },
        { key: 'apiKey', label: 'API 密钥', type: 'password', required: true, placeholder: 'Bearer Token' },
        { key: 'domains', label: '偏好域名', type: 'text', required: false, placeholder: '逗号分隔（可选）' },
      ],
    },
    {
      id: 'duckduckgo', name: 'DuckDuckGo', type: 'api',
      configFields: [
        { key: 'apiBase', label: 'API 地址', type: 'text', required: true, placeholder: 'https://quack.duckduckgo.com' },
        { key: 'token', label: 'DDG Token', type: 'password', required: true, placeholder: 'DuckDuckGo API Token' },
        { key: 'aliasDomain', label: '别名域名', type: 'text', required: false, placeholder: 'duck.com' },
        { key: 'tempMailAddress', label: 'TempMail 中继地址', type: 'text', required: true, placeholder: '收件中继 Base URL' },
        { key: 'tempMailJwt', label: 'TempMail JWT', type: 'password', required: true, placeholder: '中继认证 JWT' },
      ],
    },
    {
      id: 'custom_domain_tempmail', name: '自定义域名 (TempMail)', type: 'api',
      configFields: [
        { key: 'domains', label: '域名列表', type: 'text', required: true, placeholder: '逗号分隔' },
        { key: 'tmAddr', label: 'TempMail 取件邮箱', type: 'text', required: true, placeholder: 'xxx@tempmail.plus' },
        { key: 'tmEpin', label: 'TempMail PIN', type: 'password', required: false, placeholder: '取件 PIN（可选）' },
      ],
    },
  ];
}

// ── 设置加载 ────────────────────────────────────────────────

async function loadSettings() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_SETTINGS',
      source: 'options',
    });
    if (response?.error) throw new Error(response.error);
    applySettings(response);
  } catch (_err) {
    // background 未集成时直接从 storage 读取
    const data = await chrome.storage.local.get(['cpaUrl', 'emailProvider', 'providerConfigs']);
    applySettings({
      cpaUrl: data.cpaUrl || '',
      emailProvider: data.emailProvider || 'burner_mailbox',
      providerConfigs: data.providerConfigs || {},
    });
  }
}

function applySettings(settings) {
  inputCpaUrl.value = settings.cpaUrl || '';
  currentProviderId = settings.emailProvider || 'burner_mailbox';
  providerConfigs = settings.providerConfigs || {};

  selectProvider.value = currentProviderId;
  renderProviderConfig(currentProviderId);
}

// ── UI 渲染 ─────────────────────────────────────────────────

function renderProviderSelect() {
  selectProvider.innerHTML = '';
  for (const p of providerMeta) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    selectProvider.appendChild(opt);
  }
}

function renderProviderConfig(providerId) {
  providerConfigContainer.innerHTML = '';
  const meta = providerMeta.find(p => p.id === providerId);
  if (!meta || !meta.configFields || meta.configFields.length === 0) {
    if (meta) {
      const hint = document.createElement('div');
      hint.className = 'provider-name';
      hint.textContent = `${meta.name} 无需额外配置`;
      providerConfigContainer.appendChild(hint);
    }
    return;
  }

  const savedConfig = providerConfigs[providerId] || {};

  for (const field of meta.configFields) {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.className = 'form-label';
    label.htmlFor = `field-${field.key}`;
    label.textContent = field.label;
    if (field.required) {
      const req = document.createElement('span');
      req.className = 'required';
      req.textContent = '*';
      label.appendChild(req);
    }

    const input = document.createElement('input');
    input.type = field.type === 'password' ? 'password' : 'text';
    input.id = `field-${field.key}`;
    input.className = 'form-input';
    input.placeholder = field.placeholder || '';
    input.value = savedConfig[field.key] || '';
    input.dataset.fieldKey = field.key;
    input.dataset.required = field.required ? 'true' : 'false';

    group.appendChild(label);
    group.appendChild(input);
    providerConfigContainer.appendChild(group);
  }
}

// ── 事件处理 ────────────────────────────────────────────────

function handleProviderChange() {
  // 先收集当前渠道的配置，防止切换时丢失
  collectCurrentProviderConfig();
  currentProviderId = selectProvider.value;
  renderProviderConfig(currentProviderId);
}

function collectCurrentProviderConfig() {
  const fields = providerConfigContainer.querySelectorAll('.form-input[data-field-key]');
  if (fields.length === 0) return;

  const config = {};
  fields.forEach(input => {
    const val = input.value.trim();
    if (val) config[input.dataset.fieldKey] = val;
  });
  if (Object.keys(config).length > 0 || providerConfigs[currentProviderId]) {
    providerConfigs[currentProviderId] = config;
  }
}

async function handleSave() {
  // 收集当前渠道配置
  collectCurrentProviderConfig();

  // 校验必填字段
  const meta = providerMeta.find(p => p.id === currentProviderId);
  if (meta?.configFields) {
    const savedConfig = providerConfigs[currentProviderId] || {};
    for (const field of meta.configFields) {
      if (field.required && !savedConfig[field.key]) {
        const input = document.getElementById(`field-${field.key}`);
        if (input) {
          input.classList.add('error');
          input.focus();
          input.addEventListener('input', () => input.classList.remove('error'), { once: true });
        }
        showToast(`请填写 ${field.label}`, 'error');
        return;
      }
    }
  }

  const settings = {
    cpaUrl: inputCpaUrl.value.trim(),
    emailProvider: currentProviderId,
    providerConfigs,
  };

  btnSave.disabled = true;
  try {
    // 尝试通过 background 保存
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        source: 'options',
        payload: settings,
      });
      if (response?.error) throw new Error(response.error);
    } catch (_err) {
      // background 未集成时直接写 storage
      await chrome.storage.local.set(settings);
    }
    showToast('设置已保存', 'success');
  } catch (err) {
    showToast(`保存失败: ${err.message}`, 'error');
  } finally {
    btnSave.disabled = false;
  }
}

async function handleReset() {
  if (!confirm('确认恢复所有设置为默认值？')) return;

  inputCpaUrl.value = '';
  currentProviderId = 'burner_mailbox';
  providerConfigs = {};
  selectProvider.value = currentProviderId;
  renderProviderConfig(currentProviderId);

  try {
    await chrome.storage.local.remove(['cpaUrl', 'emailProvider', 'providerConfigs']);
    showToast('已恢复默认设置', 'success');
  } catch (err) {
    showToast(`恢复失败: ${err.message}`, 'error');
  }
}

// ── 主题 ────────────────────────────────────────────────────

function restoreTheme() {
  chrome.storage.local.get('theme', (data) => {
    if (data.theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  });
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    chrome.storage.local.set({ theme: 'light' });
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    chrome.storage.local.set({ theme: 'dark' });
  }
}

// ── Toast ───────────────────────────────────────────────────

function showToast(message, type = 'success', duration = 2500) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = 'toast'; }, duration);
}
