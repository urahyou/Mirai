window.onerror = function(msg) {
  const error = document.createElement('div');
  error.style.cssText = 'padding:20px;color:#eb5050;font-size:14px;';
  error.textContent = `JS报错: ${String(msg)}`;
  document.body.replaceChildren(error);
  return false;
};

const $ = (sel) => document.querySelector(sel);

let _config = null; // current working copy { activeProvider, providers: {...}, _active }

/* ---------- helpers ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function emptyProvider() {
  return { label: 'New', type: 'openai-compatible', baseUrl: '', apiKey: 'none', defaultModel: '', temperature: 0.8, topP: 0.9 };
}

/* ---------- render providers list ---------- */

// 只负责把内存中的 _config 渲染出来，绝不重新拉取服务器配置，
// 否则未保存的新增/改名/切换活跃都会在重渲染时被丢弃。
function renderProviders() {
  const list = $('#providersList');
  list.innerHTML = '';

  for (const [name, p] of Object.entries(_config.providers)) {
    let currentName = name;
    // ---- card wrapper ----
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.style.position = 'relative';
    card.draggable = true;
    card.dataset.name = name;

    // ---- header row ----
    const headerRow = document.createElement('div');
    headerRow.className = 'card-header';

    // name tag (read-only display)
    const nameTag = document.createElement('span');
    nameTag.className = 'card-name-tag';
    nameTag.textContent = p.label || name;

    // rename input (shown in place)
    const renameInput = document.createElement('input');
    renameInput.className = 'name-input';
    renameInput.placeholder = '新名称';
    renameInput.value = name;
    renameInput.style.display = 'none';

    let editing = false;

    nameTag.addEventListener('dblclick', () => {
      if (editing) return;
      editing = true;
      renameInput.value = currentName;
      nameTag.style.display = 'none';
      renameInput.style.display = '';
      renameInput.focus();
    });

    const finishRename = () => {
      const newN = renameInput.value.trim();
      if (newN && newN !== currentName) {
        if (_config.providers[newN]) { nameTag.textContent = currentName; editing = false; renameInput.style.display = 'none'; nameTag.style.display = ''; showToast('名称已存在', false); return; }
        _config.providers[newN] = p;
        delete _config.providers[currentName];
        if (_config.activeProvider === currentName) _config.activeProvider = newN;
        if (_config._active === currentName) _config._active = newN;
        currentName = newN;
        nameTag.textContent = newN;
        // 同步拖拽排序键，避免重命名后卡片的 dataset.name 仍指向旧名而被排错
        card.dataset.name = newN;
        keyTag.textContent = newN;
      }
      editing = false;
      renameInput.style.display = 'none';
      nameTag.style.display = '';
    };

    renameInput.addEventListener('blur', finishRename);
    renameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') renameInput.blur(); });

    const group = document.createElement('div');
    group.className = 'card-name-group';
    group.appendChild(nameTag);
    group.appendChild(renameInput);

    // key 小徽标（英文标识）
    const keyTag = document.createElement('span');
    keyTag.className = 'card-key-tag';
    keyTag.textContent = name;

    // active badge
    const badge = document.createElement('span');
    badge.className = 'card-active-badge';
    if (_config._active === currentName) { badge.textContent = '\u6D3B\u8DC3'; } else { badge.style.visibility = 'hidden'; }

    // action buttons
    const btns = document.createElement('div');
    btns.className = 'card-btns';

    const checkBtn = el('button', 'btn-icon', '\uD83D\uDD0D');
    checkBtn.title = '\u68C0\u67E5\u8FDE\u63A5';

    const swapBtn = el('button', 'btn-icon', '\u21C5');
    swapBtn.title = '\u5207\u6362\u4E3A\u6D3B\u8DC3';
    if (_config._active === currentName) swapBtn.style.display = 'none';

    const delBtn = el('button', 'btn-icon', '\u2715');
    delBtn.title = '\u5220\u9664';

    btns.appendChild(checkBtn);
    btns.appendChild(swapBtn);
    btns.appendChild(delBtn);

    headerRow.appendChild(group);
    headerRow.appendChild(keyTag);
    headerRow.appendChild(badge);
    headerRow.appendChild(btns);

    // ---- form fields ----
    const fieldFields = document.createElement('div');
    fieldFields.className = 'card-fields';

    function addField(label, placeholder, key, type) {
      var inp;
      type = type || 'text';
      const row = document.createElement('div');
      row.className = 'field-row';

      const lbl = document.createElement('span');
      lbl.className = 'field-label';
      lbl.textContent = label;
      if (label) { lbl.style.width = '36px'; lbl.style.fontSize = '11px'; }

      inp = document.createElement('input');
      inp.type = type;
      inp.placeholder = placeholder;
      inp.value = p[key] !== undefined ? p[key] : '';
      inp.dataset.key = key;

      row.appendChild(lbl);
      row.appendChild(inp);
      fieldFields.appendChild(row);
    }

    addField('\u540D\u79F0', '显示名称，如：DeepSeek 本地', 'label');
    addField('URL', 'http://127.0.0.1:8000/v1', 'baseUrl');
    addField('Key', '\uFF08\u53EF\u9009\uFF09', 'apiKey');
    addField('\u6A21\u578B', 'deepseek-v4-flash', 'defaultModel');

    // temperature row
    const tempRow = document.createElement('div');
    tempRow.className = 'field-row';
    const tempLbl = document.createElement('span');
    tempLbl.className = 'field-label';
    tempLbl.textContent = '\u6E29\u5EA6';
    tempLbl.style.width = '36px';
    tempLbl.style.fontSize = '11px';
    const tempInp = document.createElement('input');
    tempInp.type = 'number';
    tempInp.min = 0;
    tempInp.max = 2;
    tempInp.step = 0.05;
    tempInp.value = p.temperature || 0.8;
    tempInp.placeholder = 'temperature';
    tempInp.dataset.key = 'temperature';
    tempRow.appendChild(tempLbl);
    tempRow.appendChild(tempInp);

    // top-P row
    const tpRow = document.createElement('div');
    tpRow.className = 'field-row';
    const tpLbl = document.createElement('span');
    tpLbl.className = 'field-label';
    tpLbl.textContent = 'Top-p';
    tpLbl.style.width = '36px';
    tpLbl.style.fontSize = '11px';
    const tpInp = document.createElement('input');
    tpInp.type = 'number';
    tpInp.min = 0;
    tpInp.max = 1;
    tpInp.step = 0.05;
    tpInp.value = p.topP || 0.9;
    tpInp.placeholder = 'top-p';
    tpInp.dataset.key = 'topP';
    tpRow.appendChild(tpLbl);
    tpRow.appendChild(tpInp);

    fieldFields.appendChild(tempRow);
    fieldFields.appendChild(tpRow);

    card.appendChild(headerRow);
    card.appendChild(fieldFields);
    list.appendChild(card);

    // ---- 拖拽调整优先级 ----
    card.addEventListener('dragstart', (e) => {
      const allowed = ['CARD-NAME-TAG', 'CARD-KEY-TAG', 'CARD-ACTIVE-BADGE', 'CARD-BTNS', 'CARD-HEADER'].includes(e.target.className.toUpperCase()) || e.target.closest('.card-header');
      if (!allowed) { e.preventDefault(); return; }
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.provider-card').forEach((c) => c.classList.remove('drag-over'));
      // 按 DOM 新顺序重写 providers 对象键顺序，即为优先级
      const cards = Array.from(list.children);
      const newOrder = cards.map((c) => c.dataset.name).filter(Boolean);
      const reordered = {};
      for (const k of newOrder) reordered[k] = _config.providers[k];
      for (const k of Object.keys(_config.providers)) if (!(k in reordered)) reordered[k] = _config.providers[k];
      _config.providers = reordered;
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      document.querySelectorAll('.provider-card').forEach((c) => c.classList.remove('drop-over'));
      card.classList.add('drop-over');
      // 实时移动占位
      const list2 = $('#providersList');
      const draggingCard = list2.querySelector('.dragging');
      if (draggingCard && draggingCard !== card) {
        const rects = Array.from(list2.children);
        const pos = rects.indexOf(card);
        const cur = rects.indexOf(draggingCard);
        if (pos < cur) list2.insertBefore(draggingCard, card);
        else list2.insertBefore(draggingCard, card.nextSibling);
      }
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.dispatchEvent(new Event('dragend'));
    });

    // ---- card-level input handler ----
    fieldFields.addEventListener('input', () => {
      Array.from(fieldFields.querySelectorAll('input')).forEach((inp) => {
        const k = inp.dataset.key;
        if (k === 'temperature' || k === 'topP') { _config.providers[currentName][k] = parseFloat(inp.value) || 0; } else { _config.providers[currentName][k] = inp.value; }
      });
    });

    // ---- check connect ----
    checkBtn.addEventListener('click', async () => {
      card.classList.remove('check-ok', 'check-fail', 'checking');
      card.classList.add('checking');
      const ok = await window.desktopPet.checkProviderApi(_config.providers[currentName]);
      card.classList.remove('checking');
      card.classList.add(ok ? 'check-ok' : 'check-fail');
      setTimeout(() => { card.classList.remove('check-ok', 'check-fail'); }, 1800);
    });

    // ---- swap active ----
    swapBtn.addEventListener('click', () => {
      _config._active = currentName;
      renderProviders();
    });

    // ---- delete with confirmation ----
    delBtn.addEventListener('click', async () => {
      const ok = await new Promise((resolve) => {
        const box = document.createElement('div');
        box.className = 'overlay';
        const dialogue = document.createElement('div');
        dialogue.className = 'dialogue-box center';
        const label = document.createElement('label');
        label.textContent = `确定删除 \`${currentName}\`？`;
        const group = document.createElement('div');
        group.className = 'btn-group';
        const cancel = el('button', 'btn small', '取消');
        cancel.id = 'delDialogCancel';
        const confirm = el('button', 'btn primary small', '删除');
        confirm.id = 'delDialogConfirm';
        group.append(cancel, confirm);
        dialogue.append(label, group);
        box.appendChild(dialogue);
        document.body.appendChild(box);
        cancel.addEventListener('click', () => { box.remove(); resolve(false); });
        confirm.addEventListener('click', () => { box.remove(); resolve(true); });
      });
      if (ok) {
        delete _config.providers[currentName];
        if (_config._active === currentName) _config._active = Object.keys(_config.providers)[0] || '';
        renderProviders();
      }
    });
  }
}

/* ---------- bottom buttons ---------- */

$('#cancelBtn').addEventListener('click', () => window.desktopPet.closeProviderPanel());

$('#saveBtn').addEventListener('click', async () => {
  _config.activeProvider = _config._active || Object.keys(_config.providers)[0] || '';
  const ok = await window.desktopPet.saveProviderConfig(_config);
  if (ok) {
    showToast('已保存并应用', true);
    setTimeout(() => window.desktopPet.closeProviderPanel(), 450);
  } else {
    showToast('保存失败', false);
  }
});

$('#addProviderBtn').addEventListener('click', () => {
  const box = document.createElement('div');
  box.className = 'overlay';
  box.id = 'addProviderOverlay';
  box.innerHTML = `
    <div class="dialogue-box center">
      <label>名称（英文小写，不含空格）：</label>
      <input type="text" id="newProviderName" placeholder="例如 openai" />
      <div class="btn-group">
        <button class="btn small" id="addDialogCancel">取消</button>
        <button class="btn primary small" id="addDialogConfirm">添加</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  const nameInput = box.querySelector('#newProviderName');
  nameInput.focus();
  const close = () => box.remove();

  const submit = () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const k = name.toLowerCase();
    if (_config.providers[k]) { showToast('名称已存在', false); return; }
    _config.providers[k] = emptyProvider();
    close();
    renderProviders();
  };

  box.querySelector('#addDialogCancel').addEventListener('click', close);
  box.querySelector('#addDialogConfirm').addEventListener('click', submit);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
});

/* ---------- toast -------- */

function showToast(msg, ok) {
  const box = $('#llmTooltip');
  box.textContent = msg + (ok ? ' \u2705' : ' \u274C');
  box.style.background = ok ? '#42e08d' : '#eb5050';
  box.classList.add('show');
  setTimeout(() => { box.classList.remove('show'); }, 1600);
}

/* ---------- init ---------- */

async function init() {
  _config = await window.desktopPet.getProviderConfig();
  renderProviders();
}

init();
