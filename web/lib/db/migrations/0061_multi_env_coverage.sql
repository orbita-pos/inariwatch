-- VAR Q2 Week 8 — Gate 16 "Multi-Environment Coverage"
--
-- Detects when a fix was verified against only a subset of the Node
-- runtime versions actively running in production. Evidence-based: we
-- don't trust package.json declarations. We compare the runtime env
-- distribution observed in substrate_recordings (what the project
-- ACTUALLY runs) against the env distribution of the fleet sessions
-- that Gate 12 replayed the fix against.
--
-- If a major Node version carries >20% of project traffic but the fleet
-- replay missed it entirely, that is a HIGH-severity coverage gap and
-- the gate fails. 10-20% traffic is MEDIUM — surfaced to the reviewer
-- but does NOT fail the merge (yellow-light, same spirit as Gate 13
-- improvements and Gate 15 compliance medium findings).
--
-- Why this shape (not CI matrix):
--   A CI-generated matrix (node-version: [18, 20, 22]) is the ideal
--   runtime-verification approach but requires the repo to have CI +
--   tests configured. Not every InariWatch user has that. The
--   empirical-coverage check works for every user whose SDK is
--   emitting env context — zero infra required.
--
-- Depends on Gate 12 (fleet_verification_runs). If that run is still
-- 'running' or the fleet_verification_runs row doesn't exist, Gate 16
-- marks itself 'skipped' with reason, passed=null. Auto-merge treats
-- null as SKIP (same contract as Gate 13/17).
--
-- Full env vectors are persisted too (observed_env_vectors jsonb) so
-- future gate logic can extend to platform/arch/app_version without a
-- new migration. v1 only scores on Node major.
--
-- Reverse:
--   DROP TABLE IF EXISTS multi_env_coverage_runs

CREATE TABLE IF NOT EXISTS multi_env_coverage_runs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id                    uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  remediation_id              uuid NOT NULL REFERENCES remediation_sessions(id) ON DELETE CASCADE,
  fix_commit_sha              text NOT NULL,
  bullmq_job_id               text,

  -- Rolling window used to build the project env distribution. 30d
  -- default matches the substrate_recordings retention horizon.
  window_days                 integer NOT NULL DEFAULT 30,

  -- Traffic thresholds (traffic %). An env present in project but
  -- absent in fleet above threshold_high_percent is a HIGH-severity
  -- miss (fails the gate). Between medium and high is MEDIUM
  -- (surfaces but does not fail). Below medium is LOW and ignored.
  threshold_high_percent      numeric NOT NULL DEFAULT 20,
  threshold_medium_percent    numeric NOT NULL DEFAULT 10,

  -- Distributions keyed by node major (example "node@18", "node@20").
  -- Shape per entry:
  --   { "node@18": { "trafficPercent": 45.2, "sessionCount": 180 } }
  project_env_distribution    jsonb NOT NULL DEFAULT '{}'::jsonb,
  fleet_env_distribution      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Envs that exist in project but not in fleet, classified by
  -- project traffic percent. Both arrays sorted by traffic desc.
  missing_envs_high           text[] NOT NULL DEFAULT '{}',
  missing_envs_medium         text[] NOT NULL DEFAULT '{}',

  -- Traffic-weighted coverage, in [0, 100]. Sum of project traffic
  -- percent for every env key that is present in both distributions.
  -- Null when project distribution is empty (single-env skip path).
  coverage_percent            numeric,

  -- Full observed env vectors for future gate logic (platform, arch,
  -- app_version). v1 scoring only uses node major but the data lives
  -- here so Gate 16 v2 / Gate 14 can consume without a migration.
  -- Shape:
  --   [{ "node": "v20.11.1", "nodeMajor": 20, "platform": "linux",
  --      "arch": "x64", "appVersion": "3.2.1", "sessionCount": 42 }]
  observed_env_vectors        jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Gate outcome. passed=null when the gate was skipped (single env,
  -- no env data, or fleet run not complete yet) — auto-merge SKIPS
  -- on null, does NOT fail. Matches Gate 13/17 contract.
  passed                      boolean,

  -- Lifecycle. Possible values: running | completed | failed | skipped.
  -- "skipped" is a successful outcome meaning "gate did not apply" —
  -- skip_reason explains why (single-env, fleet-incomplete, no-env-data).
  status                      text NOT NULL DEFAULT 'running',
  skip_reason                 text,
  error                       text,

  started_at                  timestamptz NOT NULL DEFAULT now(),
  completed_at                timestamptz,

  CONSTRAINT multi_env_coverage_runs_unique
    UNIQUE (alert_id, remediation_id, fix_commit_sha)
);

-- Hot path — alert detail page reads "latest multi-env run for alert".
-- Same access pattern as fleet_verification_runs_alert_idx.
CREATE INDEX IF NOT EXISTS multi_env_coverage_runs_alert_idx
  ON multi_env_coverage_runs (alert_id, started_at DESC);

-- Admin/ops view — running jobs only. Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS multi_env_coverage_runs_running_idx
  ON multi_env_coverage_runs (status)
  WHERE status = 'running';

COMMENT ON TABLE multi_env_coverage_runs IS
  'VAR Gate 16. Compares fix-replay env distribution (fleet sessions replayed by Gate 12) against project-wide runtime env distribution from substrate_recordings. One row per (alert, remediation, fix_commit_sha). passed=null means SKIP — single-env project, fleet run not complete, or no env data. Auto-merge treats null as skip, not fail.';

COMMENT ON COLUMN multi_env_coverage_runs.project_env_distribution IS
  'Env distribution across all healthy substrate_recordings for the project in the rolling window. Keyed by node major (example node@18). Value shape: { trafficPercent, sessionCount }.';

COMMENT ON COLUMN multi_env_coverage_runs.missing_envs_high IS
  'Node majors present in project distribution with >threshold_high_percent traffic but absent from fleet distribution. A non-empty array fails the gate.';

COMMENT ON COLUMN multi_env_coverage_runs.missing_envs_medium IS
  'Node majors between threshold_medium_percent and threshold_high_percent traffic that are absent from fleet. Yellow-light — surfaced but never fails.';

COMMENT ON COLUMN multi_env_coverage_runs.observed_env_vectors IS
  'Full env vectors (node, nodeMajor, platform, arch, appVersion, sessionCount) from fleet sessions. Stored for future gate logic on platform/arch/framework — v1 scoring only uses node major.';

COMMENT ON COLUMN multi_env_coverage_runs.status IS
  'running | completed | failed | skipped. "skipped" is a success outcome meaning the gate did not apply (see skip_reason). passed is null in that case. Auto-merge treats null as skip.';
