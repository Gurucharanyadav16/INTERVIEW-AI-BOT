-- =============================================================================
-- InterviewFlow AI — Complete PostgreSQL & Supabase Schema Migration
-- File: supabase/migrations/001_initial_schema.sql
-- Covers 20 core tables, enums, indexes, constraints, audit triggers, and RLS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Enums for strict state machine and role enforcement
CREATE TYPE user_role AS ENUM ('ADMIN', 'INTERVIEWER', 'CANDIDATE');

CREATE TYPE workflow_state AS ENUM (
  'REGISTERED',
  'ATTENDANCE_PENDING',
  'ATTENDANCE_CONFIRMED',
  'TASK_ASSIGNED',
  'SUBMITTED',
  'REVIEW_PENDING',
  'AI_REVIEW_COMPLETED',
  'FEEDBACK_SENT',
  'CORRECTION_REQUIRED',
  'RESUBMISSION_RECEIVED',
  'NEXT_REVIEW_SCHEDULED',
  'READY_FOR_HUMAN_EVALUATION',
  'MANUAL_REVIEW_REQUIRED',
  'COMPLETED',
  'WITHDRAWN'
);

CREATE TYPE attendance_status AS ENUM ('PENDING', 'CONFIRMED', 'ABSENT', 'MANUAL_OVERRIDE');
CREATE TYPE attendance_source AS ENUM ('MANUAL_ADMIN', 'CSV_IMPORT', 'GOOGLE_MEET_API', 'ADMIN_OVERRIDE');
CREATE TYPE difficulty_level AS ENUM ('JUNIOR', 'MID', 'SENIOR', 'STAFF');
CREATE TYPE finding_severity AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'POSITIVE');
CREATE TYPE verification_type AS ENUM ('TEST_EXECUTED', 'STATIC_ANALYSIS', 'SOURCE_INSPECTION', 'RUNTIME_REQUIRED', 'UNVERIFIED');
CREATE TYPE email_status AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'QUEUED', 'SENT_ACCEPTED', 'DELIVERED', 'FAILED', 'SUPPRESSED_TEST_MODE');
CREATE TYPE job_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRY_SCHEDULED', 'CANCELLED');

-- 2. User Profiles & Roles (linked to auth.users in Supabase)
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id UUID UNIQUE,
  email TEXT UNIQUE NOT NULL CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  full_name TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'CANDIDATE',
  department TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Recruitment Batches
CREATE TABLE recruitment_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  target_role TEXT NOT NULL,
  required_technologies TEXT[] NOT NULL DEFAULT '{}',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  google_meet_url TEXT,
  google_calendar_event_id TEXT,
  assignment_deadline_hours INT NOT NULL DEFAULT 48,
  correction_deadline_hours INT NOT NULL DEFAULT 24,
  max_review_rounds INT NOT NULL DEFAULT 3 CHECK (max_review_rounds BETWEEN 1 AND 10),
  max_resubmissions INT NOT NULL DEFAULT 3 CHECK (max_resubmissions BETWEEN 1 AND 10),
  passing_score_threshold NUMERIC(5,2) NOT NULL DEFAULT 75.00 CHECK (passing_score_threshold BETWEEN 0 AND 100),
  require_admin_task_approval BOOLEAN NOT NULL DEFAULT FALSE,
  require_admin_email_approval BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED')),
  created_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Candidates
CREATE TABLE candidates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_code TEXT UNIQUE NOT NULL,
  user_profile_id UUID UNIQUE REFERENCES user_profiles(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  job_role TEXT NOT NULL,
  skills TEXT[] NOT NULL DEFAULT '{}',
  experience_level difficulty_level NOT NULL DEFAULT 'JUNIOR',
  experience_years NUMERIC(4,1) NOT NULL DEFAULT 1.0,
  primary_batch_id UUID REFERENCES recruitment_batches(id) ON DELETE SET NULL,
  attendance attendance_status NOT NULL DEFAULT 'PENDING',
  attendance_evidence_source attendance_source,
  attendance_verified_at TIMESTAMPTZ,
  attendance_verified_by UUID REFERENCES user_profiles(id),
  attendance_override_reason TEXT,
  workflow_status workflow_state NOT NULL DEFAULT 'REGISTERED',
  current_review_round INT NOT NULL DEFAULT 0,
  assigned_interviewer_id UUID REFERENCES user_profiles(id),
  human_evaluation_decision TEXT CHECK (human_evaluation_decision IN ('PENDING', 'RECOMMEND_HIRE', 'HOLD', 'DO_NOT_PROCEED')),
  human_evaluation_notes TEXT,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_candidates_batch ON candidates(primary_batch_id);
CREATE INDEX idx_candidates_workflow_status ON candidates(workflow_status);
CREATE INDEX idx_candidates_email ON candidates(email);

-- 5. Batch Memberships
CREATE TABLE batch_memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_id UUID NOT NULL REFERENCES recruitment_batches(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(batch_id, candidate_id)
);

-- 6. Interview Sessions (Orientation & Review Sessions)
CREATE TABLE interview_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_code TEXT UNIQUE NOT NULL,
  batch_id UUID NOT NULL REFERENCES recruitment_batches(id) ON DELETE CASCADE,
  candidate_id UUID REFERENCES candidates(id) ON DELETE SET NULL,
  interviewer_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  session_type TEXT NOT NULL CHECK (session_type IN ('BATCH_ORIENTATION', 'INDIVIDUAL_REVIEW', 'GROUP_REVIEW')),
  session_date DATE NOT NULL,
  start_time TIME NOT NULL,
  duration_minutes INT NOT NULL DEFAULT 30,
  buffer_minutes INT NOT NULL DEFAULT 10,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  max_group_size INT NOT NULL DEFAULT 1,
  google_meet_url TEXT,
  google_calendar_event_id TEXT,
  conference_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  session_status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (session_status IN ('PENDING_CONFERENCE', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'RESCHEDULED', 'CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_interview_sessions_batch ON interview_sessions(batch_id);
CREATE INDEX idx_interview_sessions_candidate ON interview_sessions(candidate_id);

-- 7. Interviewer Availability
CREATE TABLE interviewer_availability (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  interviewer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  available_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  slot_duration_minutes INT NOT NULL DEFAULT 30,
  buffer_minutes INT NOT NULL DEFAULT 10,
  is_booked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Task Templates (Administrator-Approved Task Bank)
CREATE TABLE task_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  job_role TEXT NOT NULL,
  primary_technology TEXT NOT NULL,
  programming_language TEXT NOT NULL,
  difficulty difficulty_level NOT NULL,
  skills_evaluated TEXT[] NOT NULL DEFAULT '{}',
  estimated_hours NUMERIC(4,1) NOT NULL DEFAULT 6.0,
  problem_statement TEXT NOT NULL,
  business_scenario TEXT NOT NULL,
  objective TEXT NOT NULL,
  functional_requirements JSONB NOT NULL DEFAULT '[]',
  non_functional_requirements JSONB NOT NULL DEFAULT '[]',
  deliverables JSONB NOT NULL DEFAULT '[]',
  acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  testing_requirements JSONB NOT NULL DEFAULT '[]',
  scoring_rubric JSONB NOT NULL DEFAULT '{"functional_correctness":40,"code_quality":20,"testing_edge_cases":20,"documentation":10,"security_error_handling":10}',
  is_approved BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by UUID REFERENCES user_profiles(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  current_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Task Versions (Immutable Versioned Snapshots & Controlled Variants)
CREATE TABLE task_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  variant_key TEXT NOT NULL,
  title TEXT NOT NULL,
  problem_statement TEXT NOT NULL,
  business_scenario TEXT NOT NULL,
  step_by_step_instructions JSONB NOT NULL DEFAULT '[]',
  expected_output TEXT NOT NULL,
  functional_requirements JSONB NOT NULL DEFAULT '[]',
  non_functional_requirements JSONB NOT NULL DEFAULT '[]',
  acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  testing_requirements JSONB NOT NULL DEFAULT '[]',
  scoring_rubric JSONB NOT NULL,
  ai_mentor_explanation JSONB NOT NULL,
  comparability_validated BOOLEAN NOT NULL DEFAULT TRUE,
  comparability_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(template_id, version_number, variant_key)
);

-- 10. Task References (Verified Official Documentation Links)
CREATE TABLE task_references (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id UUID NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL CHECK (url ~* '^https://'),
  category TEXT NOT NULL DEFAULT 'OFFICIAL_DOCS',
  is_verified BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Task Assignments
CREATE TABLE task_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  assignment_code TEXT UNIQUE NOT NULL,
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES recruitment_batches(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES task_templates(id),
  task_version_id UUID NOT NULL REFERENCES task_versions(id),
  idempotency_key TEXT UNIQUE NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submission_deadline TIMESTAMPTZ NOT NULL,
  correction_deadline TIMESTAMPTZ,
  review_session_id UUID REFERENCES interview_sessions(id),
  review_date DATE,
  review_time TIME,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  google_meet_url TEXT,
  github_submission_instructions TEXT NOT NULL,
  assignment_status TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK (assignment_status IN ('PENDING_APPROVAL', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_NEEDED', 'COMPLETED')),
  approved_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_assignments_candidate ON task_assignments(candidate_id);

-- 12. GitHub Submissions
CREATE TABLE github_submissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  submission_code TEXT UNIQUE NOT NULL,
  assignment_id UUID NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  round_number INT NOT NULL DEFAULT 1,
  repository_url TEXT NOT NULL CHECK (repository_url ~* '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'),
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  commit_sha TEXT NOT NULL,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  access_verified BOOLEAN NOT NULL DEFAULT TRUE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submission_status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (submission_status IN ('RECEIVED', 'FETCHING_FILES', 'REVIEW_IN_PROGRESS', 'REVIEWED', 'FAILED'))
);

CREATE INDEX idx_github_submissions_assignment ON github_submissions(assignment_id);

-- 13. Repository Metadata (Sanitized File Tree & Dependency Manifest)
CREATE TABLE repository_metadata (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  submission_id UUID UNIQUE NOT NULL REFERENCES github_submissions(id) ON DELETE CASCADE,
  file_count INT NOT NULL DEFAULT 0,
  total_bytes INT NOT NULL DEFAULT 0,
  readme_present BOOLEAN NOT NULL DEFAULT FALSE,
  tests_present BOOLEAN NOT NULL DEFAULT FALSE,
  detected_languages TEXT[] NOT NULL DEFAULT '{}',
  dependencies JSONB NOT NULL DEFAULT '{}',
  filtered_files TEXT[] NOT NULL DEFAULT '{}',
  prompt_injection_flags JSONB NOT NULL DEFAULT '[]',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 14. Repository Reviews (Structured AI + Human Assessment)
CREATE TABLE repository_reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  review_code TEXT UNIQUE NOT NULL,
  submission_id UUID UNIQUE NOT NULL REFERENCES github_submissions(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  round_number INT NOT NULL DEFAULT 1,
  commit_sha TEXT NOT NULL,
  overall_summary TEXT NOT NULL,
  positive_observations JSONB NOT NULL DEFAULT '[]',
  functional_correctness_score NUMERIC(5,2) NOT NULL CHECK (functional_correctness_score BETWEEN 0 AND 40),
  code_quality_score NUMERIC(5,2) NOT NULL CHECK (code_quality_score BETWEEN 0 AND 20),
  testing_score NUMERIC(5,2) NOT NULL CHECK (testing_score BETWEEN 0 AND 20),
  documentation_score NUMERIC(5,2) NOT NULL CHECK (documentation_score BETWEEN 0 AND 10),
  security_score NUMERIC(5,2) NOT NULL CHECK (security_score BETWEEN 0 AND 10),
  total_score NUMERIC(5,2) GENERATED ALWAYS AS (
    functional_correctness_score + code_quality_score + testing_score + documentation_score + security_score
  ) STORED,
  missing_acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  unverified_areas JSONB NOT NULL DEFAULT '[]',
  test_execution_summary JSONB NOT NULL DEFAULT '{}',
  verification_status verification_type NOT NULL DEFAULT 'SOURCE_INSPECTION',
  confidence_score NUMERIC(4,2) NOT NULL DEFAULT 0.90,
  recommended_next_action TEXT NOT NULL,
  resolved_from_previous_round JSONB NOT NULL DEFAULT '[]',
  unresolved_from_previous_round JSONB NOT NULL DEFAULT '[]',
  interviewer_verified BOOLEAN NOT NULL DEFAULT FALSE,
  interviewer_override_score NUMERIC(5,2),
  interviewer_override_reason TEXT,
  interviewer_id UUID REFERENCES user_profiles(id),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_repository_reviews_candidate ON repository_reviews(candidate_id);

-- 15. Review Findings (Line-level Evidence & Severity)
CREATE TABLE review_findings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  review_id UUID NOT NULL REFERENCES repository_reviews(id) ON DELETE CASCADE,
  severity finding_severity NOT NULL,
  category TEXT NOT NULL,
  file_path TEXT,
  line_number INT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  suggested_correction TEXT NOT NULL,
  code_example TEXT,
  verification_basis verification_type NOT NULL DEFAULT 'SOURCE_INSPECTION',
  is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 16. Review Rounds (Historical Round Tracking)
CREATE TABLE review_rounds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  assignment_id UUID NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  round_number INT NOT NULL,
  submission_id UUID REFERENCES github_submissions(id),
  review_id UUID REFERENCES repository_reviews(id),
  session_id UUID REFERENCES interview_sessions(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('IN_PROGRESS', 'CORRECTION_REQUIRED', 'PASSED_TO_HUMAN_EVAL', 'ESCALATED_TO_HUMAN', 'COMPLETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(assignment_id, round_number)
);

-- 17. Email Logs (Idempotent Delivery & Approval Tracking)
CREATE TABLE email_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email_code TEXT UNIQUE NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  email_type TEXT NOT NULL CHECK (email_type IN ('TASK_ASSIGNMENT', 'SUBMISSION_CONFIRMATION', 'AI_CODE_REVIEW', 'NEXT_REVIEW_APPOINTMENT', 'REMINDER')),
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_preview TEXT NOT NULL,
  status email_status NOT NULL DEFAULT 'PENDING_APPROVAL',
  gmail_message_id TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  error_details TEXT,
  approved_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX idx_email_logs_candidate ON email_logs(candidate_id);

-- 18. Scheduled Background Jobs (Durable Queue & Retry Control)
CREATE TABLE scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_code TEXT UNIQUE NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  job_type TEXT NOT NULL,
  associated_record_type TEXT NOT NULL,
  associated_record_id TEXT NOT NULL,
  status job_status NOT NULL DEFAULT 'QUEUED',
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  retry_backoff_seconds INT NOT NULL DEFAULT 30,
  last_error TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- 19. Integration Metadata & Excel Synchronization Logs
CREATE TABLE integration_metadata (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_name TEXT UNIQUE NOT NULL,
  is_configured BOOLEAN NOT NULL DEFAULT FALSE,
  connection_status TEXT NOT NULL DEFAULT 'DEVELOPMENT_ADAPTER',
  last_tested_at TIMESTAMPTZ,
  config_summary JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE excel_sync_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sync_code TEXT UNIQUE NOT NULL,
  sync_stage TEXT NOT NULL CHECK (sync_stage IN ('STAGE_1_LOCAL_XLSX', 'STAGE_2_MS_GRAPH')),
  workbook_name TEXT NOT NULL,
  worksheets_synced TEXT[] NOT NULL,
  records_upserted INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'PARTIAL_FAILURE', 'FAILED')),
  error_details TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20. Audit Events (Immutable Compliance & Security Trail)
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID REFERENCES user_profiles(id),
  actor_role user_role NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- ROW-LEVEL SECURITY (RLS) POLICIES — STRICT CANDIDATE ISOLATION
-- =============================================================================
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_logs ENABLE ROW LEVEL SECURITY;

-- Candidates can ONLY read their own candidate row
CREATE POLICY candidate_self_select ON candidates
  FOR SELECT USING (
    auth.uid() = user_profile_id
    OR EXISTS (SELECT 1 FROM user_profiles up WHERE up.auth_user_id = auth.uid() AND up.role IN ('ADMIN', 'INTERVIEWER'))
  );

-- Candidates can ONLY view their own task assignments
CREATE POLICY candidate_task_assignment_select ON task_assignments
  FOR SELECT USING (
    candidate_id IN (SELECT id FROM candidates WHERE user_profile_id = auth.uid())
    OR EXISTS (SELECT 1 FROM user_profiles up WHERE up.auth_user_id = auth.uid() AND up.role IN ('ADMIN', 'INTERVIEWER'))
  );

-- Candidates can ONLY view & insert their own GitHub submissions
CREATE POLICY candidate_submission_isolation ON github_submissions
  FOR ALL USING (
    candidate_id IN (SELECT id FROM candidates WHERE user_profile_id = auth.uid())
    OR EXISTS (SELECT 1 FROM user_profiles up WHERE up.auth_user_id = auth.uid() AND up.role IN ('ADMIN', 'INTERVIEWER'))
  );

-- Candidates can ONLY view their own repository reviews
CREATE POLICY candidate_review_isolation ON repository_reviews
  FOR SELECT USING (
    candidate_id IN (SELECT id FROM candidates WHERE user_profile_id = auth.uid())
    OR EXISTS (SELECT 1 FROM user_profiles up WHERE up.auth_user_id = auth.uid() AND up.role IN ('ADMIN', 'INTERVIEWER'))
  );
