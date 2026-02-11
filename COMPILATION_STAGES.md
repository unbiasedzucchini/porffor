# Porffor Compilation Stages

## Overview

Porffor is an AOT JavaScript-to-WebAssembly compiler. The main pipeline is:

```
JS source → Parse (AST) → Semantic Analysis → Codegen (Wasm IR) → Optimize → Assemble (Wasm binary)
```

Optional additional targets: C source code (`2c.js`) or native binary.

## Entry Points

- **`package.json` main**: `compiler/wrap.js` — the public API, compiles + instantiates + runs Wasm
- **`compiler/index.js`**: the core compile pipeline (parse → codegen → opt → assemble), returns `{ wasm, funcs, globals, tags, exceptions, pages, data }`
- **`runtime/index.js`**: CLI entry point (`porf` command)

## Stage 1: Parsing (AST)

**Module**: `compiler/parse.js`  
**Function**: `export default (input: string) => AST`  
**Input**: JavaScript/TypeScript source string  
**Output**: ESTree-compatible AST (a `Program` node with `.body` array)

Delegates to an external parser (configurable via `--parser=` flag):
- **acorn** (default for JS)
- **@babel/parser** (default for TypeScript, via `--parse-types` or `.ts` files)
- **meriyah**, **hermes-parser**, **oxc-parser** (optional alternatives)

The parser options normalize across all parsers. The returned AST is standard ESTree.

**Standalone usage**:
```js
import parse from './compiler/parse.js';
const ast = parse('const x = 1 + 2;');
// ast is { type: 'Program', sourceType: 'script', body: [...] }
```

## Stage 2: Semantic Analysis

**Module**: `compiler/semantic.js`  
**Function**: `export default (node, scopes?) => AST` (mutates + returns the same AST)  
**Input**: ESTree AST  
**Output**: Annotated ESTree AST (same object, mutated in-place)

Performs two passes over the AST:
1. **`analyze()`**: Walks the tree to discover variable declarations, building `_variables` maps on scope nodes (functions, blocks, catch clauses). Tracks `var` vs `let`/`const` scoping.
2. **`annotate()`**: Renames variables with duplicate names across scopes by appending `#id` suffixes (e.g., `x` → `x#1`) to disambiguate. Also attaches `_semanticScopes` to `eval()` and `new Function()` calls.

This is only run when `Prefs.closures` is enabled (on by default).

**Standalone usage**:
```js
import parse from './compiler/parse.js';
import semantic from './compiler/semantic.js';
const ast = parse('function f() { let x = 1; } function g() { let x = 2; }');
semantic(ast); // mutates ast in-place, renames shadowed vars
```

## Stage 3: Code Generation (Wasm IR)

**Module**: `compiler/codegen.js`  
**Function**: `export default (program: AST) => { funcs, globals, tags, exceptions, pages, data }`  
**Additional export**: `export const allocStr`  
**Input**: ESTree AST (Program node)  
**Output**: An object containing:

- **`funcs`**: `Array<Func>` — array of function objects, each containing:
  - `name: string` — function name (e.g., `'#main'`, `'__Array_prototype_push'`)
  - `index: number` — function index in the Wasm module
  - `wasm: Array<Instruction>` — **the Wasm IR**: an array of instruction arrays like `[opcode, ...operands]`
    - Each instruction is an array: `[Opcodes.i32_const, 42]`, `[Opcodes.call, funcIndex]`, `[Opcodes.local_get, localIdx]`, etc.
    - Operands are raw JS numbers at this stage (not yet LEB128-encoded)
    - Special: `[null, callbackFn]` entries are lazy — resolved after all funcs are generated
  - `locals: Object` — maps local name → `{ idx, type }` 
  - `params: Array<Valtype>` — parameter types
  - `returns: Array<Valtype>` — return types (always `[f64, i32]` = value + type tag)
  - `internal: boolean` — whether it's a built-in
  - `generate: Function` — lazy generation thunk (codegen is lazy per-function)
- **`globals`**: `Object` — maps global name → `{ idx, type, init }` 
- **`tags`**: `Array` — Wasm exception tags
- **`exceptions`**: `Array` — exception metadata for error handling
- **`pages`**: `Map<string, number>` — memory page allocations (name → page index)
- **`data`**: `Array` — passive data segments

Codegen wraps the program body in a synthetic `#main` function. It uses `generateFunc()` internally (lazy — functions are only codegen'd when called/referenced). Built-in functions come from `compiler/builtins.js` and `compiler/builtins/` (precompiled .ts/.js implementations).

**Key sub-modules used by codegen**:
- `compiler/expression.js` — maps JS operators to Wasm opcodes
- `compiler/builtins.js` — built-in function/variable definitions, import management
- `compiler/builtins_precompiled.js` — precompiled Wasm for built-in prototypes
- `compiler/types.js` — type constants and registration (TYPES.number, TYPES.string, etc.)
- `compiler/encoding.js` — number encoding helpers (LEB128, IEEE754)

**Standalone usage**:
```js
import parse from './compiler/parse.js';
import codegen from './compiler/codegen.js';
// Note: codegen relies on globals set by index.js (valtype, valtypeBinary, pageSize, Prefs, etc.)
const ast = parse('let x = 1 + 2;');
const { funcs, globals, tags, exceptions, pages, data } = codegen(ast);
// funcs[0].wasm is the Wasm IR for #main
```

## Stage 4: Optimization

**Module**: `compiler/opt.js`  
**Function**: `export default (funcs, globals, pages, tags, exceptions) => void`  
**Input**: The funcs/globals/etc from codegen (mutated in-place)  
**Output**: None (mutates `func.wasm` arrays in-place)

Peephole optimizations on the Wasm IR, run in 2 passes (configurable via `--opt-wasm-runs=N`):
- `set + get` → `tee`
- `get + drop` → nothing  
- `tee + drop` → `set`
- `const + drop` → nothing
- `const 0 + eq` → `eqz`
- Redundant type conversions (`i32→i64→i32`, `i32→f64→i32`, `f64→i32→f64`) → nothing
- `const + i32_trunc` → `i32.const` (constant folding)
- Removal of unused blocks (no branches inside)
- Removal of unused `#last_type` local sets
- `call + return` → `return_call` (tail calls, when `--tail-call` enabled)

## Stage 4b: PGO (Profile-Guided Optimization) [Optional]

**Module**: `compiler/pgo.js`  
**Function**: `export { setup, run }`  
**Enabled by**: `--pgo` flag

Compiles + runs the Wasm, profiles local variable types at runtime, then uses `havoc.js` to rewrite functions (e.g., converting locals that are always constant into `const` instructions). Re-runs `opt` afterward.

## Stage 4c: Cyclone (Partial Constant Evaluator) [Optional]

**Module**: `compiler/cyclone.js`  
**Function**: `export default (func, globals) => void`  
**Enabled by**: `-O2` or `--cyclone` flag

Wasm-level partial evaluator that folds constant expressions. Runs per-function, mutates `func.wasm` in-place.

## Stage 5: Assembly (Wasm Binary)

**Module**: `compiler/assemble.js`  
**Function**: `export default (funcs, globals, tags, pages, data, noTreeshake?) => Uint8Array`  
**Input**: The (optimized) funcs/globals/tags/pages/data  
**Output**: `Uint8Array` — a valid WebAssembly binary module (`.wasm` bytes)

Performs:
1. Import tree-shaking (only include used imports)
2. Serializes all Wasm sections: type, import, func, table, memory, tag, global, export, element, data_count, code, data, name (custom)
3. Encodes the Wasm IR instructions into binary format (LEB128 for integers, IEEE754 for f64, etc.)
4. Returns a complete Wasm module as `Uint8Array`

**Standalone usage**:
```js
import assemble from './compiler/assemble.js';
const wasmBinary = assemble(funcs, globals, tags, pages, data);
// wasmBinary is a Uint8Array, can be loaded with new WebAssembly.Module(wasmBinary)
```

## Stage 6: Instantiation & Execution (wrap.js)

**Module**: `compiler/wrap.js`  
**Function**: `export default (source, module?, print?) => { exports, wasm, times, pages, c }`  
**Input**: JS source string (or pre-compiled object)  
**Output**: Object with:
- `exports` — the instantiated Wasm exports, wrapped to convert Porffor values → JS values
- `wasm` — the raw Wasm binary
- `times` — compilation + instantiation timing
- `pages` — memory page map

This is the public API (`package.json` main). It:
1. Calls `compile()` from `index.js` to get the Wasm binary
2. Instantiates it with `new WebAssembly.Module()` + `new WebAssembly.Instance()`
3. Wraps each export to convert Porffor's `[value, type]` return pairs into JS values via `porfToJSValue()`

## Optional: C Backend

**Module**: `compiler/2c.js` (toc function)  
**Input**: The compile output object (funcs, globals, etc.)  
**Output**: C source code string

Transpiles the Wasm IR to C source code for native compilation.

## Optional: Disassembly

**Module**: `compiler/disassemble.js`  
**Function**: `export default (wasm, name, ind, locals, params, returns, funcs, globals, exceptions) => string`  
**Output**: Human-readable Wasm disassembly text

## Data Flow Summary

```
JS string
  │
  ▼  parse.js (acorn/babel/etc.)
ESTree AST (Program node)
  │
  ▼  semantic.js (variable scoping/renaming)
Annotated ESTree AST
  │
  ▼  codegen.js (AST → Wasm IR)
{ funcs: [{ wasm: [[opcode, ...args], ...], locals, params, returns }], globals, tags, exceptions, pages, data }
  │
  ▼  opt.js (peephole optimizations, in-place)
  ▼  pgo.js (optional profile-guided, in-place)
  ▼  cyclone.js (optional constant folding, in-place)
Same structure, optimized
  │
  ▼  assemble.js (IR → binary)
Uint8Array (valid .wasm binary)
  │
  ├─▶ wrap.js (WebAssembly.instantiate → run)
  ├─▶ 2c.js (→ C source code)
  └─▶ Write to .wasm file
```

## How to Call Each Stage Independently

```js
// Setup globals that the compiler expects
import './compiler/prefs.js';
import { Valtype, PageSize } from './compiler/wasmSpec.js';
globalThis.valtype = 'f64';
globalThis.valtypeBinary = Valtype.f64;
globalThis.pageSize = PageSize / 4;

// Stage 1: Parse
import parse from './compiler/parse.js';
const ast = parse('let x = 1 + 2; console.log(x);');

// Stage 2: Semantic analysis
import semantic from './compiler/semantic.js';
semantic(ast); // mutates in-place

// Stage 3: Codegen
import codegen from './compiler/codegen.js';
const ir = codegen(ast);
// ir.funcs[0] is #main, ir.funcs[0].wasm is the instruction array

// Stage 4: Optimize
import opt from './compiler/opt.js';
opt(ir.funcs, ir.globals, ir.pages, ir.tags, ir.exceptions);

// Stage 5: Assemble
import assemble from './compiler/assemble.js';
const wasmBinary = assemble(ir.funcs, ir.globals, ir.tags, ir.pages, ir.data);

// Stage 6: Run
const module = new WebAssembly.Module(wasmBinary);
const instance = new WebAssembly.Instance(module, imports);
instance.exports.m(); // call main

// Or use the all-in-one wrapper:
import wrap from './compiler/wrap.js';
const result = wrap('console.log(42)');
result.exports.main();
```

## File Index

| File | Role |
|------|------|
| `index.js` | Core compile pipeline orchestrator |
| `wrap.js` | Public API: compile + instantiate + value marshaling |
| `parse.js` | Parser wrapper (delegates to acorn/babel/etc.) |
| `semantic.js` | Variable scoping analysis + rename pass |
| `codegen.js` | AST → Wasm IR generation |
| `opt.js` | Peephole Wasm IR optimizer |
| `cyclone.js` | Wasm partial constant evaluator |
| `pgo.js` | Profile-guided optimization |
| `havoc.js` | Wasm rewrite utilities (used by PGO) |
| `assemble.js` | Wasm IR → binary serializer |
| `disassemble.js` | Wasm binary/IR → text disassembler |
| `2c.js` | Wasm IR → C transpiler |
| `expression.js` | JS operator → Wasm opcode mapping |
| `encoding.js` | LEB128, IEEE754, string encoding |
| `wasmSpec.js` | Wasm constants (opcodes, valtypes, sections) |
| `types.js` | Porffor type system (type IDs, flags, names) |
| `builtins.js` | Built-in functions/variables, import management |
| `builtins_precompiled.js` | Pre-compiled Wasm for built-in prototypes |
| `builtins/` | JS/TS source for built-in implementations |
| `prefs.js` | CLI flag → Prefs global configuration |
| `precompile.js` | Tool to precompile builtins/ into builtins_precompiled.js |
| `log.js` | Logging utilities |
