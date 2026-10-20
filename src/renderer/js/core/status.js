/**
 * Status-bar helper. Kept in its own module so session views can report
 * status without importing app.js (which imports the views -> cycle).
 */
const statusEl = document.getElementById('status-text');

export function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}
