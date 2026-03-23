CREATE TABLE IF NOT EXISTS "rate_limits" (
  "key" text PRIMARY KEY NOT NULL,
  "count" integer NOT NULL DEFAULT 1,
  "window_start" timestamp with time zone NOT NULL DEFAULT now()
);
