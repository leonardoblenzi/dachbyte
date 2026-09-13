-- VoltChat 0.1.37: o updater passa a usar exclusivamente Cloudflare R2.
-- Remove definitivamente os payloads e metadados de release do Neon.
DROP TABLE IF EXISTS desktop_release_chunks;
DROP TABLE IF EXISTS desktop_releases;
