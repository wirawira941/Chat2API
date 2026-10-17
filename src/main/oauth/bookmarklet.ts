/**
 * Bookmarklet generator for the web build's token-import flow.
 *
 * DeepSeek (and the other web providers) have no OAuth redirect, and their
 * login form is protected by Cloudflare Turnstile + Shumei + hCaptcha. Those
 * challenges can only be solved by a real browser on the provider's own origin,
 * so a headless server can never log in on the user's behalf.
 *
 * Instead the user logs in normally in their phone's browser (same Chromium,
 * same captcha, same request fingerprint => no account risk) and this script,
 * run from a bookmark on the provider's page, copies the resulting token to the
 * clipboard. No DevTools required.
 *
 * The generated code is deliberately dependency-free ES5-ish so it works on
 * older mobile browsers.
 */

import type { TokenExtractionGuide } from './guides'

/** Collapses a multi-line script into the single-line form a javascript: URL needs. */
function toSingleLine(source: string): string {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .join(' ')
}

/**
 * Builds the plain script (no `javascript:` prefix) that reads the provider's
 * token out of page storage and copies it.
 */
export function buildTokenHelperScript(guide: TokenExtractionGuide): string {
  const key = JSON.stringify(guide.tokenKey)
  const storageType = JSON.stringify(guide.storageType)
  const label = JSON.stringify(guide.tokenLabel)
  const host = JSON.stringify(new URL(guide.loginUrl).hostname)

  return toSingleLine(`
  (function () {
    var KEY = ${key};
    var STORAGE = ${storageType};
    var LABEL = ${label};
    var HOST = ${host};

    // Tokens are stored in several shapes across providers and versions:
    // a RAW string, a JSON-quoted string ("eyJ..."), or an object with the
    // value nested. Normalise all of them down to the bare token.
    function normalize(raw) {
      if (!raw) return null;
      var value = String(raw).trim();
      if (!value) return null;
      try {
        var parsed = JSON.parse(value);
        if (typeof parsed === 'string') value = parsed;
        else if (parsed && typeof parsed === 'object') {
          value = parsed.value || parsed.token || parsed.access_token || '';
        }
      } catch (e) { /* not JSON, keep as-is */ }
      value = String(value).replace(/^"+|"+$/g, '').trim();
      return value || null;
    }

    function readLocalStorage() {
      try {
        var direct = normalize(localStorage.getItem(KEY));
        if (direct) return direct;
        // Fall back to a case-insensitive substring scan: providers rename the
        // key occasionally and a silent failure here is worse than a scan.
        var needle = KEY.toLowerCase();
        for (var i = 0; i < localStorage.length; i++) {
          var name = localStorage.key(i);
          if (name && name.toLowerCase().indexOf(needle) !== -1) {
            var found = normalize(localStorage.getItem(name));
            if (found) return found;
          }
        }
      } catch (e) { /* storage may be blocked */ }
      return null;
    }

    function readCookie() {
      try {
        var pairs = document.cookie ? document.cookie.split(';') : [];
        for (var i = 0; i < pairs.length; i++) {
          var pair = pairs[i].trim();
          var eq = pair.indexOf('=');
          if (eq === -1) continue;
          if (pair.slice(0, eq) === KEY) {
            return normalize(decodeURIComponent(pair.slice(eq + 1)));
          }
        }
        // Loose match, same reasoning as the localStorage scan.
        for (var j = 0; j < pairs.length; j++) {
          var p = pairs[j].trim();
          var e2 = p.indexOf('=');
          if (e2 === -1) continue;
          if (p.slice(0, e2).toLowerCase().indexOf(KEY.toLowerCase()) !== -1) {
            return normalize(decodeURIComponent(p.slice(e2 + 1)));
          }
        }
      } catch (e) { /* cookies may be blocked */ }
      return null;
    }

    function copy(text) {
      var done = function () {
        alert(LABEL + ' copied.\\n\\nPaste it into the Chat2API dashboard.\\n\\n' + text.slice(0, 24) + '...');
      };
      // Clipboard API needs a secure context; provider pages are https, so this
      // is the normal path. prompt() is the manual fallback when it is blocked.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          window.prompt('Copy this ' + LABEL + ' (select all, then copy):', text);
        });
      } else {
        window.prompt('Copy this ' + LABEL + ' (select all, then copy):', text);
      }
    }

    var token = STORAGE === 'cookie' ? readCookie() : readLocalStorage();
    if (!token && STORAGE !== 'cookie') token = readCookie();
    if (!token) token = readLocalStorage();

    if (!token) {
      alert('No ' + LABEL + ' found on ' + HOST + '.\\n\\nMake sure you are logged in and run this bookmark on the provider page itself.');
      return;
    }
    copy(token);
  })();
  `)
}

/** Same script as a `javascript:` URL, ready to be saved as a bookmark. */
export function buildBookmarkletUrl(guide: TokenExtractionGuide): string {
  return `javascript:${buildTokenHelperScript(guide)}`
}
