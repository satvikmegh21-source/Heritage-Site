// ---------------------------------------------------------------------------
// Fill these in after creating your Supabase project (see README.md → "Set up
// Supabase" for the exact steps: create project → run supabase-schema.sql →
// create the storage bucket → copy these two values from
// Project Settings → API).
//
// Both values below are meant to be public and safe to ship in client-side
// code — Supabase's access control is enforced server-side by the Row Level
// Security policies in supabase-schema.sql, not by keeping this key secret.
// Never put your Supabase "service_role" key here — only the "anon public" one.
// ---------------------------------------------------------------------------
window.SUPABASE_CONFIG = {
  url: 'https://pvcepiwfmbfczxaiukwt.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2Y2VwaXdmbWJmY3p4YWl1a3d0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzMDA4MTAsImV4cCI6MjEwNDg3NjgxMH0.bpIJ4gZ01JWfjrPTowPloVexSnjmU9p_VKTXp-v-B5s',
  bucket: 'heritage-photos'
};
