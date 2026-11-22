import { readState, saveState } from './storage.js';

export function installTheme() {
  const options = document.getElementById('theme-options');
  const modes = new Set(['paper', 'mist', 'night']);
  const apply = (theme) => {
    if (!modes.has(theme)) return;
    document.documentElement.dataset.theme = theme;
    options.querySelector(`input[value="${theme}"]`).checked = true;
  };
  let changed = false;
  options.onchange = ({ target }) => {
    changed = true;
    apply(target.value);
    saveState('interfaceTheme', target.value).catch(() => {});
  };
  readState('interfaceTheme').then((value) => { if (!changed) apply(value); }).catch(() => {});
}
