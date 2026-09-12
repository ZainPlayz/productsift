// Applied before first paint (a normal, blocking <script src> in <head>, run
// before <body> is parsed) so the page never flashes light-then-dark on
// load - reads a saved choice, or falls back to the OS-level preference the
// CSS media query already applies on its own. Split into its own file
// instead of an inline <script> because the app's CSP (script-src 'self')
// intentionally has no 'unsafe-inline' - an external same-origin file is the
// correct way to get blocking pre-paint execution without weakening that.
(function () {
  var saved = localStorage.getItem("theme");
  if (saved === "dark" || saved === "light") {
    document.documentElement.setAttribute("data-theme", saved);
  }
})();
