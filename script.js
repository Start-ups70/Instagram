/* ============================================================
   REELS DOWNLOADER — front-end
   - Validates Instagram Reel URLs
   - Calls the backend proxy at POST /api/download
   - Renders thumbnail, username and available qualities
   - Uses the backend /api/media whitelisted proxy for download
   ============================================================ */
(function () {
  'use strict';

  /* If the frontend is on a different origin than the backend,
     set window.REELS_API_BASE before this script loads. */
  var API_BASE = (typeof window.REELS_API_BASE === 'string')
    ? window.REELS_API_BASE
    : '';

  /* ---------------- Elements (guarded) ---------------- */
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

  /* ---------------- Nav toggle ---------------- */
  var navToggle = document.getElementById('navToggle');
  var navMenu   = document.getElementById('navMenu');
  if (navToggle && navMenu) {
    navToggle.addEventListener('click', function () {
      var open = navMenu.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
  }

  /* ---------------- Footer year ---------------- */
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ---------------- URL validation ---------------- */
  var REEL_RE = /^https?:\/\/(?:www\.)?instagram\.com\/reels?\/([A-Za-z0-9_-]+)/i;

  function extractShortcode(raw) {
    if (typeof raw !== 'string') return null;
    var trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 2048) return null;
    var m = trimmed.match(REEL_RE);
    return m ? m[1] : null;
  }

  /* ---------------- State ---------------- */
  var currentData = null;
  var loading = false;

  function setLoading(on) {
    loading = on;
    if (submitBtn) submitBtn.disabled = on;
    if (spinner) spinner.hidden = !on;
    if (submitLabel) submitLabel.textContent = on ? 'Fetching Reel\u2026' : 'Download Reel';
    if (submitBtn) submitBtn.classList.toggle('is-loading', on);
  }

  function showError(msg) {
    if (!errorBox || !errorText) return;
    errorText.textContent = msg;
    errorBox.hidden = false;
  }

  function clearError() {
    if (!errorBox) return;
    errorBox.hidden = true;
    if (errorText) errorText.textContent = '';
  }

  function resetUI() {
    clearError();
    if (result) result.hidden = true;
    currentData = null;
    if (qualitySelect) qualitySelect.innerHTML = '';
    if (resultThumb) { resultThumb.removeAttribute('src'); resultThumb.alt = ''; }
    if (downloadBtn) downloadBtn.href = '#';
  }

  /* ---------------- Render ---------------- */
  function qualityLabel(video, isTop) {
    var base = Math.min(Number(video.width) || 0, Number(video.height) || 0);
    var q = video.quality || (base ? base + 'p' : 'Video');
    if (isTop && base >= 720) return q + ' HD';
    return q;
  }

  function renderResult(data) {
    currentData = data;

    if (resultThumb) {
      if (data.thumbnail) {
        resultThumb.src = data.thumbnail;
        resultThumb.alt = 'Thumbnail for Reel by ' + (data.username || 'user');
      } else {
        resultThumb.removeAttribute('src');
        resultThumb.alt = '';
      }
    }

    if (resultUser) {
      resultUser.textContent = data.username ? '@' + data.username : '@unknown';
    }
    if (resultFull) {
      if (data.fullName) {
        resultFull.textContent = data.fullName;
        resultFull.hidden = false;
      } else {
        resultFull.hidden = true;
      }
    }

    var top = data.videos && data.videos[0];
    if (resultMeta && top) {
      resultMeta.textContent = top.width + ' \u00D7 ' + top.height;
    }

    if (qualitySelect) {
      qualitySelect.innerHTML = '';
      (data.videos || []).forEach(function (v, i) {
        var opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = qualityLabel(v, i === 0);
        qualitySelect.appendChild(opt);
      });
      if (data.videos && data.videos.length) {
        qualitySelect.value = '0';
        updateDownloadLink();
      }
    }

    if (result) result.hidden = false;

    try {
      if (result && result.scrollIntoView) {
        result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (_) {}
  }

  function updateDownloadLink() {
    if (!currentData || !currentData.videos || !currentData.videos.length) return;
    if (!qualitySelect || !downloadBtn) return;

    var idx = parseInt(qualitySelect.value, 10);
    if (isNaN(idx) || idx < 0 || idx >= currentData.videos.length) idx = 0;

    var v = currentData.videos[idx];
    if (!v || !v.url) return;

    if (resultMeta) resultMeta.textContent = v.width + ' \u00D7 ' + v.height;

    var safeUser = String(currentData.username || 'reel').replace(/[^a-z0-9_-]/gi, '');
    var safeCode = String(currentData.shortcode || 'reel').replace(/[^a-z0-9_-]/gi, '');
    var filename = safeUser + '-' + safeCode + '-' + (v.quality || 'video') + '.mp4';

    /* Use the backend whitelisted media proxy so the browser reliably saves the file. */
    downloadBtn.href = API_BASE + '/api/media?url=' +
      encodeURIComponent(v.url) + '&name=' + encodeURIComponent(filename);
    downloadBtn.setAttribute('download', filename);
  }

  if (qualitySelect) qualitySelect.addEventListener('change', updateDownloadLink);

  /* ---------------- Submit ---------------- */
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
      var timeoutId = setTimeout(function () { controller.abort(); }, 25000);

      fetch(API_BASE + '/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: String(raw).trim() }),
        signal: controller.signal
      })
        .then(function (res) {
          return res.json().catch(function () { return null; })
            .then(function (body) { return { status: res.status, ok: res.ok, body: body }; });
        })
        .then(function (r) {
          clearTimeout(timeoutId);

          if (r.ok && r.body && r.body.success && r.body.data) {
            renderResult(r.body.data);
            return;
          }

          var code = (r.body && r.body.error) || '';
          var msg = 'Something went wrong. Please try again.';

          if (code === 'INVALID_URL')      msg = 'Please paste a valid Instagram Reel URL.';
          else if (code === 'PRIVATE')     msg = 'This Reel is private or unavailable.';
          else if (code === 'NOT_FOUND')   msg = "We couldn't find this Reel.";
          else if (code === 'NO_VIDEO')    msg = 'No downloadable video was found.';
          else if (code === 'RATE_LIMIT')  msg = 'Too many requests. Please try again later.';

          if (r.status >= 500) msg = 'Something went wrong. Please try again.';

          showError(msg);
        })
        .catch(function (err) {
          clearTimeout(timeoutId);
          if (err && err.name === 'AbortError') {
            showError('The request took too long. Please try again.');
          } else {
            showError('Something went wrong. Please try again.');
          }
        })
        .then(function () {
          setLoading(false);
        });
    });
  }

  /* ---------------- Reset ---------------- */
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      if (input) input.value = '';
      resetUI();
      if (input) input.focus();
      try {
        var dl = document.getElementById('downloader');
        if (dl && dl.scrollIntoView) dl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (_) {}
    });
  }

})();
