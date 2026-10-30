(() => {
  const requested = new URLSearchParams(location.search).get('theme');
  let saved = null;
  try { saved = localStorage.getItem('aio-theme'); } catch { /* Storage can be disabled. */ }
  const theme = [requested, saved].find(value => value === 'light' || value === 'dark')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
})();
