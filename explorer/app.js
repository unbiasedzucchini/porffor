// ── CodeMirror Editor Setup ──
const editor = CodeMirror.fromTextArea(document.getElementById('source-editor'), {
  mode: 'javascript',
  theme: 'monokai',
  lineNumbers: true,
  tabSize: 2,
  indentWithTabs: false,
  matchBrackets: true,
  autoCloseBrackets: true,
});

// ── Tab Switching ──
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.tab-panel');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── AST Renderer ──
function renderAST(obj, depth = 0, collapseArrays = true) {
  if (obj === null) return '<span class="ast-null">null</span>';
  if (obj === undefined) return '<span class="ast-null">undefined</span>';
  if (typeof obj === 'string') return `<span class="ast-string">"${escapeHTML(obj)}"</span>`;
  if (typeof obj === 'number') return `<span class="ast-number">${obj}</span>`;
  if (typeof obj === 'boolean') return `<span class="ast-boolean">${obj}</span>`;

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '<span class="ast-bracket">[]</span>';
    const id = 'n' + (nodeId++);
    const collapsed = collapseArrays && depth > 1;
    let items = obj.map((v, i) => {
      const indent = '  '.repeat(depth + 1);
      return `${indent}${renderAST(v, depth + 1, collapseArrays)}`;
    }).join(',\n');
    const hint = obj[0]?.type ? `Array(${obj.length}) [${obj[0].type}, ...]` : `Array(${obj.length})`;
    return `<span class="ast-toggle" onclick="toggleNode('${id}')">${collapsed ? '▶' : '▼'}</span><span class="ast-bracket">[</span>` +
      `<span id="${id}-collapsed" class="ast-collapsed-hint" style="display:${collapsed ? 'inline' : 'none'}"> ${escapeHTML(hint)} </span>` +
      `<span id="${id}" style="display:${collapsed ? 'none' : 'inline'}">\n${items}\n${'  '.repeat(depth)}</span>` +
      `<span class="ast-bracket">]</span>`;
  }

  if (typeof obj === 'object') {
    const keys = Object.keys(obj).filter(k => !k.startsWith('_') || k === '_variables');
    if (keys.length === 0) return '<span class="ast-bracket">{}</span>';
    const id = 'n' + (nodeId++);
    const typeVal = obj.type;
    let items = keys.map(k => {
      const indent = '  '.repeat(depth + 1);
      const keyClass = k === 'type' ? 'ast-type' : 'ast-key';
      return `${indent}<span class="${keyClass}">${escapeHTML(k)}</span>: ${renderAST(obj[k], depth + 1, collapseArrays)}`;
    }).join(',\n');
    const hint = typeVal ? typeVal : `{${keys.length} keys}`;
    const collapsed = depth > 3;
    return `<span class="ast-toggle" onclick="toggleNode('${id}')">${collapsed ? '▶' : '▼'}</span><span class="ast-bracket">{</span>` +
      `<span id="${id}-collapsed" class="ast-collapsed-hint" style="display:${collapsed ? 'inline' : 'none'}"> ${escapeHTML(hint)} </span>` +
      `<span id="${id}" style="display:${collapsed ? 'none' : 'inline'}">\n${items}\n${'  '.repeat(depth)}</span>` +
      `<span class="ast-bracket">}</span>`;
  }

  return escapeHTML(String(obj));
}

let nodeId = 0;

window.toggleNode = function(id) {
  const el = document.getElementById(id);
  const hint = document.getElementById(id + '-collapsed');
  const toggle = el.previousElementSibling.previousElementSibling;
  if (el.style.display === 'none') {
    el.style.display = 'inline';
    hint.style.display = 'none';
    toggle.textContent = '▼';
  } else {
    el.style.display = 'none';
    hint.style.display = 'inline';
    toggle.textContent = '▶';
  }
};

function escapeHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Strip ANSI escape codes ──
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Disassembly Highlighter ──
function highlightDisasm(text) {
  text = stripAnsi(text);
  return text.split('\n').map(line => {
    // Comments
    const commentIdx = line.indexOf(';;');
    let mainPart = line;
    let commentPart = '';
    if (commentIdx >= 0) {
      mainPart = line.slice(0, commentIdx);
      commentPart = `<span class="wasm-comment">${escapeHTML(line.slice(commentIdx))}</span>`;
    }
    // Pure comment lines
    if (commentIdx === 0) return `<span class="wasm-comment">${escapeHTML(line)}</span>`;
    // Function signature line
    if (line.match(/^\S+\(\d+\)/)) {
      return `<span class="wasm-func-name">${escapeHTML(mainPart)}</span>${commentPart}`;
    }
    // Highlight the main part (no HTML entities yet — we'll be careful)
    // First escape for HTML safety
    let escaped = escapeHTML(mainPart);
    // Highlight opcodes (first non-whitespace word on the line)
    escaped = escaped.replace(/^(\s*)([a-z][a-z0-9_.]+)/, '$1<span class="wasm-opcode">$2</span>');
    // Highlight type keywords 
    escaped = escaped.replace(/\b(i32|i64|f32|f64)(?=\b|[.,)])/g, '<span class="wasm-type">$1</span>');
    // Highlight numeric literals (but not inside HTML tags)
    escaped = escaped.replace(/(\s)(-?\d+\.?\d*)(\s|$|,)/g, '$1<span class="wasm-number">$2</span>$3');
    return escaped + commentPart;
  }).join('\n');
}

// ── Token Renderer ──
function renderTokens(tokens, source) {
  const colorMap = {
    keyword: '#c792ea',
    identifier: '#82aaff',
    number: '#f78c6c',
    string: '#c3e88d',
    operator: '#89ddff',
    punctuation: '#89ddff',
    comment: '#546e7a',
    unknown: '#ff5370',
  };

  // Table view
  let html = '<div class="token-grid">';
  html += '<div class="token-header"><span>Type</span><span>Value</span><span>Pos</span></div>';
  for (const tok of tokens) {
    const color = colorMap[tok.type] || '#e0e0e0';
    const val = escapeHTML(tok.value);
    html += `<div class="token-row">`;
    html += `<span class="token-type" style="color:${color}">${tok.type}</span>`;
    html += `<span class="token-value">${val}</span>`;
    html += `<span class="token-pos">${tok.start}-${tok.end}</span>`;
    html += `</div>`;
  }
  html += '</div>';

  // Visual source view with colored tokens
  html += '<div class="token-source">';
  let pos = 0;
  for (const tok of tokens) {
    if (tok.start > pos) {
      html += escapeHTML(source.slice(pos, tok.start));
    }
    const color = colorMap[tok.type] || '#e0e0e0';
    html += `<span style="color:${color};" title="${tok.type}">${escapeHTML(tok.value)}</span>`;
    pos = tok.end;
  }
  if (pos < source.length) {
    html += escapeHTML(source.slice(pos));
  }
  html += '</div>';

  return html;
}

// ── Hex Dump ──
function hexDump(buffer) {
  const bytes = new Uint8Array(buffer);
  let lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const offset = `<span class="hex-offset">${i.toString(16).padStart(8, '0')}</span>`;
    const hexParts = [];
    let ascii = '';
    for (let j = 0; j < 16; j++) {
      if (i + j < bytes.length) {
        hexParts.push(`<span class="hex-byte">${bytes[i + j].toString(16).padStart(2, '0')}</span>`);
        const c = bytes[i + j];
        ascii += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
      } else {
        hexParts.push('  ');
        ascii += ' ';
      }
    }
    const hex = hexParts.join(' ');
    lines.push(`${offset}  ${hex}  <span class="hex-ascii">${escapeHTML(ascii)}</span>`);
  }
  return lines.join('\n');
}

// ── State ──
let lastResult = null;
let wasmBinary = null;

// ── Compile ──
async function compile() {
  const btn = document.getElementById('compile-btn');
  const errorBar = document.getElementById('error-bar');
  const timingBar = document.getElementById('timing-bar');

  btn.classList.add('compiling');
  btn.textContent = '⏳ Compiling...';
  errorBar.classList.add('hidden');
  timingBar.classList.add('hidden');

  // Yield to let UI update
  await new Promise(r => setTimeout(r, 10));

  const source = editor.getValue();

  try {
    const result = window.porfforExplorer.compileAll(source);
    lastResult = result;

    if (result.errors) {
      errorBar.textContent = result.errors.message + '\n' + result.errors.stack;
      errorBar.classList.remove('hidden');
    }

    // Render whatever stages succeeded
    nodeId = 0;
    const collapseArrays = document.getElementById('ast-collapse').checked;

    if (result.stages.tokens) {
      document.getElementById('output-tokens').innerHTML = renderTokens(result.stages.tokens.data, source);
    }

    if (result.stages.parse) {
      document.getElementById('output-ast').innerHTML = renderAST(result.stages.parse.data, 0, collapseArrays);
    }

    if (result.stages.semantic) {
      nodeId = 100000;
      document.getElementById('output-semantic').innerHTML = renderAST(result.stages.semantic.data, 0, collapseArrays);
    }

    if (result.stages.codegen) {
      populateFuncSelect('ir-func-select', result.stages.codegen.disassembly);
      showDisasm('output-ir', 'ir-func-select', result.stages.codegen.disassembly);
    }

    if (result.stages.opt) {
      populateFuncSelect('opt-func-select', result.stages.opt.disassembly);
      showOptDisasm();
    }

    if (result.stages.assemble) {
      wasmBinary = result.stages.assemble.data;
      document.getElementById('wasm-size').textContent = `${wasmBinary.byteLength.toLocaleString()} bytes`;
      document.getElementById('download-wasm').disabled = false;

      const header = `<span class="hex-header">;; WebAssembly binary (${wasmBinary.byteLength} bytes)</span>\n\n`;
      document.getElementById('output-wasm').innerHTML = header + hexDump(wasmBinary);
    }

    // Timing bar
    if (!result.errors || Object.keys(result.stages).length > 0) {
      let timingHTML = '';
      for (const [key, stage] of Object.entries(result.stages)) {
        timingHTML += `<div class="timing-item"><span class="timing-label">${stage.name}:</span><span class="timing-value">${stage.time.toFixed(1)}ms</span></div>`;
      }
      timingBar.innerHTML = timingHTML;
      timingBar.classList.remove('hidden');
    }

  } catch (e) {
    errorBar.textContent = e.message + '\n' + e.stack;
    errorBar.classList.remove('hidden');
  }

  btn.classList.remove('compiling');
  btn.textContent = '▶ Compile';
}

function populateFuncSelect(selectId, disasmMap) {
  const select = document.getElementById(selectId);
  const prev = select.value;
  select.innerHTML = '';
  const allOption = document.createElement('option');
  allOption.value = '__all__';
  allOption.textContent = 'All Functions';
  select.appendChild(allOption);

  for (const name of Object.keys(disasmMap)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  // Restore previous selection if it still exists
  if (prev && disasmMap[prev]) select.value = prev;
  else select.value = '__all__';
}

function showDisasm(outputId, selectId, disasmMap) {
  const select = document.getElementById(selectId);
  const output = document.getElementById(outputId);
  const selected = select.value;

  if (selected === '__all__') {
    output.innerHTML = Object.values(disasmMap).map(d => highlightDisasm(d)).join('\n\n');
  } else if (disasmMap[selected]) {
    output.innerHTML = highlightDisasm(disasmMap[selected]);
  }
}

// ── Event Listeners ──
document.getElementById('compile-btn').addEventListener('click', compile);

editor.setOption('extraKeys', {
  'Ctrl-Enter': compile,
  'Cmd-Enter': compile,
});

document.getElementById('ir-func-select').addEventListener('change', () => {
  if (lastResult?.stages?.codegen) {
    showDisasm('output-ir', 'ir-func-select', lastResult.stages.codegen.disassembly);
  }
});

document.getElementById('opt-func-select').addEventListener('change', () => {
  if (lastResult?.stages?.opt) {
    showOptDisasm();
  }
});

function showOptDisasm() {
  if (!lastResult?.stages?.opt || !lastResult?.stages?.codegen) return;
  const select = document.getElementById('opt-func-select');
  const output = document.getElementById('output-opt');
  const selected = select.value;
  const preDisasm = lastResult.stages.codegen.disassembly;
  const postDisasm = lastResult.stages.opt.disassembly;

  if (selected === '__all__') {
    let html = '';
    for (const name of Object.keys(postDisasm)) {
      const pre = stripAnsi(preDisasm[name] || '');
      const post = stripAnsi(postDisasm[name] || '');
      const preLines = pre.split('\n').length;
      const postLines = post.split('\n').length;
      const diff = preLines - postLines;
      const tag = diff > 0 ? `<span style="color:#00e676"> (-${diff} lines)</span>` :
                  diff < 0 ? `<span style="color:#ff5252"> (+${-diff} lines)</span>` : '';
      html += highlightDisasm(post) + tag + '\n\n';
    }
    output.innerHTML = html;
  } else if (postDisasm[selected]) {
    output.innerHTML = highlightDisasm(postDisasm[selected]);
  }
}

document.getElementById('download-wasm').addEventListener('click', () => {
  if (!wasmBinary) return;
  const blob = new Blob([wasmBinary], { type: 'application/wasm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'output.wasm';
  a.click();
  URL.revokeObjectURL(url);
});

// ── Resizable divider ──
(function setupResizer() {
  const sourcePanel = document.getElementById('source-panel');
  let isResizing = false;

  sourcePanel.addEventListener('mousedown', (e) => {
    // Only trigger if clicking near the right edge (the resize handle area)
    const rect = sourcePanel.getBoundingClientRect();
    if (e.clientX < rect.right - 6) return;
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const pct = (e.clientX / window.innerWidth) * 100;
    sourcePanel.style.width = Math.max(15, Math.min(75, pct)) + '%';
    editor.refresh();
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      editor.refresh();
    }
  });
})();

// ── Load Compiler ──
const status = document.getElementById('status');
status.textContent = 'Loading compiler...';

import('./compiler-bundle.js').then(() => {
  status.textContent = 'Ready';
  status.style.color = '#00e676';
  // Auto-compile on load
  setTimeout(compile, 100);
}).catch(e => {
  status.textContent = 'Failed to load compiler';
  status.style.color = '#ff5252';
  console.error('Failed to load compiler:', e);
});
