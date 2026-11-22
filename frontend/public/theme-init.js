/* Restore the persisted theme before first paint.
 *
 * Kept as an external same-origin file because the front-end CSP is
 * `script-src 'self'`: an inline restore script is blocked, so a light-theme
 * preference silently reverted to dark on every reload. This file is served
 * from /theme-init.js and is cacheable like any other static asset. */
(function () {
  try {
    var t = localStorage.getItem("mpx-theme");
    if (t === "dark" || t === "light")
      document.documentElement.setAttribute("data-theme", t);
  } catch {
    /* private mode: default dark theme applies */
  }
})();
