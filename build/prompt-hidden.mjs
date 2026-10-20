// Minimal terminal prompt that does not echo what is typed.
// Used by publish-release.mjs so the PAT never shows up on screen or in scrollback.

import { emitKeypressEvents } from 'node:readline';

export function promptHidden(label) {
  const stdin = process.stdin;
  const stdout = process.stderr;
  if (!stdin.isTTY) {
    return Promise.reject(new Error('stdin is not a terminal; cannot read the PAT interactively'));
  }
  return new Promise((resolve, reject) => {
    let value = '';
    let done = false;
    const cleanup = () => {
      stdin.removeListener('keypress', onKey);
      if (stdin.setRawMode) stdin.setRawMode(false);
      stdin.pause();
    };
    const finish = (text) => {
      if (done) return;
      done = true;
      cleanup();
      stdout.write('\n');
      resolve(text);
    };
    const onKey = (str, key = {}) => {
      if (key.sequence === '\u0003') {
        cleanup();
        stdout.write('\n');
        reject(new Error('cancelled'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish(value.trim());
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (str && !key.ctrl && !key.meta) value += str;
    };
    emitKeypressEvents(stdin);
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    stdout.write(label);
  });
}
