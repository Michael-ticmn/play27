// ============================================================
// play27 — Theme Toggle
// Dark/light mode with localStorage persistence
// ============================================================

const STORAGE_KEY = 'play27-theme';

export function setTheme(theme) {
  if (theme === 'light') {
    document.body.classList.add('light');
    document.documentElement.classList.add('light');
  } else {
    document.body.classList.remove('light');
    document.documentElement.classList.remove('light');
  }
  localStorage.setItem(STORAGE_KEY, theme);

  // Update all theme toggle buttons
  document.querySelectorAll('[data-theme]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

export function initTheme(defaultTheme = 'dark') {
  const saved = localStorage.getItem(STORAGE_KEY);
  setTheme(saved || defaultTheme);

  document.querySelectorAll('[data-theme]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setTheme(btn.dataset.theme);
    });
  });
}
