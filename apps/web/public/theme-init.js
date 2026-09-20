// 首屏防闪：在 React 挂载前按用户偏好落 .dark（外置以便 CSP 用 script-src 'self'）
(function () {
  try {
    var m = localStorage.getItem('atoms:theme');
    var dark =
      m === 'dark' ||
      (m !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var r = document.documentElement;
    if (dark) r.classList.add('dark');
    r.style.colorScheme = dark ? 'dark' : 'light';
  } catch {}
})();
