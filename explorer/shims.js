// Browser shims for Node.js globals
if (typeof process === 'undefined') {
  globalThis.process = { 
    argv: [], 
    version: undefined, 
    stdout: { isTTY: false },
    env: {}
  };
}
