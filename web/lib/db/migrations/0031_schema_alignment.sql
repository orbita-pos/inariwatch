-- Fix schema/migration mismatches found in audit

-- 1. escalation_rules.channel_id — schema expects nullable (for on_call_primary/on_call_secondary targets)
--    but migration 0000 created it as NOT NULL
ALTER TABLE "escalation_rules" ALTER COLUMN "channel_id" DROP NOT NULL;

-- 2. organization_invites.invited_by — consolidate conflicting 0003 migrations
--    schema.ts expects NOT NULL, ensure it matches
ALTER TABLE "organization_invites" ALTER COLUMN "invited_by" SET NOT NULL;
