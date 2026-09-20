'use strict';
// POST /api/verify-submission
// The ONLY way a submission reaches the database. Runs the Gemini + GPS +
// duplicate checks (see lib/pipeline.js) and saves only if they pass.
const { createClient } = require('@supabase/supabase-js');
const { runPipeline, loadConfig, missingEnv } = require('../lib/pipeline');
const { createDb } = require('../lib/db');
const { analyzeSubmission, compareWithReferences } = require('../lib/gemini');

// Best-effort abuse brake (each Gemini call costs money). In-memory, so it's
// per warm serverless instance — fine for a prototype, use Upstash/Vercel KV
// or Vercel's WAF rate limiting if this goes public.
const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000, MAX_HITS = 8;
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > MAX_HITS;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, code: 'method_not_allowed', message: 'Use POST.' });
  }

  const cfg = loadConfig(process.env);
  const missing = missingEnv(cfg);
  if (missing.length) {
    console.error('Missing environment variables:', missing.join(', '));
    return res.status(500).json({ ok: false, code: 'server_misconfigured', message: 'The server is not configured yet (missing environment variables).' });
  }

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, code: 'rate_limited', message: 'Too many submissions from your connection. Please wait a few minutes and try again.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const sb = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, { auth: { persistSession: false } });
    const gem = { apiKey: cfg.geminiApiKey, model: cfg.geminiModel };
    const deps = {
      db: createDb(sb, cfg.bucket),
      gemini: {
        analyze: (args) => analyzeSubmission(args, gem),
        compare: (args) => compareWithReferences(args, gem)
      }
    };
    const { status, body: out } = await runPipeline(body, deps, cfg);
    return res.status(status).json(out);
  } catch (err) {
    console.error('verify-submission failed:', err);
    return res.status(500).json({ ok: false, code: 'server_error', message: 'Something went wrong on our side. Nothing was saved — please try again.' });
  }
};
