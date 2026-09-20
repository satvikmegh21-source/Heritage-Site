'use strict';
// ---------------------------------------------------------------------------
// The verification pipeline. Pure orchestration: all I/O (database, storage,
// Gemini) comes in through `deps`, so it can be unit-tested without network.
//
// Order of checks (first failure stops the pipeline and nothing is saved):
//   0. input sanity + exact-duplicate photo (SHA-256)
//   1. GPS fix reliable enough
//   2. find candidate ASI reference sites (near the GPS fix + similar name)
//   3. Gemini: photo quality / is it a heritage site / does it match the title
//              / which register entry is it / are the notes acceptable
//   4. GPS distance to that register entry
//   5. Gemini: compare with photos already on record (same site? duplicate?)
//   6. notes: dropped (not failed) if Gemini says they're irrelevant/unsafe
//   7. save photo + row  (status 'pending', or 'approved' if AUTO_APPROVE)
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const CATEGORIES = ['Fort', 'Temple', 'Stepwell / Baoli', 'Monument / Tomb', 'Palace / Haveli', 'Other'];

function loadConfig(env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
  return {
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL || 'gemini-3.6-flash',
    supabaseUrl: env.SUPABASE_URL,
    supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: env.SUPABASE_BUCKET || 'heritage-photos',
    maxDistanceM: n(env.MAX_DISTANCE_M, 1500),          // how close you must be to the register coordinate
    maxGpsAccuracyM: n(env.MAX_GPS_ACCURACY_M, 1000),   // reject fixes vaguer than this (Wi-Fi/IP positioning)
    minTitleConfidence: n(env.MIN_TITLE_CONFIDENCE, 0.5),
    minQualityScore: n(env.MIN_QUALITY_SCORE, 4),       // Gemini's 1-10 sharpness/quality score
    duplicateConfidence: n(env.DUPLICATE_CONFIDENCE, 0.8),
    mismatchConfidence: n(env.SITE_MISMATCH_CONFIDENCE, 0.7),
    autoApprove: String(env.AUTO_APPROVE || 'false').toLowerCase() === 'true',
    allowUnlistedSites: String(env.ALLOW_UNLISTED_SITES || 'false').toLowerCase() === 'true',
    maxImageBytes: 3 * 1024 * 1024
  };
}

function missingEnv(cfg) {
  return [
    !cfg.geminiApiKey && 'GEMINI_API_KEY',
    !cfg.supabaseUrl && 'SUPABASE_URL',
    !cfg.supabaseServiceKey && 'SUPABASE_SERVICE_ROLE_KEY'
  ].filter(Boolean);
}

// ---------- small helpers ----------
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const STOPWORDS = new Set(['the', 'of', 'and', 'in', 'at', 'near', 'fort', 'temple', 'tomb', 'monument', 'monuments', 'ruins',
  'site', 'old', 'ancient', 'mosque', 'masjid', 'palace', 'haveli', 'gate', 'group', 'mahal', 'baoli', 'stepwell', 'its', 'ki', 'ka', 'ke']);

function normalize(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// distinctive words of a title, used to search the register by name
function nameTokens(name) {
  const all = [...new Set(normalize(name).split(' ').filter(t => t.length >= 3))];
  const distinctive = all.filter(t => !STOPWORDS.has(t));
  return (distinctive.length ? distinctive : all).sort((a, b) => b.length - a.length).slice(0, 4);
}

function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function parseImage(input, cfg) {
  const dataUrl = typeof input === 'string' ? input : '';
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return { error: 'The photo could not be read. Please choose it again.' };
  const header = dataUrl.slice(5, comma);
  if (!header.endsWith(';base64')) return { error: 'The photo could not be read. Please choose it again.' };
  const claimed = header.slice(0, -7).toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(claimed)) return { error: 'Only JPEG, PNG or WebP photos are supported.' };
  const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  if (bytes.length < 1000) return { error: 'The photo looks empty or corrupted.' };
  if (bytes.length > cfg.maxImageBytes) return { error: 'The photo is too large. Please choose a smaller one.' };
  // trust magic bytes, not the claimed mime type
  let mime = null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg';
  else if (bytes.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) mime = 'image/png';
  else if (bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP') mime = 'image/webp';
  if (!mime) return { error: 'That file is not a valid image.' };
  return { bytes, mime };
}

function validateInput(input, cfg) {
  if (!input || typeof input !== 'object') return { error: 'Empty request.' };
  const name = cleanText(input.name, 120);
  if (name.length < 2) return { error: 'Please enter the site name.' };
  const notes = cleanText(input.notes, 1000);
  const contributorName = cleanText(input.contributorName, 80);
  const category = CATEGORIES.includes(input.category) ? input.category : null;

  const g = input.gps || {};
  const lat = Number(g.lat), lng = Number(g.lng);
  const accuracy = g.accuracy === null || g.accuracy === undefined ? NaN : Number(g.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { error: 'A valid GPS location is required.' };
  }
  const img = parseImage(input.image, cfg);
  if (img.error) return { error: img.error };

  const dim = (v) => (Number.isInteger(v) && v > 0 && v < 20000 ? v : null);
  return { value: { name, category, notes, contributorName, gps: { lat, lng, accuracy }, image: img, width: dim(input.width), height: dim(input.height) } };
}

const kmText = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

// ---------- the pipeline ----------
async function runPipeline(input, deps, cfg) {
  const checks = [];
  const pass = (id, label, detail) => checks.push({ id, label, status: 'pass', detail: detail || '' });
  const warn = (id, label, detail) => checks.push({ id, label, status: 'warn', detail: detail || '' });
  const reject = (status, code, message, id, label, extra = {}) => {
    checks.push({ id, label, status: 'fail', detail: message });
    return { status, body: { ok: false, code, message, checks, ...extra } };
  };
  const aiDown = (err) => {
    console.error('AI/verification error:', err);
    return { status: 502, body: { ok: false, code: 'ai_unavailable', checks,
      message: 'The verification service is temporarily unavailable, so nothing was saved. Please try again in a minute.' } };
  };

  // 0 ── input + exact duplicate ───────────────────────────────────────────
  const v = validateInput(input, cfg);
  if (v.error) return { status: 400, body: { ok: false, code: 'invalid_input', message: v.error, checks } };
  const { name, category, notes, contributorName, gps, image, width, height } = v.value;

  const hash = crypto.createHash('sha256').update(image.bytes).digest('hex');
  if (await deps.db.findPhotoByHash(hash)) {
    return reject(409, 'duplicate_image', 'This exact photo has already been submitted, so it was not added again.',
      'duplicate', 'Photo not already in the archive');
  }
  pass('duplicate', 'Photo not already in the archive');

  // 1 ── GPS reliability ────────────────────────────────────────────────────
  if (!Number.isFinite(gps.accuracy) || gps.accuracy > cfg.maxGpsAccuracyM) {
    return reject(422, 'gps_unreliable',
      `Your location fix is too imprecise (${Number.isFinite(gps.accuracy) ? '±' + kmText(gps.accuracy) : 'accuracy unknown'}) to confirm you are at the site. ` +
      'Please capture GPS again outdoors, ideally on a phone with location set to high accuracy.',
      'gps_accuracy', 'GPS fix is precise enough');
  }
  pass('gps_accuracy', 'GPS fix is precise enough', `±${Math.round(gps.accuracy)} m`);

  // 2 ── candidate register entries: near the GPS fix + similar name ───────
  const radius = cfg.maxDistanceM + Math.min(gps.accuracy, cfg.maxGpsAccuracyM);
  let near = [], byName = [];
  try {
    [near, byName] = await Promise.all([
      deps.db.referenceWithin(gps.lat, gps.lng, radius, 10),
      deps.db.referenceByTokens(nameTokens(name))
    ]);
  } catch (err) { return aiDown(err); }

  const merged = new Map();
  [...near, ...byName].forEach(r => {
    if (!merged.has(r.id)) merged.set(r.id, { ...r, distance_m: haversineM(gps.lat, gps.lng, r.lat, r.lng) });
  });
  const candidates = [...merged.values()].sort((a, b) => a.distance_m - b.distance_m).slice(0, 15)
    .map((c, i) => ({ ...c, code: `C${i + 1}` }));

  if (candidates.length === 0 && !cfg.allowUnlistedSites) {
    return reject(422, 'site_unknown',
      `We couldn't find a registered heritage site called “${name}” at or near your location, so this submission can't be verified.`,
      'site_lookup', 'Site found in the ASI register');
  }

  // 3 ── Gemini: quality + content + title + notes ─────────────────────────
  let a;
  try {
    a = await deps.gemini.analyze({ title: name, notes, candidates, image });
  } catch (err) { return aiDown(err); }

  if (a.is_blurry || a.is_too_dark || a.quality_score < cfg.minQualityScore) {
    const why = a.is_too_dark ? 'too dark' : 'too blurry or unclear';
    return reject(422, 'image_blurry',
      `This photo is ${why} to verify. Please upload a better image — hold the camera steady, use good light, and frame the whole structure.` +
      (a.quality_advice ? ` Tip: ${a.quality_advice}` : ''),
      'quality', 'Photo is sharp enough', { advice: a.quality_advice });
  }
  pass('quality', 'Photo is sharp enough', `${a.quality_score}/10`);

  if (!a.shows_heritage_structure || a.image_kind !== 'heritage_structure') {
    const kinds = { person_or_selfie: 'a person/selfie', screenshot_or_screen_photo: 'a screenshot or a photo of a screen',
      document_or_text: 'a document or text', object: 'an object', other_place: 'a place that isn\'t a heritage structure', unclear: 'unclear' };
    return reject(422, 'not_heritage_image',
      `This doesn't look like a photo of a heritage site (it appears to be ${kinds[a.image_kind] || 'something else'}). Please upload a photo of the site itself.`,
      'content', 'Photo shows a heritage structure');
  }
  pass('content', 'Photo shows a heritage structure');

  if (!a.title_matches_image || a.title_match_confidence < cfg.minTitleConfidence) {
    return reject(422, 'title_mismatch',
      `The photo doesn't appear to match the title “${name}”.` +
      (a.identified_site ? ` It looks more like: ${a.identified_site}.` : '') + ' Please check the site name or upload the correct photo.',
      'title', 'Photo matches the site title');
  }
  pass('title', 'Photo matches the site title', `${Math.round(a.title_match_confidence * 100)}% confidence`);

  // 4 ── which register entry, and is the contributor actually there? ─────
  const ref = candidates.find(c => c.code === a.matched_candidate) || null;
  let distanceM = null;
  if (!ref) {
    if (!cfg.allowUnlistedSites) {
      return reject(422, 'site_unknown',
        `“${name}” doesn't match any registered site near your location, so we can't confirm you are at that site.`,
        'site_lookup', 'Site found in the ASI register');
    }
    warn('site_lookup', 'Site not in the ASI register', 'Location could not be verified against a known site — a moderator will review it.');
  } else {
    pass('site_lookup', 'Site found in the ASI register', [ref.name, ref.district, ref.state].filter(Boolean).join(', '));
    distanceM = ref.distance_m;
    const effective = distanceM - Math.min(gps.accuracy, cfg.maxGpsAccuracyM);
    if (effective > cfg.maxDistanceM) {
      return reject(422, 'gps_too_far',
        `Your location is ${kmText(distanceM)} from ${ref.name}. You need to be at the site (within about ${kmText(cfg.maxDistanceM)}) to add information about it, so nothing was saved.`,
        'gps_distance', 'You are at the site', { distance_m: Math.round(distanceM) });
    }
    pass('gps_distance', 'You are at the site', `${kmText(distanceM)} from the register location`);
  }

  // 5 ── compare against photos on record ──────────────────────────────────
  let compared = 0;
  if (ref) {
    let refs = [];
    try { refs = await deps.db.getReferenceImages(ref); } catch (err) { console.error('reference images:', err); }
    if (refs.length) {
      let c;
      try { c = await deps.gemini.compare({ image, references: refs }); } catch (err) { return aiDown(err); }
      compared = refs.length;
      if (c.is_duplicate && c.duplicate_confidence >= cfg.duplicateConfidence) {
        return reject(409, 'duplicate_image',
          'A photo very similar to this one is already on record for this site, so it was not added again. Try a different angle or viewpoint if you want to contribute more.',
          'reference_photo', 'Photo adds something new');
      }
      if (!c.same_site && c.same_site_confidence >= cfg.mismatchConfidence) {
        return reject(422, 'site_mismatch',
          `This photo doesn't look like the photos on record for ${ref.name}. ${c.explanation}`.trim(),
          'reference_photo', 'Photo consistent with photos on record');
      }
      pass('reference_photo', 'New view of a site already on record', `compared with ${refs.length} photo${refs.length > 1 ? 's' : ''}`);
    } else {
      pass('reference_photo', 'First photo for this site', 'No earlier photo to compare with');
    }
  }

  // 6 ── notes (dropped, not rejected, when unsuitable) ────────────────────
  let notesToStore = notes || null;
  const warnings = [];
  if (notes) {
    if (!a.notes_relevant || !a.notes_acceptable) {
      notesToStore = null;
      const msg = `Your notes weren't added: ${a.notes_reason || 'they don\'t seem to be about this site'}.`;
      warn('notes', 'Notes are relevant to the site', msg);
      warnings.push(msg);
    } else {
      pass('notes', 'Notes are relevant to the site');
    }
  }

  // 7 ── save ──────────────────────────────────────────────────────────────
  const verified = !!ref && warnings.length === 0 && a.title_match_confidence >= 0.75;
  const status = cfg.autoApprove && verified ? 'approved' : 'pending';

  let uploaded = null;
  try {
    const siteId = await deps.db.getOrCreateSite(name, category, ref);
    uploaded = await deps.db.uploadPhoto(siteId, image.bytes, image.mime, hash);
    await deps.db.insertPhoto({
      site_id: siteId,
      storage_path: uploaded.path,
      photo_url: uploaded.url,
      notes: notesToStore,
      lat: gps.lat,
      lng: gps.lng,
      gps_accuracy_m: gps.accuracy,
      width_px: width,
      height_px: height,
      contributor_name: contributorName || null,
      ai_label: a.identified_site || 'Heritage structure',
      ai_confidence: a.title_match_confidence,
      ai_flagged: false,
      ai_source: `Gemini (${cfg.geminiModel})`,
      status,
      image_sha256: hash,
      reference_site_id: ref ? ref.id : null,
      distance_to_reference_m: distanceM === null ? null : Math.round(distanceM),
      verification: {
        model: cfg.geminiModel,
        title_match_confidence: a.title_match_confidence,
        quality_score: a.quality_score,
        identified_site: a.identified_site,
        reasoning: a.reasoning,
        compared_with_photos: compared,
        notes_dropped: notes && !notesToStore ? a.notes_reason : null,
        checks: checks.map(c => ({ id: c.id, status: c.status, detail: c.detail }))
      },
      ...(status === 'approved' ? { reviewed_at: new Date().toISOString() } : {})
    });
  } catch (err) {
    console.error('save error:', err);
    if (uploaded) await deps.db.removePhoto(uploaded.path).catch(() => {});
    return { status: 500, body: { ok: false, code: 'save_failed', checks,
      message: 'Your submission passed verification but could not be saved. Please try again.' } };
  }

  pass('save', 'Saved', status === 'approved' ? 'published to the map' : 'sent to the moderation queue');
  return {
    status: 200,
    body: {
      ok: true, status, checks, warnings,
      model: cfg.geminiModel,
      site: { name, reference: ref ? ref.name : null },
      notes_saved: !!notesToStore,
      message: status === 'approved'
        ? `“${name}” was verified and added to the public map.`
        : `“${name}” was verified and is waiting for a moderator's final approval.`
    }
  };
}

module.exports = { runPipeline, loadConfig, missingEnv, haversineM, nameTokens, normalize, validateInput, CATEGORIES };
