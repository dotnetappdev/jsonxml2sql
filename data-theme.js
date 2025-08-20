// Theme module
(function(){
  'use strict';

  function initTheme() {
    const root = document.documentElement;
    const saved = localStorage.getItem('jsonxml2sql_theme') || 'light';
    root.classList.toggle('theme-light', saved === 'light');
    root.classList.toggle('theme-dark', saved === 'dark');
    const sw = document.getElementById('themeSwitch');
    const label = document.querySelector('.theme-toggle-label');
    if (sw) {
      sw.setAttribute('data-on', String(saved === 'dark'));
      sw.setAttribute('aria-checked', String(saved === 'dark'));
    }
    if (label) label.textContent = saved === 'dark' ? 'Dark mode' : 'Light mode';
  }

  function initThemeSwitch() {
    const themeSwitch = document.getElementById('themeSwitch'); if (!themeSwitch) return;
    const toolbar = document.getElementById('mainToolbar');
    const apply = (on) => {
      const root = document.documentElement;
      localStorage.setItem('jsonxml2sql_theme', on ? 'dark' : 'light');
      root.classList.toggle('theme-dark', on);
      root.classList.toggle('theme-light', !on);
      themeSwitch.setAttribute('data-on', on ? 'true' : 'false');
      themeSwitch.setAttribute('aria-checked', on ? 'true' : 'false');
      toolbar?.classList.toggle('dark', on);
      toolbar?.querySelector('.brand-title')?.classList.toggle('dark', on);
      toolbar?.querySelector('.brand-desc')?.classList.toggle('dark', on);
      toolbar?.querySelector('.theme-toggle-label')?.classList.toggle('dark', on);
    };
    const isOn = (localStorage.getItem('jsonxml2sql_theme') || 'light') === 'dark';
    apply(isOn);
    themeSwitch.addEventListener('click', () => apply(themeSwitch.getAttribute('data-on') !== 'true'));
    themeSwitch.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); apply(themeSwitch.getAttribute('data-on') !== 'true'); } });
  }

  // expose
  window.initTheme = initTheme;
  window.initThemeSwitch = initThemeSwitch;
})();
