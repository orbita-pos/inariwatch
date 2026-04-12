-- Add hosting-platform integration values so users can connect Netlify,
-- Cloudflare Pages, Render, Railway, and Fly.io alongside Vercel.
--
-- Provider implementations live in web/lib/providers/rollback/.
-- Vercel, Netlify, Cloudflare Pages, and Render are fully implemented.
-- Railway and Fly ship as stubs that throw UnsupportedProviderError until
-- someone asks for them.

ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'netlify';
ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'cloudflare-pages';
ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'render';
ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'railway';
ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'fly';
