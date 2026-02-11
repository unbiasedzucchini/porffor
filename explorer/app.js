// ── Editor ──
const editor = CodeMirror.fromTextArea(document.getElementById('source-editor'), {
  mode: 'javascript',
  lineNumbers: true,
  tabSize: 2,
  indentWithTabs: false,
  matchBrackets: true,
  autoCloseBrackets: true,
});

// ── Helpers ──
function escapeHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  return (b / 1024).toFixed(1) + ' KB';
}

function formatTime(ms) {
  if (ms < 1) return '<1 ms';
  return ms.toFixed(0) + ' ms';
}

// Count AST nodes
function countNodes(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let n = 0;
  if (obj.type) n = 1; // it's an AST node
  for (const k of Object.keys(obj)) {
    if (Array.isArray(obj[k])) for (const v of obj[k]) n += countNodes(v);
    else if (typeof obj[k] === 'object' && obj[k] !== null) n += countNodes(obj[k]);
  }
  return n;
}

// Count scopes (_variables maps) added by semantic analysis
function countScopes(obj) {
  if (!obj || typeof obj !== 'object') return { scopes: 0, vars: 0 };
  let scopes = 0, vars = 0;
  if (obj._variables) {
    scopes++;
    vars += Object.keys(obj._variables).length;
  }
  for (const k of Object.keys(obj)) {
    if (k === '_variables') continue;
    if (Array.isArray(obj[k])) {
      for (const v of obj[k]) {
        const c = countScopes(v);
        scopes += c.scopes; vars += c.vars;
      }
    } else if (typeof obj[k] === 'object' && obj[k] !== null) {
      const c = countScopes(obj[k]);
      scopes += c.scopes; vars += c.vars;
    }
  }
  return { scopes, vars };
}

// Measure the "size" of a stage output for comparison
function stageSize(key, stage) {
  if (!stage) return 0;
  if (key === 'tokens') return stage.data.length;
  if (key === 'parse') return countNodes(stage.data);
  if (key === 'semantic') {
    const c = countScopes(stage.data);
    return c.vars; // primary metric: variables resolved
  }
  if (key === 'codegen') return stage.opsTotal || 0;
  if (key === 'opt') return stage.opsTotal || 0;
  if (key === 'assemble') return stage.data?.byteLength || stage.size || 0;
  return 0;
}

function sizeLabel(key, size, stage) {
  if (key === 'tokens') return size + ' tokens';
  if (key === 'parse') return size + ' nodes';
  if (key === 'semantic') {
    const c = countScopes(stage.data);
    return `${c.scopes} scopes, ${c.vars} vars`;
  }
  if (key === 'codegen') {
    const pct = stage.opsTotal > 0 ? Math.round((stage.userOps / stage.opsTotal) * 100) : 0;
    return `${size} ops (${pct}% yours)`;
  }
  if (key === 'opt') {
    if (stage.opsDelta && stage.opsDelta !== 0) {
      const sign = stage.opsDelta < 0 ? '' : '+';
      return `${size} ops (${sign}${stage.opsDelta})`;
    }
    return size + ' ops';
  }
  if (key === 'assemble') return formatBytes(size);
  return String(size);
}

const STAGE_LABELS = {
  tokens:   'Tokenize',
  parse:    'Parse',
  semantic: 'Analyze',
  codegen:  'Generate',
  opt:      'Optimize',
  assemble: 'Assemble',
};

const STAGE_DESC = {
  tokens:   'Lexical tokens',
  parse:    'Abstract syntax tree',
  semantic: 'Scopes and bindings',
  codegen:  'Wasm instructions',
  opt:      'Peephole rewrites',
  assemble: 'Binary .wasm',
};

const STAGE_ORDER = ['tokens', 'parse', 'semantic', 'codegen', 'opt', 'assemble'];

// ── State ──
let lastResult = null;
let activeStage = null;

// ── Pipeline rendering ──
function renderPipeline(result) {
  const pipeline = document.getElementById('pipeline');
  const sizes = {};
  let maxSize = 0;

  for (const key of STAGE_ORDER) {
    const s = stageSize(key, result?.stages?.[key]);
    sizes[key] = s;
    if (s > maxSize) maxSize = s;
  }

  let html = '';
  for (let i = 0; i < STAGE_ORDER.length; i++) {
    const key = STAGE_ORDER[i];
    const stage = result?.stages?.[key];
    const size = sizes[key];
    const pct = maxSize > 0 ? (size / maxSize) * 100 : 0;
    const active = activeStage === key ? ' active' : '';
    const time = stage ? formatTime(stage.time) : '—';

    if (i > 0) {
      html += `<div class="stage-arrow">↓</div>`;
    }

    html += `<div class="stage${active}" data-stage="${key}">`;
    html += `  <div class="stage-index">${i + 1}</div>`;
    html += `  <div class="stage-info">`;
    html += `    <div class="stage-name">${STAGE_LABELS[key]}</div>`;
    html += `    <div class="stage-meta">${STAGE_DESC[key]} · ${time}</div>`;
    html += `  </div>`;
    html += `  <div class="stage-bar-wrap">`;
    html += `    <div class="stage-bar"><div class="stage-bar-fill" style="width:${pct}%"></div></div>`;
    html += `    <div class="stage-size">${stage ? sizeLabel(key, size, stage) : '—'}</div>`;
    html += `  </div>`;
    html += `</div>`;
  }

  pipeline.innerHTML = html;

  // Bind clicks
  pipeline.querySelectorAll('.stage').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.stage;
      if (activeStage === key) {
        activeStage = null;
        renderPipeline(lastResult);
        hideDetail();
      } else {
        activeStage = key;
        renderPipeline(lastResult);
        showDetail(key, lastResult);
      }
    });
  });
}

// ── Detail views ──
function hideDetail() {
  document.getElementById('detail-view').classList.add('hidden');
}

function showDetail(key, result) {
  const dv = document.getElementById('detail-view');
  const stage = result?.stages?.[key];
  if (!stage) { hideDetail(); return; }

  let toolbar = '';
  let content = '';

  switch (key) {
    case 'tokens':
      content = renderTokens(stage.data, editor.getValue());
      break;
    case 'parse':
      content = `<pre>${renderAST(stage.data, 0, true)}</pre>`;
      break;
    case 'semantic':
      content = `<pre>${renderAST(stage.data, 0, true)}</pre>`;
      break;
    case 'codegen':
    case 'opt':
      toolbar = buildFuncSelect(key, stage.disassembly);
      content = `<pre id="disasm-${key}">${renderAllDisasm(stage.disassembly)}</pre>`;
      break;
    case 'assemble':
      toolbar = `<button id="download-wasm">Download .wasm</button> <span style="color:var(--text-dim);font-family:var(--font-mono);font-size:12px">${formatBytes(stage.data.byteLength)}</span>`;
      content = `<pre>${hexDump(stage.data)}</pre>`;
      break;
  }

  dv.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">${STAGE_LABELS[key]}</div>
      <button class="detail-close" id="detail-close">&times;</button>
    </div>
    ${toolbar ? `<div class="detail-toolbar">${toolbar}</div>` : ''}
    <div class="detail-content">${content}</div>
  `;
  dv.classList.remove('hidden');

  // Bind close
  document.getElementById('detail-close').addEventListener('click', () => {
    activeStage = null;
    renderPipeline(lastResult);
    hideDetail();
  });

  // Bind func select
  if (key === 'codegen' || key === 'opt') {
    const sel = document.getElementById(`func-select-${key}`);
    if (sel) {
      sel.addEventListener('change', () => {
        const pre = document.getElementById(`disasm-${key}`);
        const disasm = stage.disassembly;
        if (sel.value === '__all__') {
          pre.innerHTML = renderAllDisasm(disasm);
        } else if (disasm[sel.value]) {
          pre.innerHTML = highlightDisasm(disasm[sel.value]);
        }
      });
    }
  }

  // Bind download
  if (key === 'assemble') {
    document.getElementById('download-wasm')?.addEventListener('click', () => {
      const blob = new Blob([stage.data], { type: 'application/wasm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'output.wasm'; a.click();
      URL.revokeObjectURL(url);
    });
  }
}

function buildFuncSelect(key, disasmMap) {
  let html = `<label>Function <select id="func-select-${key}">`;
  html += `<option value="__all__">All</option>`;
  for (const name of Object.keys(disasmMap)) {
    html += `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`;
  }
  html += `</select></label>`;
  return html;
}

function renderAllDisasm(disasmMap) {
  return Object.values(disasmMap).map(d => highlightDisasm(d)).join('\n\n');
}

// ── Renderers ──
let nodeId = 0;

function renderAST(obj, depth = 0, collapse = true) {
  if (obj === null) return '<span class="ast-null">null</span>';
  if (obj === undefined) return '<span class="ast-null">undefined</span>';
  if (typeof obj === 'string') return `<span class="ast-string">"${escapeHTML(obj)}"</span>`;
  if (typeof obj === 'number') return `<span class="ast-number">${obj}</span>`;
  if (typeof obj === 'boolean') return `<span class="ast-boolean">${obj}</span>`;

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '<span class="ast-bracket">[]</span>';
    const id = 'n' + (nodeId++);
    const collapsed = collapse && depth > 1;
    let items = obj.map(v => `${'  '.repeat(depth + 1)}${renderAST(v, depth + 1, collapse)}`).join(',\n');
    const hint = obj[0]?.type ? `Array(${obj.length}) [${obj[0].type}, …]` : `Array(${obj.length})`;
    return `<span class="ast-toggle" onclick="toggleNode('${id}')">${collapsed ? '▶' : '▼'}</span><span class="ast-bracket">[</span>` +
      `<span id="${id}-h" style="display:${collapsed ? 'inline' : 'none'}"> <span class="ast-collapsed-hint">${escapeHTML(hint)}</span> </span>` +
      `<span id="${id}" style="display:${collapsed ? 'none' : 'inline'}">\n${items}\n${'  '.repeat(depth)}</span><span class="ast-bracket">]</span>`;
  }

  if (typeof obj === 'object') {
    const keys = Object.keys(obj).filter(k => !k.startsWith('_') || k === '_variables');
    if (keys.length === 0) return '<span class="ast-bracket">{}</span>';
    const id = 'n' + (nodeId++);
    const collapsed = depth > 3;
    const hint = obj.type || `{${keys.length}}`;
    let items = keys.map(k => {
      const cls = k === 'type' ? 'ast-type' : 'ast-key';
      return `${'  '.repeat(depth + 1)}<span class="${cls}">${escapeHTML(k)}</span>: ${renderAST(obj[k], depth + 1, collapse)}`;
    }).join(',\n');
    return `<span class="ast-toggle" onclick="toggleNode('${id}')">${collapsed ? '▶' : '▼'}</span><span class="ast-bracket">{</span>` +
      `<span id="${id}-h" style="display:${collapsed ? 'inline' : 'none'}"> <span class="ast-collapsed-hint">${escapeHTML(hint)}</span> </span>` +
      `<span id="${id}" style="display:${collapsed ? 'none' : 'inline'}">\n${items}\n${'  '.repeat(depth)}</span><span class="ast-bracket">}</span>`;
  }
  return escapeHTML(String(obj));
}

window.toggleNode = function(id) {
  const el = document.getElementById(id);
  const hint = document.getElementById(id + '-h');
  const toggle = hint.previousElementSibling.previousElementSibling;
  if (el.style.display === 'none') {
    el.style.display = 'inline'; hint.style.display = 'none'; toggle.textContent = '▼';
  } else {
    el.style.display = 'none'; hint.style.display = 'inline'; toggle.textContent = '▶';
  }
};

function highlightDisasm(text) {
  text = stripAnsi(text);
  return text.split('\n').map(line => {
    const ci = line.indexOf(';;');
    if (ci === 0) return `<span class="wasm-comment">${escapeHTML(line)}</span>`;
    let main = ci >= 0 ? line.slice(0, ci) : line;
    let comment = ci >= 0 ? `<span class="wasm-comment">${escapeHTML(line.slice(ci))}</span>` : '';
    if (line.match(/^\S+\(\d+\)/)) return `<span class="wasm-func-name">${escapeHTML(main)}</span>${comment}`;
    let e = escapeHTML(main);
    e = e.replace(/^(\s*)([a-z][a-z0-9_.]+)/, '$1<span class="wasm-opcode">$2</span>');
    e = e.replace(/\b(i32|i64|f32|f64)(?=\b|[.,)])/g, '<span class="wasm-type">$1</span>');
    e = e.replace(/(\s)(-?\d+\.?\d*)(\s|$|,)/g, '$1<span class="wasm-number">$2</span>$3');
    return e + comment;
  }).join('\n');
}

function renderTokens(tokens, source) {
  const colors = {
    keyword: '#8a60a0', identifier: '#5a7aaa', number: '#b07040',
    string: '#6a8a50', operator: '#3a3530', punctuation: '#908578',
  };
  let html = '<div class="token-grid">';
  html += '<div class="token-header"><span>Type</span><span>Value</span><span>Pos</span></div>';
  for (const t of tokens) {
    html += `<div class="token-row"><span class="token-type" style="color:${colors[t.type]||'#908578'}">${t.type}</span><span>${escapeHTML(t.value)}</span><span class="token-pos">${t.start}–${t.end}</span></div>`;
  }
  html += '</div>';
  return html;
}

function hexDump(buffer) {
  const bytes = new Uint8Array(buffer);
  let lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const off = `<span class="hex-offset">${i.toString(16).padStart(8, '0')}</span>`;
    let hex = [], ascii = '';
    for (let j = 0; j < 16; j++) {
      if (i + j < bytes.length) {
        hex.push(`<span class="hex-byte">${bytes[i + j].toString(16).padStart(2, '0')}</span>`);
        const c = bytes[i + j];
        ascii += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
      } else { hex.push('  '); ascii += ' '; }
    }
    lines.push(`${off}  ${hex.join(' ')}  <span class="hex-ascii">${escapeHTML(ascii)}</span>`);
  }
  return lines.join('\n');
}

// ── Compile ──
async function compile() {
  const btn = document.getElementById('compile-btn');
  const errorBar = document.getElementById('error-bar');
  btn.classList.add('compiling'); btn.textContent = 'Compiling…';
  errorBar.classList.add('hidden');
  await new Promise(r => setTimeout(r, 10));

  try {
    const result = window.porfforExplorer.compileAll(editor.getValue());
    lastResult = result;
    nodeId = 0;
    renderPipeline(result);

    if (activeStage) showDetail(activeStage, result);
    else hideDetail();

    if (result.errors) {
      errorBar.textContent = result.errors.message;
      errorBar.classList.remove('hidden');
    }
  } catch (e) {
    errorBar.textContent = e.message;
    errorBar.classList.remove('hidden');
  }

  btn.classList.remove('compiling'); btn.textContent = 'Compile';
}

// ── Events ──
document.getElementById('compile-btn').addEventListener('click', compile);
editor.setOption('extraKeys', { 'Ctrl-Enter': compile, 'Cmd-Enter': compile });

// ── Resizer ──
(function() {
  const panel = document.getElementById('source-panel');
  let resizing = false;
  panel.addEventListener('mousedown', e => {
    if (e.clientX < panel.getBoundingClientRect().right - 6) return;
    resizing = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    panel.style.width = Math.max(15, Math.min(75, (e.clientX / window.innerWidth) * 100)) + '%';
    editor.refresh();
  });
  document.addEventListener('mouseup', () => {
    if (resizing) { resizing = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; editor.refresh(); }
  });
})();

// ── Init ──
const status = document.getElementById('status');
status.textContent = 'Loading…';

renderPipeline(null); // show empty pipeline

import('./compiler-bundle.js').then(() => {
  status.textContent = 'Ready';
  status.style.color = 'var(--accent2)';
  setTimeout(compile, 100);
}).catch(e => {
  status.textContent = 'Load failed';
  status.style.color = 'var(--accent)';
  console.error(e);
});
