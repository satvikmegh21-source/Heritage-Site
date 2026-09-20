'use strict';
// ---------------------------------------------------------------------------
// Database + storage access for the verification function. Uses the Supabase
// SERVICE-ROLE key (server-side only), which bypasses Row Level Security —
// that's what lets us close off direct anonymous inserts in supabase-schema.sql.
// ---------------------------------------------------------------------------
const { nameTokens, normalize } = require('./pipeline');

const REF_COLUMNS = 'id, name, state, district, category, lat, lng, image_url';
const MAX_REF_IMAGE_BYTES = 3 * 1024 * 1024;
const escapeLike = (s) => s.replace(/[\\%_]/g, m => '\\' + m);

async function fetchImage(url, timeoutMs = 8000) {
  try {
    let u = String(url).replace(/^http:\/\//i, 'https://');
    if (!/^https:\/\//i.test(u)) return null;
    // Wikimedia "Special:FilePath" links serve the full-size original; ask for a smaller one
    if (/Special:FilePath/i.test(u) && !u.includes('?')) u += '?width=1000';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(u, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'heritage-mapping-verifier/1.0 (student project)' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_REF_IMAGE_BYTES) return null;
    return { mime, data: buf };
  } catch { return null; }
}

function createDb(sb, bucket) {
  return {
    async findPhotoByHash(hash) {
      const { data, error } = await sb.from('photos').select('id').eq('image_sha256', hash).neq('status', 'rejected').limit(1);
      if (error) throw error;
      return data && data.length > 0;
    },

    async referenceWithin(lat, lng, radiusM, limit) {
      const { data, error } = await sb.rpc('reference_sites_within', { p_lat: lat, p_lng: lng, p_radius_m: radiusM, p_limit: limit });
      if (error) throw error;
      return data || [];
    },

    // tokens are [a-z0-9] only (see nameTokens), so they're safe inside a PostgREST or() filter
    async referenceByTokens(tokens) {
      if (!tokens.length) return [];
      const { data, error } = await sb.from('reference_sites').select(REF_COLUMNS)
        .or(tokens.map(t => `name.ilike.%${t}%`).join(',')).limit(60);
      if (error) throw error;
      const scored = (data || []).map(r => {
        const n = normalize(r.name);
        return { r, score: tokens.filter(t => n.includes(t)).length };
      }).sort((x, y) => y.score - x.score);
      return scored.slice(0, 8).map(x => x.r);
    },

    // trusted comparison photos: the register's own photo (if any) + already-approved submissions for this site
    async getReferenceImages(ref) {
      const out = [];
      if (ref.image_url) {
        const img = await fetchImage(ref.image_url);
        if (img) out.push({ label: 'official reference photo', ...img });
      }
      const { data, error } = await sb.from('photos').select('storage_path')
        .eq('reference_site_id', ref.id).eq('status', 'approved').order('created_at', { ascending: false }).limit(3);
      if (error) throw error;
      for (const row of data || []) {
        const { data: blob, error: dlErr } = await sb.storage.from(bucket).download(row.storage_path);
        if (dlErr || !blob) continue;
        const buf = Buffer.from(await blob.arrayBuffer());
        out.push({ label: 'approved photo already in the archive', mime: blob.type || 'image/jpeg', data: buf });
      }
      return out;
    },

    // reuse the site row for this register entry if one exists; never overwrite an existing category
    async getOrCreateSite(name, category, ref) {
      const cat = category || (ref && ref.category) || null;
      const setCategory = async (row) => {
        if (!row.category && cat) await sb.from('sites').update({ category: cat }).eq('id', row.id);
      };

      if (ref) {
        const { data, error } = await sb.from('sites').select('id, category').eq('reference_site_id', ref.id).limit(1).maybeSingle();
        if (error) throw error;
        if (data) { await setCategory(data); return data.id; }
      }

      const { data: byName, error: nameErr } = await sb.from('sites')
        .select('id, category, reference_site_id').ilike('name', escapeLike(name)).limit(1).maybeSingle();
      if (nameErr) throw nameErr;

      let finalName = name;
      if (byName) {
        if (!ref || !byName.reference_site_id || byName.reference_site_id === ref.id) {
          await setCategory(byName);
          if (ref && !byName.reference_site_id) await sb.from('sites').update({ reference_site_id: ref.id }).eq('id', byName.id);
          return byName.id;
        }
        // same name, different real-world site (e.g. "Old Fort" in two districts)
        finalName = `${name} (${ref.district || ref.state || ref.id.slice(0, 4)})`;
      }
      const { data: created, error: insErr } = await sb.from('sites')
        .insert({ name: finalName, category: cat, reference_site_id: ref ? ref.id : null }).select('id').single();
      if (insErr) throw insErr;
      return created.id;
    },

    async uploadPhoto(siteId, bytes, mime, hash) {
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      const path = `${siteId}/${Date.now()}-${hash.slice(0, 8)}.${ext}`;
      const { error } = await sb.storage.from(bucket).upload(path, bytes, { contentType: mime, upsert: false });
      if (error) throw error;
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return { path, url: data.publicUrl };
    },

    async insertPhoto(row) {
      const { error } = await sb.from('photos').insert(row);
      if (error) throw error;
    },

    async removePhoto(path) {
      await sb.storage.from(bucket).remove([path]);
    }
  };
}

module.exports = { createDb, nameTokens };
