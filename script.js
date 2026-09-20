// ==========================================================================
// Supabase client
// ==========================================================================
const { createClient } = supabase;
const sb = createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);
const BUCKET = window.SUPABASE_CONFIG.bucket;

// Escape user-controlled text before putting it into innerHTML. Names, notes and
// contributor names come from the public, so they must never be trusted as HTML.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// in-memory caches of the last fetch, so approve/reject and rendering don't
// need a round trip just to read back a name/notes/etc. the DB is still the
// source of truth — these are only ever populated by a fetch from it.
let pendingCache = [];
let approvedCache = [];

// ==========================================================================
// pipeline stepper
// ==========================================================================
const STEP_ORDER = ['capture', 'screening', 'review', 'map'];
const stepEls = {};
document.querySelectorAll('.step').forEach(el => { stepEls[el.dataset.step] = el; });
const pipelineFill = document.getElementById('pipelineFill');

function setPipelineStage(stage) {
  const idx = STEP_ORDER.indexOf(stage);
  STEP_ORDER.forEach((key, i) => {
    const el = stepEls[key];
    el.classList.remove('is-active', 'is-done');
    if (i < idx) el.classList.add('is-done');
    else if (i === idx) el.classList.add('is-active');
  });
  const pct = idx <= 0 ? 0 : (idx / (STEP_ORDER.length - 1)) * 100;
  pipelineFill.style.width = pct + '%';
}
setPipelineStage('capture');

// ==========================================================================
// tab navigation
// ==========================================================================
function goToTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === tabName));
  if (tabName === 'admin') { renderAdmin(); setPipelineStage('review'); }
  if (tabName === 'map') { setTimeout(renderMap, 50); setPipelineStage('map'); }
  if (tabName === 'capture') { setPipelineStage(captureFlowStage()); }
}
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => goToTab(btn.dataset.tab);
});

// which pipeline stage the capture tab currently represents
function captureFlowStage() {
  if (!document.getElementById('stageScreening').hidden) return 'screening';
  if (!document.getElementById('stageResult').hidden) return 'screening';
  if (!document.getElementById('stageRejected').hidden) return 'screening';
  if (!document.getElementById('stageSuccess').hidden) return 'review';
  return 'capture';
}

// ==========================================================================
// connection status (real check — also gates submission, since this build
// requires a live connection to reach Supabase rather than queuing offline)
// ==========================================================================
function updateNetStatus() {
  const el = document.getElementById('netStatus');
  if (navigator.onLine) { el.textContent = 'Online'; el.className = 'pill approved'; }
  else { el.textContent = 'Offline — submission unavailable'; el.className = 'pill rejected'; }
}
window.addEventListener('online', updateNetStatus);
window.addEventListener('offline', updateNetStatus);
updateNetStatus();

// ==========================================================================
// GPS
// ==========================================================================
let gps = null;
document.getElementById('gpsBtn').onclick = () => {
  const status = document.getElementById('gpsStatus');
  const btn = document.getElementById('gpsBtn');

  if (!navigator.geolocation) {
    status.textContent = 'Geolocation isn\u2019t available in this browser — location can\u2019t be verified, so you can\u2019t submit from here.';
    gps = null;
    return;
  }

  gps = null;
  btn.disabled = true;
  status.textContent = 'Requesting location… getting a precise fix can take a few seconds';

  let best = null;
  let watchId = null;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    btn.disabled = false;
    if (best) {
      gps = { lat: best.coords.latitude, lng: best.coords.longitude, accuracy: best.coords.accuracy };
      const acc = Number.isFinite(best.coords.accuracy) ? ` (±${Math.round(best.coords.accuracy)}m)` : '';
      status.textContent = `Captured: ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}${acc}`;
    } else {
      status.textContent = 'Couldn\u2019t get your location. Allow location access for this site and try again — it\u2019s needed to confirm you are at the heritage site.';
      gps = null;
    }
  };

  // watchPosition + keep the most accurate reading, rather than accepting
  // whatever the very first (often roughest) fix happens to be. Stops early
  // once we get a solid fix, or after 8s regardless of how good it is —
  // on hardware with no GPS chip (most laptops), it may never get much
  // better than a rough Wi-Fi-based estimate, and that's a real hardware
  // limit, not something this code can fix.
  watchId = navigator.geolocation.watchPosition(
    pos => {
      if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
      if (pos.coords.accuracy <= 20) finish();
    },
    () => finish(),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );

  setTimeout(finish, 8000);
};

// ==========================================================================
// photo preview
// ==========================================================================
let photoDataUrl = null;
document.getElementById('photoInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    photoDataUrl = reader.result;
    const img = document.getElementById('preview');
    img.src = photoDataUrl;
    img.style.display = 'block';
  };
  reader.readAsDataURL(file);
};

// ==========================================================================
// fully local image-analysis engine
// No network calls, no external model weights — runs entirely in-browser via <canvas> pixel
// analysis, so screening itself still works with zero internet. This is deliberately
// transparent: it's a real, working quality + heuristic screen (resolution, blur estimate,
// dominant-tone classification), not a deep neural network. Swapping in a trained CV model
// is the next milestone — say that plainly if asked, it's an honest and normal thing to have
// left for later. (Saving the result to the database still needs a connection — see below.)
// ==========================================================================
function analyzeImageLocally(imgEl) {
  const w = imgEl.naturalWidth, h = imgEl.naturalHeight;
  const lowRes = (w < 300 || h < 300);

  // downsample onto a small canvas for fast, consistent pixel sampling
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  let rSum = 0, gSum = 0, bSum = 0, brightSum = 0;
  const gray = new Float32Array(size * size);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    rSum += r; gSum += g; bSum += b;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[p] = lum;
    brightSum += lum;
  }
  const n = size * size;
  const avgR = rSum / n, avgG = gSum / n, avgB = bSum / n;
  const brightness = brightSum / n; // 0-255

  // crude blur estimate: average gradient magnitude between neighboring pixels
  let gradSum = 0, gradCount = 0;
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const idx = y * size + x;
      const dx = gray[idx] - gray[idx + 1];
      const dy = gray[idx] - gray[idx + size];
      gradSum += Math.sqrt(dx * dx + dy * dy);
      gradCount++;
    }
  }
  const sharpness = gradSum / gradCount; // higher = sharper
  const likelyBlurry = sharpness < 4;

  // dominant-tone heuristic classification (stand-in for a trained model)
  let label, confidence;
  if (avgR > avgG + 15 && avgR > avgB + 15 && brightness > 90) {
    label = 'Sandstone structure (fort/palace-like tones)'; confidence = 0.55;
  } else if (Math.abs(avgR - avgG) < 12 && Math.abs(avgG - avgB) < 12 && brightness > 100) {
    label = 'Stone monument (grey tones — temple/ruins-like)'; confidence = 0.5;
  } else if (avgG > avgR + 10 && avgG > avgB + 10) {
    label = 'Overgrown site (vegetation-heavy)'; confidence = 0.45;
  } else if (brightness < 60) {
    label = 'Low-light capture — needs re-shoot'; confidence = 0.3;
  } else {
    label = 'Unclassified structure'; confidence = 0.35;
  }

  const flagged = lowRes || likelyBlurry;
  if (flagged) confidence = Math.min(confidence, 0.3);

  return {
    label, confidence, flagged, lowRes, likelyBlurry, sharpness,
    width: w, height: h,
    source: 'on-device heuristic engine (fully offline, no external model)'
  };
}

async function runAiCheck(imgEl) {
  return analyzeImageLocally(imgEl);
}

// ==========================================================================
// Supabase data layer
// ==========================================================================
// Submissions are NOT written from the browser any more. They go to the
// /api/verify-submission serverless function, which runs the Gemini, GPS and
// duplicate checks and only then saves (using a server-side key).

// Downscale + re-encode as JPEG so the request stays small (Vercel functions
// accept ~4.5 MB bodies; a phone photo is often 5-12 MB) and Gemini gets a
// sensible size. 1600px on the long edge is plenty to judge sharpness/content.
function prepareImageForUpload(imgEl) {
  const MAX_EDGE = 1600, MAX_BYTES = 2.5 * 1024 * 1024;
  const scale = Math.min(1, MAX_EDGE / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
  const w = Math.max(1, Math.round(imgEl.naturalWidth * scale));
  const h = Math.max(1, Math.round(imgEl.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(imgEl, 0, 0, w, h);
  let q = 0.88, dataUrl = canvas.toDataURL('image/jpeg', q);
  while (dataUrl.length * 0.75 > MAX_BYTES && q > 0.4) { q -= 0.1; dataUrl = canvas.toDataURL('image/jpeg', q); }
  return { dataUrl, width: w, height: h };
}

async function submitForVerification(payload) {
  const res = await fetch('/api/verify-submission', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!data) throw new Error(`Unexpected response from the server (HTTP ${res.status}).`);
  return data;
}

async function fetchPending() {
  const { data, error } = await sb
    .from('photos')
    .select('id, notes, lat, lng, gps_accuracy_m, width_px, height_px, contributor_name, photo_url, ai_label, ai_confidence, ai_flagged, ai_source, created_at, distance_to_reference_m, verification, sites(name, category)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function fetchApproved() {
  const { data, error } = await sb
    .from('photos')
    .select('id, notes, lat, lng, contributor_name, photo_url, ai_label, sites(name, category)')
    .eq('status', 'approved');
  if (error) throw error;
  return data || [];
}

async function updatePhotoStatus(id, status) {
  const { error } = await sb.from('photos').update({ status, reviewed_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// how close a submission's GPS needs to be to a catalogued reference site
// before it's treated as a plausible match rather than just "nearest known
// site, for context" — 3km gives room for GPS drift and large site grounds.
const REFERENCE_MATCH_RADIUS_M = 3000;

async function fetchNearestReferenceSite(lat, lng) {
  const { data, error } = await sb.rpc('nearest_reference_site', { p_lat: lat, p_lng: lng });
  if (error) { console.error(error); return null; }
  return (Array.isArray(data) ? data[0] : data) || null;
}

function renderReferenceMatch(match) {
  if (!match) {
    return `<div class="ref-match ref-none"><span class="meta-pill muted">No catalogued ASI reference site nearby yet</span></div>`;
  }
  const withinRange = match.distance_m <= REFERENCE_MATCH_RADIUS_M;
  const distText = match.distance_m < 1000 ? `${Math.round(match.distance_m)}m away` : `${(match.distance_m / 1000).toFixed(1)}km away`;
  return `
    <div class="ref-match ${withinRange ? 'ref-ok' : 'ref-far'}">
      ${match.image_url ? `<img src="${esc(match.image_url)}" alt="" class="ref-photo">` : ''}
      <div class="ref-meta">
        <span class="meta-pill ${withinRange ? '' : 'muted'}">${withinRange ? 'Near a known site' : 'Nearest known site is far'}</span>
        <div class="ref-name">${esc(match.name)}${match.district ? `, ${esc(match.district)}` : ''}${match.state ? `, ${esc(match.state)}` : ''}</div>
        <div class="ref-distance">${distText}${withinRange ? '' : ' \u2014 verify carefully'}</div>
        ${match.image_attribution ? `<div class="ref-attribution">${esc(match.image_attribution)}</div>` : ''}
      </div>
    </div>
  `;
}

// ==========================================================================
// staged capture flow: form -> screening -> result -> success
// ==========================================================================
const stageForm = document.getElementById('stageForm');
const stageScreening = document.getElementById('stageScreening');
const stageResult = document.getElementById('stageResult');
const stageSuccess = document.getElementById('stageSuccess');
const stageRejected = document.getElementById('stageRejected');

function showStage(el) {
  [stageForm, stageScreening, stageResult, stageSuccess, stageRejected].forEach(s => { s.hidden = (s !== el); });
}

// renders the server's list of checks (✓ passed, ! warning, ✗ failed)
function renderChecks(listEl, checks) {
  const icon = { pass: '\u2713', warn: '!', fail: '\u2717' };
  listEl.innerHTML = (checks || []).map(c => `
    <li class="check check-${esc(c.status)}">
      <span class="check-icon" aria-hidden="true">${icon[c.status] || '\u2022'}</span>
      <span><span class="check-label">${esc(c.label)}</span>${c.detail && c.status !== 'fail' ? `<span class="check-detail"> — ${esc(c.detail)}</span>` : ''}</span>
    </li>`).join('');
}

function showRejected(title, message, checks) {
  document.getElementById('rejectedTitle').textContent = title;
  document.getElementById('rejectedMessage').textContent = message;
  renderChecks(document.getElementById('rejectedChecks'), checks);
  showStage(stageRejected);
  setPipelineStage('screening');
}

const REJECT_TITLES = {
  image_blurry: 'Please upload a better photo',
  not_heritage_image: 'That doesn\u2019t look like a heritage site',
  title_mismatch: 'Photo and title don\u2019t match',
  gps_too_far: 'You don\u2019t appear to be at this site',
  gps_unreliable: 'Location isn\u2019t precise enough',
  site_unknown: 'Site not found in the register',
  site_mismatch: 'Photo doesn\u2019t match this site',
  duplicate_image: 'Already in the archive',
  rate_limited: 'Slow down a little',
  ai_unavailable: 'Verification unavailable'
};
document.getElementById('retryBtn').onclick = () => { showStage(stageForm); setPipelineStage('capture'); };

document.getElementById('submitBtn').onclick = async () => {
  const name = document.getElementById('siteName').value.trim();
  const category = document.getElementById('siteCategory').value;
  const notes = document.getElementById('siteNotes').value.trim();
  const contributorName = document.getElementById('contributorName').value.trim();
  const errEl = document.getElementById('formError');

  if (!name) { errEl.textContent = 'Please add a site name.'; return; }
  if (!photoDataUrl) { errEl.textContent = 'Please add a photo.'; return; }
  if (!gps || !Number.isFinite(gps.accuracy)) { errEl.textContent = 'Please capture your GPS location first — it is used to confirm you are at the site.'; return; }
  if (!navigator.onLine) { errEl.textContent = 'You\u2019re offline — connect to the internet to submit.'; return; }
  errEl.textContent = '';

  const imgEl = document.getElementById('preview');

  // → verification stage
  showStage(stageScreening);
  setPipelineStage('screening');
  const subEl = document.getElementById('screeningSub');
  const subMessages = [
    'Checking the photo on your device',
    'Asking Gemini whether the photo matches the title',
    'Checking your GPS against the ASI register',
    'Comparing with photos already on record',
    'Reviewing your notes'
  ];
  let subIdx = 0;
  subEl.textContent = subMessages[0];
  const subTimer = setInterval(() => {
    subIdx = Math.min(subIdx + 1, subMessages.length - 1);
    subEl.textContent = subMessages[subIdx];
  }, 2200);

  // on-device pre-check: an image under 300px can never be verified, so don't spend a request on it.
  // (Blur is judged by Gemini on the server — a 64px gradient estimate is too crude to reject people with.)
  const local = await runAiCheck(imgEl);
  if (local.lowRes) {
    clearInterval(subTimer);
    showRejected('Please upload a better photo',
      `This photo is only ${local.width}\u00d7${local.height}px — too small to verify. Please upload a larger, sharper image.`,
      [{ status: 'fail', label: 'Photo is large enough' }]);
    return;
  }

  let data;
  try {
    const prepared = prepareImageForUpload(imgEl);
    data = await submitForVerification({
      name, category, notes, contributorName,
      gps: { lat: gps.lat, lng: gps.lng, accuracy: gps.accuracy },
      image: prepared.dataUrl, width: prepared.width, height: prepared.height
    });
  } catch (err) {
    console.error(err);
    clearInterval(subTimer);
    errEl.textContent = 'Could not reach the verification server — check your connection and try again. Nothing was saved.';
    showStage(stageForm);
    setPipelineStage('capture');
    return;
  }
  clearInterval(subTimer);

  // → rejected: nothing was saved; the form keeps everything the person typed
  if (!data.ok) {
    if (['invalid_input', 'server_misconfigured', 'server_error', 'method_not_allowed', 'save_failed'].includes(data.code)) {
      errEl.textContent = data.message || 'Something went wrong. Nothing was saved.';
      showStage(stageForm);
      setPipelineStage('capture');
      return;
    }
    showRejected(REJECT_TITLES[data.code] || 'Couldn\u2019t verify this submission', data.message, data.checks);
    return;
  }

  // → accepted: brief result, then success
  document.getElementById('resultPhoto').src = photoDataUrl;
  document.getElementById('resultLabel').textContent = data.status === 'approved' ? 'Verified and published' : 'Verified';
  document.getElementById('resultConfidence').textContent = data.site && data.site.reference
    ? `Matched to “${data.site.reference}” in the ASI register`
    : 'Checked against the ASI register';
  document.getElementById('resultSource').textContent = `Checked by Gemini (${data.model})`;
  const flagEl = document.getElementById('resultFlag');
  flagEl.hidden = !(data.warnings && data.warnings.length);
  flagEl.textContent = flagEl.hidden ? '' : '\u26a0 ' + data.warnings.join(' ');
  // restart the reveal animation each time
  [document.getElementById('resultLabel'), document.getElementById('resultConfidence'),
   document.getElementById('resultSource'), flagEl,
   document.getElementById('resultPhoto')].forEach(el => { el.style.animation = 'none'; el.offsetHeight; el.style.animation = ''; });
  showStage(stageResult);

  await new Promise(res => setTimeout(res, data.warnings && data.warnings.length ? 3200 : 1600));

  document.getElementById('successTitle').textContent = data.status === 'approved' ? 'Added to the public map' : 'Sent to the moderation queue';
  document.getElementById('successSub').textContent = data.message;
  renderChecks(document.getElementById('successChecks'), data.checks);
  showStage(stageSuccess);
  setPipelineStage(data.status === 'approved' ? 'map' : 'review');

  // reset form fields for next capture (entry is already saved)
  document.getElementById('siteName').value = '';
  document.getElementById('siteCategory').value = '';
  document.getElementById('siteNotes').value = '';
  document.getElementById('photoInput').value = '';
  document.getElementById('preview').style.display = 'none';
  document.getElementById('gpsStatus').textContent = 'Not captured yet';
  // contributor name is deliberately left as-is — the same person often
  // submits several sites in one visit and shouldn't have to retype it
  photoDataUrl = null; gps = null;
};

document.getElementById('addAnotherBtn').onclick = () => {
  showStage(stageForm);
  setPipelineStage('capture');
};
document.getElementById('viewModerationBtn').onclick = () => {
  showStage(stageForm); // reset so returning to Capture later shows the form, not the success screen
  goToTab('admin');
};

// ==========================================================================
// moderation
// ==========================================================================
const approveToast = document.getElementById('approveToast');
const approveToastText = document.getElementById('approveToastText');
let toastTimer = null;

async function renderAdmin() {
  const list = document.getElementById('adminList');
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    pendingCache = await fetchPending();
  } catch (err) {
    console.error(err);
    list.innerHTML = '<div class="empty">Could not load submissions — check your connection and Supabase config.</div>';
    return;
  }
  if (pendingCache.length === 0) { list.innerHTML = '<div class="empty">No submissions waiting for review.</div>'; return; }

  // look up the nearest known reference site for each submission, in parallel
  const matches = await Promise.all(
    pendingCache.map(e => fetchNearestReferenceSite(e.lat, e.lng).catch(() => null))
  );

  list.innerHTML = pendingCache.map((e, i) => {
    const dims = (e.width_px && e.height_px) ? `${e.width_px}×${e.height_px}px` : null;
    const acc = Number.isFinite(e.gps_accuracy_m) ? `±${Math.round(e.gps_accuracy_m)}m` : null;
    const pills = [
      e.sites && e.sites.category ? e.sites.category : null,
      e.contributor_name ? `by ${e.contributor_name}` : null,
      dims,
      acc
    ].filter(Boolean).map(t => `<span class="meta-pill muted">${esc(t)}</span>`).join('');
    const ver = e.verification || null;
    const verLine = ver
      ? `Verified: title match ${Math.round((ver.title_match_confidence || 0) * 100)}% · photo quality ${ver.quality_score || '?'}/10${Number.isFinite(e.distance_to_reference_m) ? ` · ${e.distance_to_reference_m}m from register location` : ' · <b>not matched to a register site</b>'}${ver.compared_with_photos ? ` · compared with ${ver.compared_with_photos} photo(s)` : ''}`
      : '';
    return `
    <div class="entry" data-id="${esc(e.id)}">
      <img src="${esc(e.photo_url)}" alt="">
      <div class="meta">
        <h4>${esc(e.sites ? e.sites.name : 'Unknown site')}</h4>
        <div class="status-line">${esc(e.notes) || '—'}</div>
        <div class="status-line">AI: "${esc(e.ai_label)}" · ${(e.ai_confidence * 100).toFixed(0)}% · ${esc(e.ai_source)}${e.ai_flagged ? ' · ⚠ quality flag' : ''}</div>
        ${verLine ? `<div class="status-line">${verLine}</div>` : ''}
        <div class="status-line">📍 ${e.lat.toFixed(4)}, ${e.lng.toFixed(4)} · ${new Date(e.created_at).toLocaleString()}</div>
        ${pills ? `<div class="meta-pills">${pills}</div>` : ''}
        ${renderReferenceMatch(matches[i])}
        <div class="row">
          <button class="btn-secondary" onclick="decide('${esc(e.id)}', 'approved')">Approve</button>
          <button class="btn-secondary" onclick="decide('${esc(e.id)}', 'rejected')">Reject</button>
        </div>
      </div>
    </div>
  `;
  }).join('');
}

function decide(id, status) {
  const e = pendingCache.find(e => e.id === id);
  if (!e) return;
  const row = document.querySelector(`.entry[data-id="${id}"]`);

  const finish = async () => {
    try {
      await updatePhotoStatus(id, status);
    } catch (err) {
      console.error(err);
      renderAdmin();
      return;
    }
    await renderAdmin();
    if (status === 'approved') {
      clearTimeout(toastTimer);
      approveToastText.textContent = `"${e.sites ? e.sites.name : 'Entry'}" approved and added to the public map.`;
      approveToast.hidden = false;
      toastTimer = setTimeout(() => { approveToast.hidden = true; }, 6000);
    }
  };

  if (row) {
    row.classList.add('leaving');
    row.addEventListener('transitionend', finish, { once: true });
    // fallback in case transitionend doesn't fire (e.g. reduced motion)
    setTimeout(finish, 400);
  } else {
    finish();
  }
}
window.decide = decide;

document.getElementById('toastViewMap').onclick = () => {
  approveToast.hidden = true;
  goToTab('map');
};
document.getElementById('toastDismiss').onclick = () => { approveToast.hidden = true; };

// ==========================================================================
// map
// ==========================================================================
const CATEGORY_COLORS = {
  'Fort': '#8B4A2B',
  'Temple': '#B8860B',
  'Stepwell / Baoli': '#2E7D4F',
  'Monument / Tomb': '#7D7266',
  'Palace / Haveli': '#A8402E',
  'Other': '#5B5148'
};
const DEFAULT_MARKER_COLOR = '#241C16';

function categoryIcon(category) {
  const color = CATEGORY_COLORS[category] || DEFAULT_MARKER_COLOR;
  return L.divIcon({
    className: '',
    html: `<span style="display:block;width:16px;height:16px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35);"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 16],
    popupAnchor: [0, -16]
  });
}

let leafletMap = null;
async function renderMap() {
  if (!leafletMap) {
    leafletMap = L.map('map').setView([22.9734, 78.6569], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      subdomains: 'abc',
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(leafletMap);
  }
  leafletMap.eachLayer(l => { if (l instanceof L.Marker) leafletMap.removeLayer(l); });

  try {
    approvedCache = await fetchApproved();
  } catch (err) {
    console.error(err);
    approvedCache = [];
  }

  approvedCache.forEach(e => {
    const category = e.sites ? e.sites.category : null;
    const byline = e.contributor_name ? `<br><span style="color:#7D7266;font-size:12px;">Documented by ${esc(e.contributor_name)}</span>` : '';
    L.marker([e.lat, e.lng], { icon: categoryIcon(category) }).addTo(leafletMap)
      .bindPopup(`<b>${esc(e.sites ? e.sites.name : '')}</b>${category ? ` <span style="color:#7D7266;font-size:12px;">· ${esc(category)}</span>` : ''}<br>${esc(e.notes)}<br><i>${esc(e.ai_label)}</i>${byline}<br><img src="${esc(e.photo_url)}" style="width:120px;border-radius:6px;margin-top:6px;">`);
  });
  setTimeout(() => leafletMap.invalidateSize(), 100);
}
