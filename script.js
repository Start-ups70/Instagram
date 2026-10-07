(function () {
  'use strict';

  var API_BASE = (typeof window.REELS_API_BASE === 'string') ? window.REELS_API_BASE : '';

  var form          = document.getElementById('downloadForm');
  var input         = document.getElementById('reelUrl');
  var submitBtn     = document.getElementById('submitBtn');
  var submitLabel   = document.getElementById('submitLabel');
  var spinner       = document.getElementById('spinner');
  var errorBox      = document.getElementById('errorBox');
  var errorText     = document.getElementById('errorText');
  var result        = document.getElementById('result');
  var resultThumb   = document.getElementById('resultThumb');
  var resultUser    = document.getElementById('resultUser');
  var resultFull    = document.getElementById('resultFullName');
  var resultMeta    = document.getElementById('resultMeta');
  var qualitySelect = document.getElementById('qualitySelect');
  var downloadBtn   = document.getElementById('downloadBtn');
  var resetBtn      = document.getElementById('resetBtn');

  var navToggle = document.getElementById('navToggle');
  var navMenu   = document.getElementById('navMenu');
  if (navToggle && navMenu) {
    navToggle.addEventListener('click', function () {
      var open = navMenu.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  var REEL_RE = /^https?:\/\/(?:www\.)?instagram\.com\/reels?\/([A-Za-z0-9_-]+)/i;

  function extractShortcode(raw) {
    if (typeof raw !== 'string') return null;
    var t = raw.trim();
    if (!t || t.length > 2048) return null;
    var m = t.match(REEL_RE);
    return m ? m[1] : null;
  }

  var currentData = null;
  var loading = false;

  function setLoading(on) {
    loading = on;
    if (submitBtn) submitBtn.disabled = on;
    if (spinner) spinner.hidden = !on;
    if (submitLabel) submitLabel.textContent = on ? 'Fetching Reel…' : 'Download Reel';
  }

  function showError(msg) { if (errorText) errorText.textContent = msg; if (errorBox) errorBox.hidden = false; }
  function clearError()   { if (errorBox) errorBox.hidden = true; if (errorText) errorText.textContent = ''; }

  function resetUI() {
    clearError();
    if (result) result.hidden = true;
    currentData = null;
    if (qualitySelect) qualitySelect.innerHTML = '';
  }

  function qualityLabel(v, isTop) {
    var base = Math.min(Number(v.width) || 0, Number(v.height) || 0);
    var q = v.quality || (base ? base + 'p' : 'Video');
    return (isTop && base >= 720) ? q + ' HD' : q;
  }

  function renderResult(data) {
    currentData = data;
    if (resultThumb && data.thumbnail) {
      resultThumb.src = data.thumbnail;
      resultThumb.alt = 'Reel by ' + (data.username || 'user');
    }
    if (resultUser) resultUser.textContent = data.username ? '@' + data.username : '@unknown';
    if (resultFull) {
      if (data.fullName) { resultFull.textContent = data.fullName; resultFull.hidden = false; }
      else resultFull.hidden = true;
    }
    var top = data.videos && data.videos[0];
    if (resultMeta && top) resultMeta.textContent = top.width + ' × ' + top.height;

    if (qualitySelect) {
      qualitySelect.innerHTML = '';
      (data.videos || []).forEach(function (v, i) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = qualityLabel(v, i === 0);
        qualitySelect.appendChild(o);
      });
      if (data.videos && data.videos.length) {
        qualitySelect.value = '0';
        updateDownloadLink();
      }
    }
    if (result) result.hidden = false;
  }

  function updateDownloadLink() {
    if (!currentData || !currentData.videos || !currentData.videos.length) return;
    var idx = parseInt(qualitySelect.value, 10);
    if (isNaN(idx) || idx < 0 || idx >= currentData.videos.length) idx = 0;
    var v = currentData.videos[idx];
    if (!v || !v.url) return;
    if (resultMeta) resultMeta.textContent = v.width + ' × ' + v.height;

    var u = String(currentData.username || 'reel').replace(/[^a-z0-9_-]/gi, '');
    var c = String(currentData.shortcode || 'reel').replace(/[^a-z0-9_-]/gi, '');
    var f = u + '-' + c + '-' + (v.quality || 'video') + '.mp4';

    downloadBtn.href = API_BASE + '/api/media?url=' + encodeURIComponent(v.url)
                     + '&name=' + encodeURIComponent(f);
    downloadBtn.setAttribute('download', f);
  }

  if (qualitySelect) qualitySelect.addEventListener('change', updateDownloadLink);

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (loading) return;
      clearError();
      if (result) result.hidden = true;

      var raw = input ? input.value : '';
      var shortcode = extractShortcode(raw);

      if (!shortcode) {
        showError('Please paste a valid Instagram Reel URL.');
        if (input) input.focus();
        return;
      }

      setLoading(true);

      var controller = new AbortController();
      var tid = setTimeout(function () { controller.abort(); }, 25000);

      fetch(API_BASE + '/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: String(raw).trim() }),
        signal: controller.signal
      })
      .then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = JSON.parse(text); } catch (_) {}
          return { status: res.status, ok: res.ok, body: body, raw: text };
        });
      })
      .then(function (r) {
        clearTimeout(tid);
        if (r.ok && r.body && r.body.success && r.body.data) {
          renderResult(r.body.data);
          return;
        }
        console.error('[api] response', r.status, r.raw.slice(0, 500));

        var code = (r.body && r.body.error) || '';
        var serverMsg = (r.body && r.body.message) || '';
        var msg = serverMsg;

        if (!msg) {
          if (code === 'INVALID_URL') msg = 'Please paste a valid Instagram Reel URL.';
          else if (code === 'PRIVATE') msg = 'This Reel is private or unavailable.';
          else if (code === 'NOT_FOUND') msg = "We couldn't find this Reel.";
          else if (code === 'NO_VIDEO') msg = 'No downloadable video was found.';
          else if (code === 'RATE_LIMIT') msg = 'Too many requests. Please try again later.';
          else if (r.status >= 500) msg = 'Something went wrong. Please try again.';
          else msg = 'Request failed (' + r.status + ').';
        }
        showError(msg);
      })
      .catch(function (err) {
        clearTimeout(tid);
        console.error('[api] network error', err);
        if (err && err.name === 'AbortError') showError('The request took too long. Please try again.');
        else showError('Could not reach the server. Make sure the backend is running and you opened http://localhost:3000 (not the file).');
      })
      .then(function () { setLoading(false); });
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      if (input) input.value = '';
      resetUI();
      if (input) input.focus();
    });
  }
})();
