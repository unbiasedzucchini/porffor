// Browser bridge that exposes each Porffor compilation stage
// We need to set up globals before importing the compiler modules

// Shim process.argv for prefs.js
if (typeof process === 'undefined') {
  globalThis.process = { argv: [], version: undefined, stdout: { isTTY: false } };
}

import '../compiler/prefs.js';
import { Valtype, PageSize } from '../compiler/wasmSpec.js';

// Set required globals
globalThis.valtype = 'f64';
globalThis.valtypeBinary = Valtype.f64;
globalThis.pageSize = PageSize / 4;

import parse from '../compiler/parse.js';
import semantic from '../compiler/semantic.js';
import codegen from '../compiler/codegen.js';
import opt from '../compiler/opt.js';
import assemble from '../compiler/assemble.js';
import disassemble from '../compiler/disassemble.js';
import { setImports, createImport } from '../compiler/builtins.js';

// Create required runtime imports (same as wrap.js)
function setupImports() {
  setImports();
  createImport('print', 1, 0, i => console.log(i));
  createImport('printChar', 1, 0, i => console.log(String.fromCharCode(i)));
  createImport('time', 0, 1, () => performance.now());
  createImport('timeOrigin', 0, 1, () => performance.timeOrigin);
}
setupImports();

export { parse, semantic, codegen, opt, assemble, disassemble };

// Tokenize using acorn (which is dynamically loaded by parse.js)
function tokenize(source) {
  // acorn is loaded via dynamic import in parse.js; we can access it
  // by using the same import mechanism
  try {
    // The parse function from acorn is stored globally by parse.js's loadParser
    // We'll just call acorn.tokenizer which is available from the same module
    const tokens = [];
    // Simple regex-based tokenizer as fallback for visualization
    const patterns = [
      ['whitespace', /^\s+/],
      ['comment', /^\/\/[^\n]*/],
      ['comment', /^\/\*[\s\S]*?\*\//],
      ['string', /^"(?:[^"\\]|\\.)*"/],
      ['string', /^'(?:[^'\\]|\\.)*'/],
      ['string', /^`(?:[^`\\]|\\.)*`/],
      ['number', /^(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/],
      ['keyword', /^(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|from|default|typeof|instanceof|void|delete|in|of|try|catch|finally|throw|async|await|yield|static|get|set|true|false|null|undefined)\b/],
      ['punctuation', /^(?:=>|\.\.\.|[\[\]{}().,;:?])/],
      ['operator', /^(?:===|!==|==|!=|<=|>=|&&|\|\||\?\?|\*\*|\+\+|--|<<|>>>?|[+\-*/%&|^~<>!=]=?)/],
      ['identifier', /^[a-zA-Z_$][a-zA-Z0-9_$]*/],
    ];
    let pos = 0;
    while (pos < source.length) {
      let matched = false;
      for (const [type, regex] of patterns) {
        const match = regex.exec(source.slice(pos));
        if (match) {
          if (type !== 'whitespace') {
            tokens.push({ type, value: match[0], start: pos, end: pos + match[0].length });
          }
          pos += match[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        tokens.push({ type: 'unknown', value: source[pos], start: pos, end: pos + 1 });
        pos++;
      }
    }
    return tokens;
  } catch (e) {
    return [{ type: 'error', value: e.message, start: 0, end: 0 }];
  }
}

export function compileAll(source) {
  const result = { stages: {}, errors: null };

  try {
    // Stage 0: Tokenize
    const tTok = performance.now();
    const tokens = tokenize(source);
    result.stages.tokens = {
      name: 'Tokens',
      data: tokens,
      time: performance.now() - tTok
    };

    // Stage 1: Parse
    const t0 = performance.now();
    const ast = parse(source);
    result.stages.parse = {
      name: 'AST (ESTree)',
      data: ast,
      time: performance.now() - t0
    };

    // Stage 2: Semantic Analysis
    const t1 = performance.now();
    // Clone AST so semantic mutation doesn't affect the parse output display
    const semanticAst = JSON.parse(JSON.stringify(ast));
    semantic(semanticAst);
    result.stages.semantic = {
      name: 'Semantic Analysis',
      data: semanticAst,
      time: performance.now() - t1
    };

    // Stage 3: Codegen (re-parse fresh since codegen also mutates)
    const t2 = performance.now();
    const freshAst = parse(source);
    // Reset codegen state
    globalThis._uniqId = 0;
    setupImports(); // Reset imported functions with required runtime imports
    globalThis.valtype = 'f64';
    globalThis.valtypeBinary = Valtype.f64;
    globalThis.pageSize = PageSize / 4;
    const ir = codegen(freshAst);
    result.stages.codegen = {
      name: 'Wasm IR',
      data: ir,
      time: performance.now() - t2
    };

    // Build disassembly for each function (pre-opt)
    const preOptDisasm = {};
    for (const f of ir.funcs) {
      try {
        preOptDisasm[f.name] = disassemble(
          f.wasm, f.name, f.index, f.locals, f.params, f.returns,
          ir.funcs, ir.globals, ir.exceptions
        );
      } catch (e) {
        preOptDisasm[f.name] = `;; disassembly error: ${e.message}`;
      }
    }
    result.stages.codegen.disassembly = preOptDisasm;

    // Stage 4: Optimization
    const t3 = performance.now();
    opt(ir.funcs, ir.globals, ir.pages, ir.tags, ir.exceptions);
    result.stages.opt = {
      name: 'Optimized Wasm IR',
      data: ir,
      time: performance.now() - t3
    };

    // Build disassembly for each function (post-opt)
    const postOptDisasm = {};
    for (const f of ir.funcs) {
      try {
        postOptDisasm[f.name] = disassemble(
          f.wasm, f.name, f.index, f.locals, f.params, f.returns,
          ir.funcs, ir.globals, ir.exceptions
        );
      } catch (e) {
        postOptDisasm[f.name] = `;; disassembly error: ${e.message}`;
      }
    }
    result.stages.opt.disassembly = postOptDisasm;

    // Stage 5: Assembly
    const t4 = performance.now();
    const wasm = assemble(ir.funcs, ir.globals, ir.tags, ir.pages, ir.data);
    result.stages.assemble = {
      name: 'WebAssembly Binary',
      data: wasm,
      size: wasm.byteLength,
      time: performance.now() - t4
    };

  } catch (e) {
    result.errors = { message: e.message, stack: e.stack };
  }

  return result;
}

globalThis.porfforExplorer = { compileAll, parse, semantic, codegen, opt, assemble, disassemble };
