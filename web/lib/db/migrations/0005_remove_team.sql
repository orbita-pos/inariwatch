-- Remove "team" plan: migrate any team users to pro, then drop the enum value.
UPDATE "users" SET "plan" = 'pro' WHERE "plan" = 'team';
ALTER TYPE "plan" RENAME TO "plan_old";
CREATE TYPE "plan" AS ENUM ('free', 'pro');
ALTER TABLE "users" ALTER COLUMN "plan" TYPE "plan" USING "plan"::text::"plan";
DROP TYPE "plan_old";
