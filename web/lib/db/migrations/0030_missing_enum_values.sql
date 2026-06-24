-- Add enum values that were added to schema.ts but never migrated

-- notification_type: 'push' was added for web push notifications
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'push';

-- integration: 'datadog', 'uptime', 'expo' were added for new integrations
ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'datadog';
ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'uptime';
ALTER TYPE "integration" ADD VALUE IF NOT EXISTS 'expo';
