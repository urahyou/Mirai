const list = document.querySelector('#provider-list');
const editor = document.querySelector('#editor');
const status = document.querySelector('#status');

let config = null;
let selectedName = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function makeButton(label, className, title) {
  const button = element('button', className, label);
  button.type = 'button';
  button.title = title || label;
  return button;
}

function makeField(labelText, field, value, options = {}) {
  const label = element('label', `field${options.wide ? ' wide' : ''}`, labelText);
  const input = document.createElement('input');
  input.dataset.field = field;
  input.value = value ?? '';
  Object.assign(input, options.input || {});
  label.appendChild(input);
  return { label, input };
}

function currentProvider() {
  return selectedName ? config.providers[selectedName] : null;
}

function commitEditor() {
  const provider = currentProvider();
  if (!provider || !editor.querySelector('.editor-name')) return;
  const nextName = editor.querySelector('.editor-name').value.trim();
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(nextName)) throw new Error('Provider 标识仅支持字母、数字、短横线和下划线');
  if (nextName !== selectedName && config.providers[nextName]) throw new Error('Provider 标识已存在');

  const nextProvider = { ...provider, type: 'openai-compatible' };
  for (const input of editor.querySelectorAll('[data-field]')) {
    nextProvider[input.dataset.field] = ['temperature', 'topP'].includes(input.dataset.field)
      ? Number(input.value)
      : input.value.trim();
  }

  const nextProviders = {};
  for (const [name, value] of Object.entries(config.providers)) {
    nextProviders[name === selectedName ? nextName : name] = name === selectedName ? nextProvider : value;
  }
  config.providers = nextProviders;
  if (config.activeProvider === selectedName) config.activeProvider = nextName;
  selectedName = nextName;
}

function renderList() {
  list.replaceChildren();
  for (const [name, provider] of Object.entries(config.providers)) {
    const item = makeButton('', `provider-item${name === selectedName ? ' selected' : ''}`);
    item.classList.toggle('active', name === config.activeProvider);
    const dot = element('span', 'provider-dot');
    const copy = element('span');
    copy.append(
      element('span', 'provider-title', provider.label || name),
      element('span', 'provider-meta', provider.defaultModel || '未配置模型'),
    );
    item.append(dot, copy);
    item.addEventListener('click', () => {
      try {
        commitEditor();
        selectedName = name;
        render();
      } catch (error) { showStatus(error.message, true); }
    });
    list.appendChild(item);
  }
}

function renderEditor() {
  editor.replaceChildren();
  const provider = currentProvider();
  if (!provider) return;

  const head = element('div', 'editor-head');
  const identity = element('div');
  const name = document.createElement('input');
  name.className = 'editor-name';
  name.value = selectedName;
  name.maxLength = 40;
  name.setAttribute('aria-label', 'Provider 标识');
  identity.append(name, element('p', 'editor-key', `标识：${selectedName}`));

  const actions = element('div', 'actions');
  const activate = makeButton(config.activeProvider === selectedName ? '当前聊天模型' : '设为当前', `action${config.activeProvider === selectedName ? ' current' : ''}`);
  activate.disabled = config.activeProvider === selectedName;
  const test = makeButton('↻', 'action', '测试连接');
  const remove = makeButton('×', 'action delete', '删除 Provider');
  actions.append(activate, test, remove);
  head.append(identity, actions);

  const form = element('div', 'form-grid');
  const displayName = makeField('显示名称', 'label', provider.label);
  const model = makeField('模型', 'defaultModel', provider.defaultModel);
  const endpoint = makeField('接口地址', 'baseUrl', provider.baseUrl, { wide: true, input: { placeholder: 'http://127.0.0.1:8000/v1' } });
  const apiKey = makeField('API Key', 'apiKey', provider.apiKey || 'none', { wide: true, input: { type: 'password', autocomplete: 'off' } });
  const keyRow = element('div', 'field-row');
  keyRow.append(apiKey.input);
  const reveal = makeButton('显示', 'reveal', '显示或隐藏 API Key');
  keyRow.append(reveal);
  apiKey.label.append(keyRow);
  const sectionLabel = element('div', 'section-label', '生成参数');
  const temperature = makeField('Temperature', 'temperature', provider.temperature ?? 0.8, { input: { type: 'number', min: '0', max: '2', step: '0.05' } });
  const topP = makeField('Top P', 'topP', provider.topP ?? 0.9, { input: { type: 'number', min: '0', max: '1', step: '0.05' } });
  form.append(displayName.label, model.label, endpoint.label, apiKey.label, sectionLabel, temperature.label, topP.label);
  editor.append(head, form);

  reveal.addEventListener('click', () => {
    const hidden = apiKey.input.type === 'password';
    apiKey.input.type = hidden ? 'text' : 'password';
    reveal.textContent = hidden ? '隐藏' : '显示';
  });
  activate.addEventListener('click', () => {
    try {
      commitEditor();
      config.activeProvider = selectedName;
      render();
      showStatus('已设为当前聊天模型');
    } catch (error) { showStatus(error.message, true); }
  });
  test.addEventListener('click', async () => {
    try {
      commitEditor();
      showStatus('正在测试连接...');
      const ok = await window.desktopPet.providers.check(config.providers[selectedName]);
      showStatus(ok ? '连接正常' : '连接失败', !ok);
    } catch (error) { showStatus(error.message, true); }
  });
  remove.addEventListener('click', () => {
    if (Object.keys(config.providers).length === 1) return showStatus('至少保留一个 Provider', true);
    if (!window.confirm(`删除 ${selectedName}？未保存的修改也会丢失。`)) return;
    delete config.providers[selectedName];
    if (!config.providers[config.activeProvider]) config.activeProvider = Object.keys(config.providers)[0];
    selectedName = Object.keys(config.providers)[0];
    render();
  });
}

function render() {
  renderList();
  renderEditor();
}

document.querySelector('#add').addEventListener('click', () => {
  try {
    commitEditor();
    let index = 1;
    let name = `provider-${index}`;
    while (config.providers[name]) name = `provider-${++index}`;
    config.providers[name] = {
      label: '新模型',
      type: 'openai-compatible',
      baseUrl: '',
      apiKey: 'none',
      defaultModel: '',
      temperature: 0.8,
      topP: 0.9,
    };
    selectedName = name;
    render();
    editor.querySelector('.editor-name').focus();
  } catch (error) { showStatus(error.message, true); }
});

document.querySelector('#close').addEventListener('click', () => window.desktopPet.closeProviderPanel());
document.querySelector('#save').addEventListener('click', async () => {
  try {
    commitEditor();
    const result = await window.desktopPet.providers.save(config);
    if (!result.ok) return showStatus(result.error || '保存失败', true);
    config = result.config;
    selectedName = config.providers[selectedName] ? selectedName : config.activeProvider;
    render();
    showStatus('已保存');
  } catch (error) { showStatus(error.message, true); }
});

(async () => {
  try {
    config = await window.desktopPet.providers.get();
    selectedName = config.activeProvider || Object.keys(config.providers)[0] || null;
    render();
  } catch {
    showStatus('读取 Provider 配置失败', true);
  }
})();
