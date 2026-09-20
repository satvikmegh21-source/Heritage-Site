# Cultural Heritage Mapping System — Live Prototype

Static frontend (`index.html` + `styles.css` + `script.js` + `config.js`),
backed by a real [Supabase](https://supabase.com) project for storage and
the database, plus **one serverless function** (`api/verify-submission.js`)
that verifies every submission with Google Gemini, the ASI reference register
and the photos already on record *before* anything is saved. Photos,
coordinates, and moderation status persist in Supabase so they sync across
every device and moderator.

## File overview

| File | Purpose |
|---|---|
| `index.html` | Page structure |
| `styles.css` | All visual styling |
| `script.js` | App logic — GPS, AI screening, Supabase reads/writes, map |
| `config.js` | **Edit this one** — your Supabase project URL + anon key (public values only) |
| `api/verify-submission.js` | Serverless endpoint — the only path by which a submission reaches the database |
| `lib/pipeline.js` | The verification rules, in order (see "Image & location verification") |
| `lib/gemini.js` | Gemini calls (server-side; the API key never reaches the browser) |
| `lib/db.js` | Supabase reads/writes using the service-role key (server-side) |
| `test/pipeline.test.js` | `npm test` — 22 tests of the pipeline with Gemini/Supabase mocked |
| `dev-server.js` | `npm run dev` — local server for the app + API (reads `.env.local`) |
| `.env.example` | The server-side secrets/settings to add in Vercel |
| `supabase-schema.sql` | Run once in Supabase's SQL editor to create the tables/policies |
| `generate_asi_reference_sites.py` | Optional, run on your own machine (not deployed) to bulk-import the full ASI reference dataset |

## Set up Supabase (one-time)

1. **Create a project** at [supabase.com](https://supabase.com/dashboard) —
   free tier is enough for a prototype.
2. **Run the schema.** Open your project → *SQL Editor* → *New query* →
   paste in the entire contents of `supabase-schema.sql` → *Run*. This
   creates three tables:
   - `sites` — one row per heritage site: its name and an optional
     `category` (Fort, Temple, Stepwell/Baoli, Monument/Tomb, Palace/Haveli,
     Other), set the first time a site is submitted and never overwritten
     after that
   - `photos` — one row per submitted photo: which site it belongs to, the
     photo's storage path/URL, the lat/lng + GPS accuracy radius it was
     captured at, the photo's pixel dimensions, an optional contributor
     name, the AI screening result, and its moderation status
     (`pending` / `approved` / `rejected`) with a `reviewed_at` timestamp
   - `reference_sites` — known ASI-protected monuments (name, coordinates,
     district/state, and a reference photo where available) used to
     sanity-check submissions during moderation; see "Reference verification
     dataset" below — this table starts **empty**, you import the real data
     into it as a separate step
   
   This same file also creates a `nearest_reference_site()` database
   function, used to find the closest known site to any submitted
   coordinate.
3. **Create the storage bucket.** *Storage* → *New bucket* → name it exactly
   `heritage-photos` → toggle **Public bucket** on (so approved photos can
   be shown on the map without signing every URL) → *Create bucket*. The
   upload policy for this bucket is included at the bottom of
   `supabase-schema.sql` — make sure you ran the whole file, including that
   last part, after creating the bucket.
4. **Copy your API keys.** *Project Settings* → *API* → copy the **Project
   URL** and the **anon public** key (not the `service_role` key). Paste
   both into `config.js`:
   ```js
   window.SUPABASE_CONFIG = {
     url: 'https://your-project-ref.supabase.co',
     anonKey: 'your-anon-public-key',
     bucket: 'heritage-photos'
   };
   ```

That anon key is meant to be public and safe to ship in client-side code —
access control is enforced by the Row Level Security policies in the SQL
file, not by keeping the key secret. Just never put your `service_role` key
in `config.js`.

## Image & location verification (Gemini)

Every submission is sent to `POST /api/verify-submission`. The browser never
writes to Supabase directly. Checks run in this order; **the first failure
stops the pipeline, nothing is saved, and the contributor sees why** (their
form entries are kept so they can fix and retry):

| # | Check | If it fails |
|---|---|---|
| 0 | Photo is a real JPEG/PNG/WebP, and its exact bytes (SHA-256) aren't already in the archive | Rejected — duplicate |
| 1 | GPS fix is precise (default ≤ 1000 m accuracy). No fallback/demo coordinates exist any more | Rejected — capture GPS again |
| 2 | Candidate ASI register entries are found: those near the GPS fix + those with a similar name | Rejected — site not in register |
| 3 | **Gemini** looks at photo + title + notes: is it sharp and well lit? is it a heritage structure (not a selfie/screenshot)? does it match the title? which register entry is it? | Rejected — "upload a better image" / not a heritage site / title mismatch |
| 4 | Distance from the contributor's GPS to that register entry (default ≤ 1500 m, with GPS accuracy taken into account) | Rejected — "you are X km from the site" |
| 5 | **Gemini** compares the photo with trusted photos on record for that site (the register's own photo if one is on file + up to 3 previously *approved* submissions) | Near-duplicate → not stored. Clearly a different structure → rejected. A genuine new view → **added** |
| 6 | Notes: Gemini checks they are about the site (no spam, ads, links, contact details, abuse, gibberish, prompt-injection) | Notes are **dropped, photo still saved**, contributor is told |
| 7 | Saved: photo → Storage, row → `photos` with the full verification record | — |

If Gemini is unreachable the submission is **refused, not waved through**.
Passing submissions are saved as `pending` for a moderator by default; set
`AUTO_APPROVE=true` to publish fully-verified ones (register match, title
confidence ≥ 75 %, notes clean) straight to the map. Moderators see the
verification results (title match, quality score, distance, photos compared).

### Setup for verification

1. **Re-run `supabase-schema.sql`** (safe to re-run). It adds the new columns,
   the `reference_sites_within()` function, and **removes the old open
   "anon insert" policies** on `sites`, `photos` and the storage bucket —
   otherwise anyone could skip verification by calling Supabase directly with
   the public anon key.
2. **Get a Gemini API key** at https://aistudio.google.com/apikey.
3. **Add environment variables in Vercel** (Project → Settings → Environment
   Variables — see `.env.example`): `GEMINI_API_KEY`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`. The service-role key is in Supabase → Project
   Settings → API. **These are secrets: never put them in `config.js`,
   `script.js` or a public repo.** Redeploy after adding them.
4. Deploy with Option B or C below (Option A, dragging a folder onto the
   Vercel page, also works, but the folder must include `api/`, `lib/` and
   `package.json`). Local dev: put the three variables in `.env.local`, then `npm install && npm run dev` and open http://localhost:3000 (plain Node, no Vercel CLI needed).

Tunable via env vars: `MAX_DISTANCE_M`, `MAX_GPS_ACCURACY_M`, `GEMINI_MODEL`,
`AUTO_APPROVE`, `ALLOW_UNLISTED_SITES` (see `.env.example`).

**Limits to know about**
- The register (`reference_sites`) only contains ASI-protected monuments, and
  uses their formal legal names. A site that isn't in it (for example a local
  or state-protected site) is rejected as "site not in register" unless you set
  `ALLOW_UNLISTED_SITES=true`, in which case it is saved for moderators with
  no location verification.
- None of the 4,064 register rows has a photo, so comparison (check 5) uses
  earlier approved submissions. The first photo of a site has nothing to
  be compared with and is judged by Gemini's own knowledge of the site.
- GPS can be spoofed with developer tools or mock-location apps; these checks
  raise the effort required but don't make location proof absolute.
- Gemini is a judge, not an oracle: it can be wrong on obscure sites. That is
  why a human moderator remains the default final step.
- Photos are downscaled to ≤ 1600 px in the browser before upload (serverless
  request-size limit), so stored photos are not full resolution.
- Each submission makes 1–2 Gemini calls (paid usage). A small per-IP limit is
  built in; add a stronger one before going public.

## Reference verification dataset (heritage-site photo/location checking)

Beyond the `sites`/`photos` tables, there's a third table, `reference_sites`,
holding known ASI-protected monuments with their real coordinates. When a
moderator reviews a submission, the app looks up the closest catalogued
reference site to the submitted GPS coordinate and shows it alongside the
submission — a distance figure (and a photo, where one is on file), so a
submission whose GPS is nowhere near any known site gets flagged for extra
scrutiny rather than approved on trust.

**`reference_sites_seed.csv`** ships with this project and contains
**4,064 real ASI monuments across 29 states**, with genuine coordinates —
not hand-typed guesses. Its origin, honestly traced:
- The Archaeological Survey of India maintains an official monument layer
  on [Bhuvan](https://bhuvan.nrsc.gov.in), ISRO's geoportal.
- A public project, [answerquest/asi-monuments-xml2csv on GitHub](https://github.com/answerquest/asi-monuments-xml2csv),
  extracted that layer into a flat CSV.
- I downloaded that CSV directly, de-duplicated it, inferred a rough
  `category` for each row from keywords in its name (Fort/Temple/Stepwell
  etc. — about 2,300 of the 4,064 rows didn't match any keyword and are left
  uncategorised, which is fine since category isn't used by the
  distance-matching logic, only shown as extra context), and reshaped it to
  match this table's columns.
- I spot-checked this against the Taj Mahal coordinate I'd independently
  verified from Wikipedia earlier — the two were within ~20 metres of each
  other, which is a good sign for the dataset's overall quality, though I
  have **not** individually verified all 4,064 rows.

**What this dataset does *not* have: photos.** The Bhuvan/ASI export has no
public image links, so `image_url` is empty for all 4,064 rows — the
moderation panel will show the name, district/state, and distance, but no
reference photo, until you add one. If you specifically want photos for a
handful of major, well-known sites, `generate_asi_reference_sites.py` (run
on your own machine — it needs to reach `query.wikidata.org`, not reachable
from a sandboxed chat session) pulls a smaller set from Wikidata that
includes real, correctly-licensed Wikimedia Commons images. The two sources
are complementary: Bhuvan/ASI for comprehensive coverage, Wikidata for
photos of the famous sites people are most likely to actually submit.

**To load it:** Supabase dashboard → *Table Editor* → `reference_sites` →
*Insert* → *Import data from CSV* → select `reference_sites_seed.csv`. Run
`supabase-schema.sql` first so the table and its uniqueness constraint exist
(uniqueness is on name + coordinate together, since this real dataset
legitimately reuses generic names like "Old Fort" across different
districts — a plain unique-name constraint would reject the import).



## Deploying

**Deploy the whole project folder** (`index.html`, `styles.css`, `script.js`,
`config.js`, `package.json`, `vercel.json`, `api/`, `lib/`) — `config.js` has
to sit right next to `script.js`, and `api/` + `lib/` are the verification
function. Then add the environment variables from "Setup for verification".

**Option A — no account setup, fastest (2 minutes)**
1. Go to https://vercel.com/new
2. Drag this whole folder (with `config.js` already filled in) onto the page
3. Framework preset: "Other" / static — no build command needed
4. Click Deploy — live `*.vercel.app` URL in ~30 seconds

**Option B — Vercel CLI**
```bash
npm i -g vercel
cd heritage-mapping
vercel --prod
```

**Option C — GitHub**
1. Push this folder to a new GitHub repo (consider a `.gitignore` or a
   separate untracked config if you don't want your Supabase URL/key in a
   public repo — both are safe to expose to your own deployed site, but
   there's no reason to hand them to search engines either)
2. https://vercel.com/new → Import Git Repository → select it → Deploy

## After deploying

1. **Capture tab** — fill in a site name, add a photo, tap "Capture GPS",
   then "Run AI check & submit". It walks through Screening → result →
   success, and the photo is now uploaded to Supabase Storage with a row
   in `photos` pointing at it.
2. **Moderation tab** — approve or reject it. This flips the `status`
   column in Supabase.
3. **Public map tab** — approved entries are fetched live from Supabase and
   pinned on the map.

Open two browsers (or your phone and laptop) at once — a submission on one
device should show up in Moderation on the other, since it's no longer
per-device `localStorage`.

## What's real vs. what's a placeholder (say this plainly if asked)

| Piece | Status |
|---|---|
| GPS capture | Real — uses the browser's actual Geolocation API in high-accuracy mode, watching for a few seconds and keeping the best fix rather than the first one. On devices with no GPS chip (most laptops), the browser falls back to Wi-Fi/IP-based positioning, which can still be off by kilometers — that's a hardware limit, not something the app can fix. Test on a phone outdoors for a real GPS fix. |
| Photo capture | Real |
| AI verification | Real — Google Gemini (multimodal) judges photo quality, whether it shows a heritage structure, whether it matches the title, whether it duplicates photos on record, and whether the notes are on-topic. Runs server-side. The old on-device heuristic now only rejects images under 300 px before spending a request. Gemini can be wrong; a moderator is still the default last step. |
| Moderation queue | Real — backed by Supabase, `pending`/`approved`/`rejected` per photo |
| Map | Real — Leaflet + OpenStreetMap tiles, pins pulled live from Supabase |
| Data storage | Real — Supabase Postgres (`sites`, `photos`) + Supabase Storage for the image files, shared across every device |
| Site category, GPS accuracy, photo dimensions, contributor credit | Real — stored per photo/site and shown in Moderation and on the map (colour-coded markers by category) |
| Reference site verification | Real mechanism, real data — a live nearest-site lookup runs against 4,064 real ASI monument coordinates sourced from ISRO's Bhuvan portal (via a public GitHub extract), spot-checked against an independently verified Taj Mahal coordinate. None of these 4,064 rows have a reference photo, though (source data doesn't include one) — see "Reference verification dataset" above for the complementary Wikidata source that does. |
| Access control | **Submissions are locked down:** only the verification function (service-role key) can insert sites/photos or upload files. **Approve/reject is still open** — anyone who loads the page can flip a photo's status, since there's no login yet. Before wider use, add authenticated moderator accounts and restrict the `photos update` policy to them. |
| Offline support | None by design — submitting requires a live connection, since verification runs on a server. The connection pill still reflects real `navigator.onLine` state. |
| Pipeline UI, transitions, screening delay | Real interface state and real animation; the screening delay is a short deliberate pause so the step reads as work happening, not an artificial simulation of a result that isn't actually computed |

The honest framing for a progress review: capture → screening → moderation
→ map is now a real, persistent, multi-device pipeline. What's still ahead
for production is (1) authenticated moderator access instead of open
approve/reject, (2) stronger rate limiting, and (3) photos for the reference
register so comparison doesn't depend on earlier submissions.
