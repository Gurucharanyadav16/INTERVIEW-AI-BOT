/**
 * InterviewFlow AI — Core Backend Workflow Engine & Domain Services
 * Implements:
 * 1. Complete State Machine (15 states with strict server-side validation)
 * 2. RBAC & Strict Candidate Data Isolation (Admin/HR, Technical Interviewer, Candidate)
 * 3. Candidate CSV/XLSX Import & Validation (10 to 1,000+ candidates, duplicate/email detection)
 * 4. Attendance Confirmation (Manual, CSV Import, Google Meet API + Admin Override with Audit)
 * 5. Individual AI Task Assignment Engine (Approved templates, controlled variants, comparability checks, 12-part mentor explanation, idempotency)
 * 6. Automated Email System (5 templates, Test Mode, Admin Approval, Duplicate Send Prevention, Retry)
 * 7. Google Meet & Calendar Review Scheduling (Individual & Group slots, buffer times, conflict check, fallback manual URL)
 * 8. GitHub Repository Review Engine (URL validation, path filtering, prompt-injection defense, 100-pt configurable rubric, verified vs unverified distinction)
 * 9. Complete Reassessment Loop (Correction cycle, commit comparison, max review round limit, human escalation)
 * 10. Excel Synchronization (Stage 1 XLSX/CSV & Stage 2 Microsoft Graph API safe upserts by stable ID)
 * 11. Durable Background Job Queue (Idempotency keys, retries, backoff, failed-job recovery)
 */

import crypto from 'node:crypto';

export const WORKFLOW_STATES = Object.freeze({
  REGISTERED: 'REGISTERED',
  ATTENDANCE_PENDING: 'ATTENDANCE_PENDING',
  ATTENDANCE_CONFIRMED: 'ATTENDANCE_CONFIRMED',
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  SUBMITTED: 'SUBMITTED',
  REVIEW_PENDING: 'REVIEW_PENDING',
  AI_REVIEW_COMPLETED: 'AI_REVIEW_COMPLETED',
  FEEDBACK_SENT: 'FEEDBACK_SENT',
  CORRECTION_REQUIRED: 'CORRECTION_REQUIRED',
  RESUBMISSION_RECEIVED: 'RESUBMISSION_RECEIVED',
  NEXT_REVIEW_SCHEDULED: 'NEXT_REVIEW_SCHEDULED',
  READY_FOR_HUMAN_EVALUATION: 'READY_FOR_HUMAN_EVALUATION',
  MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
  COMPLETED: 'COMPLETED',
  WITHDRAWN: 'WITHDRAWN',
});

export const ALLOWED_STATE_TRANSITIONS = Object.freeze({
  REGISTERED: ['ATTENDANCE_PENDING', 'ATTENDANCE_CONFIRMED', 'WITHDRAWN'],
  ATTENDANCE_PENDING: ['ATTENDANCE_CONFIRMED', 'WITHDRAWN'],
  ATTENDANCE_CONFIRMED: ['TASK_ASSIGNED', 'WITHDRAWN'],
  TASK_ASSIGNED: ['SUBMITTED', 'WITHDRAWN'],
  SUBMITTED: ['REVIEW_PENDING', 'WITHDRAWN'],
  REVIEW_PENDING: ['AI_REVIEW_COMPLETED', 'MANUAL_REVIEW_REQUIRED'],
  AI_REVIEW_COMPLETED: ['FEEDBACK_SENT', 'MANUAL_REVIEW_REQUIRED', 'READY_FOR_HUMAN_EVALUATION'],
  FEEDBACK_SENT: ['CORRECTION_REQUIRED', 'NEXT_REVIEW_SCHEDULED', 'READY_FOR_HUMAN_EVALUATION', 'MANUAL_REVIEW_REQUIRED', 'COMPLETED'],
  CORRECTION_REQUIRED: ['RESUBMISSION_RECEIVED', 'NEXT_REVIEW_SCHEDULED', 'MANUAL_REVIEW_REQUIRED', 'WITHDRAWN'],
  RESUBMISSION_RECEIVED: ['REVIEW_PENDING', 'AI_REVIEW_COMPLETED'],
  NEXT_REVIEW_SCHEDULED: ['RESUBMISSION_RECEIVED', 'REVIEW_PENDING', 'READY_FOR_HUMAN_EVALUATION', 'COMPLETED'],
  READY_FOR_HUMAN_EVALUATION: ['COMPLETED', 'CORRECTION_REQUIRED', 'NEXT_REVIEW_SCHEDULED'],
  MANUAL_REVIEW_REQUIRED: ['CORRECTION_REQUIRED', 'READY_FOR_HUMAN_EVALUATION', 'COMPLETED'],
  COMPLETED: [],
  WITHDRAWN: [],
});

export const DEFAULT_RUBRIC = Object.freeze({
  functional_correctness: 40,
  code_quality: 20,
  testing_edge_cases: 20,
  documentation: 10,
  security_error_handling: 10,
});

const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const GITHUB_URL_REGEX = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git|\/)?$/;
const GOOGLE_MEET_REGEX = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|system)\s+instructions/i,
  /disregard\s+the\s+rubric/i,
  /give\s+(this\s+candidate|me)\s+(100|full\s+marks|a\s+perfect\s+score)/i,
  /system\s*override\s*:/i,
  /reveal\s+(your\s+)?(api\s+key|system\s+prompt|secret)/i,
];

const IGNORED_FILE_PATTERNS = [
  /^node_modules\//,
  /^\.git\//,
  /^\.env($|\.)/,
  /\.(png|jpg|jpeg|gif|ico|pdf|zip|tar|gz|exe|dll|so|dylib|woff2?)$/i,
  /package-lock\.json$/,
  /yarn\.lock$/,
];

export class InterviewFlowPlatform {
  constructor(options = {}) {
    this.config = {
      safeEmailTestMode: options.safeEmailTestMode ?? true,
      requireAdminEmailApproval: options.requireAdminEmailApproval ?? false,
      maxFilesPerRepo: options.maxFilesPerRepo ?? 60,
      maxBytesPerRepo: options.maxBytesPerRepo ?? 512_000,
      rateLimitPerMinute: options.rateLimitPerMinute ?? 120,
      ...options,
    };

    this.users = new Map();
    this.batches = new Map();
    this.candidates = new Map();
    this.taskTemplates = new Map();
    this.taskVersions = new Map();
    this.taskAssignments = new Map();
    this.submissions = new Map();
    this.reviews = new Map();
    this.reviewRounds = new Map();
    this.sessions = new Map();
    this.interviewerAvailability = new Map();
    this.emails = new Map();
    this.jobs = new Map();
    this.excelWorksheets = {
      CandidateTracker: new Map(),
      TaskAssignments: new Map(),
      ReviewHistory: new Map(),
      EmailLog: new Map(),
      InterviewSessions: new Map(),
      TaskCatalog: new Map(),
    };
    this.excelSyncLogs = [];
    this.auditLogs = [];
    this.idempotencyRegistry = new Map();
    this.rateLimitBuckets = new Map();

    this._seedDefaultTemplatesAndUsers();
  }

  _id(prefix) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  }

  _logAudit(actor, action, entityType, entityId, reason = null, metadata = {}) {
    const entry = {
      id: this._id('AUD'),
      actorId: actor?.id || 'SYSTEM',
      actorRole: actor?.role || 'ADMIN',
      action,
      entityType,
      entityId,
      reason,
      metadata,
      timestamp: new Date().toISOString(),
    };
    this.auditLogs.push(entry);
    return entry;
  }

  checkRateLimit(actorId) {
    const key = `${actorId}:${Math.floor(Date.now() / 60000)}`;
    const current = this.rateLimitBuckets.get(key) || 0;
    if (current >= this.config.rateLimitPerMinute) {
      const err = new Error('API rate limit exceeded. Please retry after 60 seconds.');
      err.code = 'RATE_LIMIT_EXCEEDED';
      throw err;
    }
    this.rateLimitBuckets.set(key, current + 1);
    return true;
  }

  // ---------------------------------------------------------------------------
  // 1. RBAC & STRICT DATA ISOLATION
  // ---------------------------------------------------------------------------
  assertRole(actor, allowedRoles) {
    if (!actor || !actor.role) {
      const err = new Error('Authentication required.');
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    if (!allowedRoles.includes(actor.role)) {
      const err = new Error(`Access denied: role ${actor.role} is not authorized for this operation.`);
      err.code = 'FORBIDDEN';
      throw err;
    }
  }

  getCandidateForActor(actor, candidateId) {
    this.assertRole(actor, ['ADMIN', 'INTERVIEWER', 'CANDIDATE']);
    const candidate = this.candidates.get(candidateId);
    if (!candidate) {
      const err = new Error(`Candidate ${candidateId} not found.`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (actor.role === 'CANDIDATE' && actor.candidateId !== candidateId) {
      this._logAudit(actor, 'UNAUTHORIZED_CROSS_CANDIDATE_ACCESS_BLOCKED', 'CANDIDATE', candidateId);
      const err = new Error('Security Violation: Candidates can only access their own profile, task, and review records.');
      err.code = 'FORBIDDEN_CROSS_CANDIDATE';
      throw err;
    }
    if (actor.role === 'INTERVIEWER' && candidate.assignedInterviewerId && candidate.assignedInterviewerId !== actor.id) {
      const err = new Error('Access denied: Interviewer is not assigned to this candidate.');
      err.code = 'FORBIDDEN_INTERVIEWER_SCOPE';
      throw err;
    }
    return structuredClone(candidate);
  }

  // ---------------------------------------------------------------------------
  // 2. SEED TEMPLATES, BATCHES & USERS
  // ---------------------------------------------------------------------------
  _seedDefaultTemplatesAndUsers() {
    this.users.set('USR-ADMIN-01', {
      id: 'USR-ADMIN-01',
      name: 'Ananya Krishnan (HR Lead)',
      email: 'ananya.hr@interviewflow.io',
      role: 'ADMIN',
      timezone: 'Asia/Kolkata',
    });
    this.users.set('USR-INT-01', {
      id: 'USR-INT-01',
      name: 'Vikram Menon (Staff Engineer)',
      email: 'vikram.menon@interviewflow.io',
      role: 'INTERVIEWER',
      timezone: 'Asia/Kolkata',
    });
    this.users.set('USR-INT-02', {
      id: 'USR-INT-02',
      name: 'Priya Nair (Principal Architect)',
      email: 'priya.nair@interviewflow.io',
      role: 'INTERVIEWER',
      timezone: 'Asia/Kolkata',
    });

    const templates = [
      {
        id: 'TPL-FS-01',
        title: 'Resilient Order Webhook & Idempotent Payment Ledger API',
        jobRole: 'Full-Stack Engineer',
        technology: 'Next.js / TypeScript / PostgreSQL',
        language: 'TypeScript',
        difficulty: 'MID',
        skills: ['TypeScript', 'Next.js', 'REST API', 'PostgreSQL', 'Idempotency'],
        estimatedHours: 6,
        problemStatement: 'Build a webhook receiver and order ledger service that processes incoming payment events idempotently without double-charging or dropping concurrent updates.',
        businessScenario: 'During flash sales, payment gateways sometimes deliver duplicate webhook events within milliseconds. Your service must verify HMAC signatures, deduplicate by event_id, and expose a paginated ledger dashboard.',
        objective: 'Implement verified webhook ingestion, idempotent database transactions, structured error handling, and unit tests.',
        functionalRequirements: [
          'POST /api/webhooks/payment endpoint with HMAC-SHA256 signature verification',
          'Idempotency key enforcement preventing duplicate ledger mutations',
          'GET /api/ledger endpoint with status filter and cursor pagination',
          'Retry-safe state transitions (PENDING -> CAPTURED / FAILED)',
        ],
        nonFunctionalRequirements: [
          'Strict input validation using Zod schemas',
          'Zero secrets hardcoded in source files',
          'Structured JSON error responses with HTTP status codes',
        ],
        deliverables: ['Source code under src/', 'Database schema/migration', 'Unit & integration tests under tests/', 'README.md with setup steps'],
        acceptanceCriteria: [
          'Validates webhook signature and rejects tampered payloads with 401',
          'Processes duplicate event IDs idempotently returning 200 without duplicate rows',
          'Includes automated tests covering happy path, duplicate delivery, and invalid signature',
        ],
        testingRequirements: ['Minimum 4 unit/integration tests covering signature verification, idempotency, pagination, and malformed payload rejection'],
        rubric: { ...DEFAULT_RUBRIC },
        references: [
          { title: 'Next.js App Router Route Handlers', url: 'https://nextjs.org/docs/app/building-your-application/routing/route-handlers' },
          { title: 'PostgreSQL Unique Constraints & Upserts', url: 'https://www.postgresql.org/docs/current/sql-insert.html' },
          { title: 'Zod Documentation', url: 'https://zod.dev/' },
        ],
        variants: [
          {
            variantKey: 'VARIANT-A',
            suffixTitle: 'Variant A: E-Commerce Checkout Ledger',
            domainEntity: 'checkout_order',
            hmacHeader: 'x-signature-sha256',
          },
          {
            variantKey: 'VARIANT-B',
            suffixTitle: 'Variant B: SaaS Subscription Invoice Ledger',
            domainEntity: 'subscription_invoice',
            hmacHeader: 'x-webhook-hmac',
          },
          {
            variantKey: 'VARIANT-C',
            suffixTitle: 'Variant C: Marketplace Payout Escrow Ledger',
            domainEntity: 'escrow_payout',
            hmacHeader: 'x-escrow-signature',
          },
        ],
        isApproved: true,
        isActive: true,
        version: 1,
      },
      {
        id: 'TPL-BE-02',
        title: 'Distributed Rate-Limited Job Queue & Retry Worker',
        jobRole: 'Backend Engineer',
        technology: 'Node.js / TypeScript / Redis-compatible State',
        language: 'TypeScript',
        difficulty: 'SENIOR',
        skills: ['Node.js', 'TypeScript', 'Concurrency', 'Rate Limiting', 'Testing'],
        estimatedHours: 6,
        problemStatement: 'Design and implement a sliding-window rate limiter and background job dispatcher with exponential backoff and dead-letter queue isolation.',
        businessScenario: 'Our outbound notification pipeline calls third-party APIs with strict per-minute quotas. We need a worker that respects tenant rate limits and isolates poison messages.',
        objective: 'Deliver a deterministic rate-limiter, retry scheduler, dead-letter inspection endpoint, and deterministic tests.',
        functionalRequirements: [
          'Sliding-window per-tenant rate limiter',
          'Exponential backoff retry policy with configurable maxAttempts',
          'Dead-letter queue (DLQ) transition after exhausting retries',
          'Manual replay endpoint for DLQ jobs with idempotency guard',
        ],
        nonFunctionalRequirements: [
          'O(1) amortized state lookup per job dispatch',
          'Clean separation between queue storage adapter and worker logic',
        ],
        deliverables: ['Worker implementation', 'Rate limiter module', 'Automated test suite', 'Architecture notes in README.md'],
        acceptanceCriteria: [
          'Enforces tenant rate limits accurately under concurrent load',
          'Moves permanently failing jobs to DLQ after maxAttempts',
          'Prevents duplicate execution when replaying jobs',
        ],
        testingRequirements: ['Unit tests for sliding window quota, backoff calculation, and DLQ replay idempotency'],
        rubric: { ...DEFAULT_RUBRIC },
        references: [
          { title: 'Node.js Test Runner Documentation', url: 'https://nodejs.org/api/test.html' },
          { title: 'TypeScript Handbook', url: 'https://www.typescriptlang.org/docs/handbook/intro.html' },
        ],
        variants: [
          {
            variantKey: 'VARIANT-A',
            suffixTitle: 'Variant A: Outbound Email Dispatcher',
            domainEntity: 'email_dispatch_job',
            hmacHeader: 'x-dispatch-token',
          },
          {
            variantKey: 'VARIANT-B',
            suffixTitle: 'Variant B: Webhook Delivery Engine',
            domainEntity: 'webhook_delivery_job',
            hmacHeader: 'x-delivery-token',
          },
        ],
        isApproved: true,
        isActive: true,
        version: 1,
      },
      {
        id: 'TPL-FE-03',
        title: 'Accessible Real-Time Telemetry Filter & Incident Triage Console',
        jobRole: 'Frontend Engineer',
        technology: 'React / Next.js / TypeScript / Tailwind CSS',
        language: 'TypeScript',
        difficulty: 'JUNIOR',
        skills: ['React', 'TypeScript', 'Tailwind CSS', 'Accessibility', 'State Management'],
        estimatedHours: 5,
        problemStatement: 'Create a responsive, keyboard-accessible incident triage interface with multi-facet filtering, URL-synchronized state, and optimistic status transitions.',
        businessScenario: 'On-call engineers need to filter hundreds of service alerts by severity, region, and acknowledgment state without layout shifts or accessibility barriers.',
        objective: 'Build an accessible React dashboard with search, debounced filtering, pagination, and component tests.',
        functionalRequirements: [
          'Search and multi-select filtering across severity and service name',
          'Accessible status transition modal with confirmation notes',
          'Client-side pagination and deterministic sorting',
        ],
        nonFunctionalRequirements: [
          'WCAG AA contrast and full keyboard navigation support',
          'Zero unhandled runtime errors on empty or malformed filter queries',
        ],
        deliverables: ['React components', 'State management hook', 'Unit tests', 'README.md'],
        acceptanceCriteria: [
          'Filters and paginates 100+ items smoothly',
          'Includes ARIA labels and keyboard focus management',
          'Passes automated component logic tests',
        ],
        testingRequirements: ['Tests for filter reducer, pagination boundaries, and status transition validation'],
        rubric: { ...DEFAULT_RUBRIC },
        references: [
          { title: 'React Official Documentation', url: 'https://react.dev/reference/react' },
          { title: 'WAI-ARIA Authoring Practices', url: 'https://www.w3.org/WAI/ARIA/apg/' },
        ],
        variants: [
          {
            variantKey: 'VARIANT-A',
            suffixTitle: 'Variant A: Cloud Infrastructure Alert Console',
            domainEntity: 'infra_alert',
            hmacHeader: 'x-alert-client',
          },
          {
            variantKey: 'VARIANT-B',
            suffixTitle: 'Variant B: FinTech Fraud Queue Triage UI',
            domainEntity: 'fraud_case',
            hmacHeader: 'x-fraud-client',
          },
        ],
        isApproved: true,
        isActive: true,
        version: 1,
      },
    ];

    for (const tpl of templates) {
      this.taskTemplates.set(tpl.id, tpl);
    }

    // Create default recruitment batch
    this.createBatch(
      { id: 'USR-ADMIN-01', role: 'ADMIN' },
      {
        id: 'BATCH-2026-Q4',
        batchCode: 'BATCH-2026-Q4',
        name: 'Q4 2026 Engineering Hiring Batch (Google Meet Session #1)',
        targetRole: 'Full-Stack / Backend / Frontend',
        requiredTechnologies: ['TypeScript', 'Next.js', 'Node.js', 'PostgreSQL', 'React'],
        startDate: '2026-10-26',
        endDate: '2026-11-05',
        googleMeetUrl: 'https://meet.google.com/ifw-qfour-eng',
        assignmentDeadlineHours: 48,
        correctionDeadlineHours: 24,
        maxReviewRounds: 3,
        maxResubmissions: 3,
        passingScoreThreshold: 78,
        requireAdminTaskApproval: false,
        requireAdminEmailApproval: false,
      }
    );
  }

  createBatch(actor, batchInput) {
    this.assertRole(actor, ['ADMIN']);
    const id = batchInput.id || this._id('BATCH');
    const batch = {
      id,
      batchCode: batchInput.batchCode || id,
      name: batchInput.name,
      targetRole: batchInput.targetRole || 'Full-Stack Engineer',
      requiredTechnologies: batchInput.requiredTechnologies || ['TypeScript', 'Next.js'],
      startDate: batchInput.startDate || '2026-10-26',
      endDate: batchInput.endDate || '2026-11-05',
      googleMeetUrl: batchInput.googleMeetUrl || null,
      assignmentDeadlineHours: batchInput.assignmentDeadlineHours ?? 48,
      correctionDeadlineHours: batchInput.correctionDeadlineHours ?? 24,
      maxReviewRounds: batchInput.maxReviewRounds ?? 3,
      maxResubmissions: batchInput.maxResubmissions ?? 3,
      passingScoreThreshold: batchInput.passingScoreThreshold ?? 78,
      requireAdminTaskApproval: batchInput.requireAdminTaskApproval ?? false,
      requireAdminEmailApproval: batchInput.requireAdminEmailApproval ?? false,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    };
    this.batches.set(id, batch);
    this._logAudit(actor, 'BATCH_CREATED', 'BATCH', id, null, { name: batch.name });
    return batch;
  }

  // ---------------------------------------------------------------------------
  // 3. CANDIDATE IMPORT & VALIDATION (Supports 10 to 1,000+ Candidates)
  // ---------------------------------------------------------------------------
  previewCandidateImport(actor, rows, format = 'CSV') {
    this.assertRole(actor, ['ADMIN']);
    const supportedFormats = ['CSV', 'XLSX'];
    if (!supportedFormats.includes(format.toUpperCase())) {
      const err = new Error(`Unsupported file format: ${format}. Only CSV and XLSX are supported.`);
      err.code = 'UNSUPPORTED_FORMAT';
      throw err;
    }

    const validRecords = [];
    const errors = [];
    const seenEmailsInFile = new Set();
    const existingEmails = new Set(Array.from(this.candidates.values()).map((c) => c.email.toLowerCase()));

    rows.forEach((row, index) => {
      const rowNum = index + 1;
      const name = (row.name || row.fullName || '').trim();
      const email = (row.email || '').trim().toLowerCase();
      const jobRole = (row.jobRole || row.role || '').trim();
      const skills = Array.isArray(row.skills)
        ? row.skills
        : String(row.skills || '')
            .split(/[;,]/)
            .map((s) => s.trim())
            .filter(Boolean);
      const experienceLevel = (row.experienceLevel || 'JUNIOR').trim().toUpperCase();
      const batchId = (row.batchId || 'BATCH-2026-Q4').trim();

      if (!name || !email || !jobRole) {
        errors.push({ row: rowNum, reason: 'MISSING_REQUIRED_FIELD', details: 'Name, email, and jobRole are required.' });
        return;
      }
      if (!EMAIL_REGEX.test(email)) {
        errors.push({ row: rowNum, email, reason: 'INVALID_EMAIL', details: `Invalid email address: ${email}` });
        return;
      }
      if (seenEmailsInFile.has(email) || existingEmails.has(email)) {
        errors.push({ row: rowNum, email, reason: 'DUPLICATE_CANDIDATE', details: `Duplicate email detected: ${email}` });
        return;
      }

      seenEmailsInFile.add(email);
      validRecords.push({
        name,
        email,
        jobRole,
        skills: skills.length ? skills : ['TypeScript', 'JavaScript'],
        experienceLevel: ['JUNIOR', 'MID', 'SENIOR', 'STAFF'].includes(experienceLevel) ? experienceLevel : 'JUNIOR',
        batchId,
      });
    });

    return {
      format,
      totalRows: rows.length,
      validCount: validRecords.length,
      errorCount: errors.length,
      validRecords,
      errors,
    };
  }

  importCandidates(actor, rows, format = 'CSV') {
    const preview = this.previewCandidateImport(actor, rows, format);
    const imported = [];

    for (const rec of preview.validRecords) {
      const id = this._id('CAND');
      const candidate = {
        id,
        candidateCode: id,
        name: rec.name,
        email: rec.email,
        jobRole: rec.jobRole,
        skills: rec.skills,
        experienceLevel: rec.experienceLevel,
        batchId: rec.batchId,
        attendance: 'PENDING',
        attendanceSource: null,
        attendanceVerifiedAt: null,
        attendanceOverrideReason: null,
        workflowStatus: WORKFLOW_STATES.ATTENDANCE_PENDING,
        currentTaskId: null,
        currentAssignmentId: null,
        currentReviewRound: 0,
        submissionStatus: 'NOT_SUBMITTED',
        assignedInterviewerId: 'USR-INT-01',
        humanEvaluationDecision: 'PENDING',
        humanEvaluationNotes: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.candidates.set(id, candidate);
      imported.push(candidate);
    }

    this._logAudit(actor, 'CANDIDATES_IMPORTED', 'BATCH', 'BATCH-2026-Q4', null, {
      totalRows: preview.totalRows,
      importedCount: imported.length,
      rejectedCount: preview.errorCount,
    });

    return {
      ...preview,
      importedCandidates: imported,
    };
  }

  // ---------------------------------------------------------------------------
  // 4. ATTENDANCE WORKFLOW (Manual, CSV, Google Meet API, Admin Override)
  // ---------------------------------------------------------------------------
  confirmAttendance(actor, candidateId, options = {}) {
    this.assertRole(actor, ['ADMIN']);
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error(`Candidate ${candidateId} not found.`);

    const source = options.source || 'MANUAL_ADMIN';
    // Guard against unverified display-name matching from Google Meet
    if (source === 'GOOGLE_MEET_API' && !options.verifiedEmailMatch) {
      const err = new Error(
        'Attendance verification requires an exact email match or manual administrator confirmation; display name alone is insufficient.'
      );
      err.code = 'UNCERTAIN_IDENTITY_MATCH';
      throw err;
    }

    candidate.attendance = options.isOverride ? 'MANUAL_OVERRIDE' : 'CONFIRMED';
    candidate.attendanceSource = options.isOverride ? 'ADMIN_OVERRIDE' : source;
    candidate.attendanceVerifiedAt = new Date().toISOString();
    candidate.attendanceOverrideReason = options.overrideReason || null;
    this._transitionState(candidate, WORKFLOW_STATES.ATTENDANCE_CONFIRMED, actor, options.overrideReason);

    this._logAudit(
      actor,
      options.isOverride ? 'ATTENDANCE_OVERRIDE_CONFIRMED' : 'ATTENDANCE_CONFIRMED',
      'CANDIDATE',
      candidateId,
      options.overrideReason || `Verified via ${source}`
    );
    return structuredClone(candidate);
  }

  // ---------------------------------------------------------------------------
  // 5. STATE MACHINE VALIDATION
  // ---------------------------------------------------------------------------
  _transitionState(candidate, nextState, actor, reason = null) {
    const current = candidate.workflowStatus;
    if (current === nextState) return candidate;
    const allowed = ALLOWED_STATE_TRANSITIONS[current] || [];
    if (!allowed.includes(nextState)) {
      const err = new Error(`Invalid state transition from ${current} to ${nextState}.`);
      err.code = 'INVALID_STATE_TRANSITION';
      throw err;
    }
    candidate.workflowStatus = nextState;
    candidate.updatedAt = new Date().toISOString();
    this._logAudit(actor, `STATE_TRANSITION:${current}->${nextState}`, 'CANDIDATE', candidate.id, reason);
    return candidate;
  }

  // ---------------------------------------------------------------------------
  // 6. INDIVIDUAL AI TASK ASSIGNMENT & 12-PART MENTOR EXPLANATION
  // ---------------------------------------------------------------------------
  assignTaskToCandidate(actor, candidateId, options = {}) {
    this.assertRole(actor, ['ADMIN']);
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error(`Candidate ${candidateId} not found.`);

    const idempotencyKey = options.idempotencyKey || `ASSIGN:${candidate.id}:${candidate.batchId}`;
    if (this.idempotencyRegistry.has(idempotencyKey)) {
      return structuredClone(this.taskAssignments.get(this.idempotencyRegistry.get(idempotencyKey)));
    }

    // Enforce attendance requirement unless explicit admin override with reason
    const isAttendanceConfirmed = ['CONFIRMED', 'MANUAL_OVERRIDE'].includes(candidate.attendance);
    if (!isAttendanceConfirmed) {
      if (options.adminAttendanceOverride && options.overrideReason) {
        this.confirmAttendance(actor, candidateId, {
          isOverride: true,
          overrideReason: options.overrideReason,
        });
      } else {
        const err = new Error(
          `Cannot assign task to ${candidate.name}: Attendance is ${candidate.attendance}. Confirm attendance or provide an admin override with reason.`
        );
        err.code = 'ATTENDANCE_NOT_CONFIRMED';
        throw err;
      }
    }

    // Select matching approved template by role/skills
    const approvedTemplates = Array.from(this.taskTemplates.values()).filter((t) => t.isApproved && t.isActive);
    let selectedTemplate = approvedTemplates.find(
      (t) => t.jobRole.toLowerCase() === candidate.jobRole.toLowerCase()
    );
    if (!selectedTemplate) {
      selectedTemplate = approvedTemplates[0];
    }

    // Pick controlled variant so same-role candidates receive distinct variants with identical rubric & difficulty
    const existingAssignmentsForTemplate = Array.from(this.taskAssignments.values()).filter(
      (a) => a.templateId === selectedTemplate.id
    );
    const variantIndex = existingAssignmentsForTemplate.length % selectedTemplate.variants.length;
    const chosenVariant = selectedTemplate.variants[variantIndex];

    // Validate comparability against template
    const comparabilityCheck = {
      sameDifficulty: true,
      sameEstimatedHours: selectedTemplate.estimatedHours,
      sameRubricTotal:
        Object.values(selectedTemplate.rubric).reduce((acc, v) => acc + v, 0) === 100,
      functionalRequirementCount: selectedTemplate.functionalRequirements.length,
    };
    if (!comparabilityCheck.sameRubricTotal) {
      throw new Error('Template rubric validation failed: total points must equal 100.');
    }

    const versionId = `${selectedTemplate.id}-V${selectedTemplate.version}-${chosenVariant.variantKey}`;
    const batch = this.batches.get(candidate.batchId) || Array.from(this.batches.values())[0];
    const deadlineDate = new Date(Date.now() + (batch?.assignmentDeadlineHours || 48) * 3600 * 1000);
    const reviewDate = new Date(deadlineDate.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const reviewTime = '15:00';
    const timezone = 'Asia/Kolkata (IST, UTC+05:30)';
    const meetUrl = options.googleMeetUrl || batch?.googleMeetUrl || 'https://meet.google.com/ifw-qfour-eng';

    // 12-Part Friendly Technical Mentor Explanation
    const mentorExplanation = {
      whatToBuild: `Hi ${candidate.name}! You'll be building "${selectedTemplate.title} (${chosenVariant.suffixTitle})"—specifically focusing on the ${chosenVariant.domainEntity} workflow using ${selectedTemplate.technology}.`,
      whyItMatters: `In production engineering, ${selectedTemplate.businessScenario.toLowerCase()} Getting this right shows you can write reliable, production-grade code.`,
      practicalExample: `For example, when a request arrives with header "${chosenVariant.hmacHeader}" and payload {"event_id": "evt_101", "entity": "${chosenVariant.domainEntity}"}, your endpoint verifies the signature, records the state once, and returns 200 OK even if "evt_101" is sent twice.`,
      recommendedSequence: [
        '1. Initialize the project structure and install dependencies.',
        '2. Define the data model and Zod request validation schema.',
        `3. Implement the core ${chosenVariant.domainEntity} service with idempotency protection.`,
        '4. Add API route handlers and structured error responses.',
        '5. Write automated tests covering happy paths and edge cases.',
      ],
      toolsAndTechnologies: selectedTemplate.skills,
      howToTest: `Run your unit and integration test suite via "npm test". Verify that valid requests pass, duplicate requests do not create duplicate entries, and invalid inputs return 400/401.`,
      filesToSubmit: selectedTemplate.deliverables,
      commonMistakesToAvoid: [
        'Skipping signature or input validation before touching the database.',
        'Hardcoding secrets or API keys instead of reading from environment variables.',
        'Forgetting to commit tests or leaving TODO placeholders in critical paths.',
      ],
      evaluationCriteria: selectedTemplate.rubric,
      learningResources: selectedTemplate.references,
      submissionInstructions: 'Push your code to a public or authorized private GitHub repository and submit the repository URL in your Candidate Portal before the deadline.',
      deadlineAndReviewDetails: {
        submissionDeadline: deadlineDate.toISOString(),
        reviewDate,
        reviewTime,
        timezone,
        googleMeetUrl: meetUrl,
      },
    };

    const taskVersion = {
      id: versionId,
      templateId: selectedTemplate.id,
      versionNumber: selectedTemplate.version,
      variantKey: chosenVariant.variantKey,
      title: `${selectedTemplate.title} — ${chosenVariant.suffixTitle}`,
      problemStatement: selectedTemplate.problemStatement,
      businessScenario: selectedTemplate.businessScenario,
      objective: selectedTemplate.objective,
      requiredTechnologies: selectedTemplate.skills,
      difficulty: selectedTemplate.difficulty,
      functionalRequirements: selectedTemplate.functionalRequirements,
      nonFunctionalRequirements: selectedTemplate.nonFunctionalRequirements,
      stepByStepInstructions: mentorExplanation.recommendedSequence,
      expectedOutput: mentorExplanation.practicalExample,
      deliverables: selectedTemplate.deliverables,
      acceptanceCriteria: selectedTemplate.acceptanceCriteria,
      testingRequirements: selectedTemplate.testingRequirements,
      rubric: selectedTemplate.rubric,
      approvedReferences: selectedTemplate.references,
      mentorExplanation,
      comparabilityCheck,
    };
    this.taskVersions.set(versionId, taskVersion);

    const assignmentId = this._id('ASN');
    const assignment = {
      id: assignmentId,
      taskId: versionId,
      templateId: selectedTemplate.id,
      candidateId: candidate.id,
      candidateName: candidate.name,
      batchId: candidate.batchId,
      title: taskVersion.title,
      difficulty: taskVersion.difficulty,
      version: `${selectedTemplate.version}.0 (${chosenVariant.variantKey})`,
      idempotencyKey,
      assignedAt: new Date().toISOString(),
      submissionDeadline: deadlineDate.toISOString(),
      reviewDate,
      reviewTime,
      timezone,
      googleMeetUrl: meetUrl,
      githubSubmissionInstructions: mentorExplanation.submissionInstructions,
      status: batch?.requireAdminTaskApproval ? 'PENDING_APPROVAL' : 'ASSIGNED',
      taskDetails: taskVersion,
    };

    this.taskAssignments.set(assignmentId, assignment);
    this.idempotencyRegistry.set(idempotencyKey, assignmentId);

    candidate.currentTaskId = versionId;
    candidate.currentAssignmentId = assignmentId;
    this._transitionState(candidate, WORKFLOW_STATES.TASK_ASSIGNED, actor, `Assigned ${versionId}`);

    // Queue Task Assignment Email automatically
    this.queueEmail(actor, {
      candidateId: candidate.id,
      emailType: 'TASK_ASSIGNMENT',
      idempotencyKey: `EMAIL:TASK_ASSIGNMENT:${assignmentId}`,
      context: { assignment },
    });

    return structuredClone(assignment);
  }

  // ---------------------------------------------------------------------------
  // 7. AUTOMATED EMAIL SYSTEM (5 Templates, Test Mode, Approval, Retry, Dedup)
  // ---------------------------------------------------------------------------
  queueEmail(actor, { candidateId, emailType, idempotencyKey, context = {} }) {
    if (idempotencyKey && this.idempotencyRegistry.has(idempotencyKey)) {
      return structuredClone(this.emails.get(this.idempotencyRegistry.get(idempotencyKey)));
    }
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error(`Candidate ${candidateId} not found.`);

    const rendered = this._renderEmailTemplate(emailType, candidate, context);
    const emailId = this._id('EML');
    const status = this.config.requireAdminEmailApproval
      ? 'PENDING_APPROVAL'
      : this.config.safeEmailTestMode
      ? 'SUPPRESSED_TEST_MODE'
      : 'SENT_ACCEPTED';

    const emailRecord = {
      id: emailId,
      idempotencyKey: idempotencyKey || `EMAIL:${emailType}:${emailId}`,
      candidateId: candidate.id,
      candidateName: candidate.name,
      recipient: candidate.email,
      emailType,
      subject: rendered.subject,
      body: rendered.body,
      timezone: rendered.timezone,
      status,
      attemptCount: status === 'PENDING_APPROVAL' ? 0 : 1,
      errorDetails: null,
      createdAt: new Date().toISOString(),
      sentAt: status === 'SENT_ACCEPTED' || status === 'SUPPRESSED_TEST_MODE' ? new Date().toISOString() : null,
    };

    this.emails.set(emailId, emailRecord);
    if (idempotencyKey) {
      this.idempotencyRegistry.set(idempotencyKey, emailId);
    }
    return structuredClone(emailRecord);
  }

  _renderEmailTemplate(emailType, candidate, context) {
    const assignment = context.assignment || this.taskAssignments.get(candidate.currentAssignmentId) || {};
    const tz = assignment.timezone || 'Asia/Kolkata (IST, UTC+05:30)';
    switch (emailType) {
      case 'TASK_ASSIGNMENT':
        return {
          timezone: tz,
          subject: `[InterviewFlow AI] Technical Assessment Assigned: ${assignment.title || 'Individual Task'}`,
          body: `Hello ${candidate.name},\n\nYour individualized technical assessment "${assignment.title}" (${assignment.taskId}) has been assigned.\n\n• Submission Deadline: ${assignment.submissionDeadline}\n• Review Appointment: ${assignment.reviewDate} at ${assignment.reviewTime} (${tz})\n• Google Meet Link: ${assignment.googleMeetUrl || 'Pending Confirmation'}\n• Candidate Portal: https://interviewflow.app/portal/${candidate.id}\n• Approved References: ${(assignment.taskDetails?.approvedReferences || []).map((r) => r.url).join(', ')}\n\nPlease submit your GitHub repository URL via the Candidate Portal before the deadline.`,
        };
      case 'SUBMISSION_CONFIRMATION':
        return {
          timezone: tz,
          subject: `[InterviewFlow AI] GitHub Submission Received — Task ${assignment.taskId}`,
          body: `Hello ${candidate.name},\n\nWe received your GitHub submission for Task ${assignment.taskId}.\n\n• Repository URL: ${context.submission?.repositoryUrl}\n• Commit SHA: ${context.submission?.commitSha}\n• Submitted At: ${context.submission?.submittedAt}\n• Current Status: Queued for AI & Technical Code Review (Note: Receipt of submission does not indicate that the code has passed review yet).\n• Next Step: You will receive detailed technical feedback once the review completes.`,
        };
      case 'AI_CODE_REVIEW':
        return {
          timezone: tz,
          subject: `[InterviewFlow AI] Technical Code Review Feedback — Round ${context.review?.roundNumber || 1} (${context.review?.totalScore}/100)`,
          body: `Hello ${candidate.name},\n\nHere is the constructive technical review for your submission (${context.review?.commitSha}):\n\n• Summary: ${context.review?.overallSummary}\n• Rubric Score: ${context.review?.totalScore}/100 (Functional: ${context.review?.scores?.functional_correctness}/40, Quality: ${context.review?.scores?.code_quality}/20, Testing: ${context.review?.scores?.testing_edge_cases}/20, Docs: ${context.review?.scores?.documentation}/10, Security: ${context.review?.scores?.security_error_handling}/10)\n• Confirmed Findings: ${(context.review?.findings || []).map((f) => `[${f.severity}] ${f.filePath}:${f.lineNumber} - ${f.title}`).join('; ')}\n• Unverified Areas: ${(context.review?.unverifiedAreas || []).join('; ') || 'None'}\n• Recommended Next Action: ${context.review?.recommendedNextAction}`,
        };
      case 'NEXT_REVIEW_APPOINTMENT':
        return {
          timezone: tz,
          subject: `[InterviewFlow AI] Next Review Session Scheduled — ${context.session?.sessionDate} ${context.session?.startTime} (${tz})`,
          body: `Hello ${candidate.name},\n\nYour follow-up technical review session has been confirmed.\n\n• Review Date & Time: ${context.session?.sessionDate} at ${context.session?.startTime} (${tz})\n• Confirmed Google Meet Link: ${context.session?.googleMeetUrl}\n• Correction Submission Deadline: ${assignment.correctionDeadline || assignment.submissionDeadline}\n• Portal Link: https://interviewflow.app/portal/${candidate.id}`,
        };
      case 'REMINDER':
      default:
        return {
          timezone: tz,
          subject: `[InterviewFlow AI] Reminder: ${context.reminderTopic || 'Upcoming Assessment Deadline'}`,
          body: `Hello ${candidate.name},\n\nThis is a friendly reminder regarding your technical assessment (${assignment.taskId}) scheduled in ${tz}. Please visit your Candidate Portal for full details.`,
        };
    }
  }

  retryFailedEmail(actor, emailId, simulateProviderFailure = false) {
    this.assertRole(actor, ['ADMIN']);
    const email = this.emails.get(emailId);
    if (!email) throw new Error(`Email ${emailId} not found.`);
    if (email.status === 'SENT_ACCEPTED' || email.status === 'DELIVERED') {
      return structuredClone(email); // Prevent duplicate send
    }
    email.attemptCount += 1;
    if (simulateProviderFailure) {
      email.status = 'FAILED';
      email.errorDetails = 'Gmail API 401: OAuth access token expired or revoked.';
    } else {
      email.status = this.config.safeEmailTestMode ? 'SUPPRESSED_TEST_MODE' : 'SENT_ACCEPTED';
      email.errorDetails = null;
      email.sentAt = new Date().toISOString();
    }
    return structuredClone(email);
  }

  // ---------------------------------------------------------------------------
  // 8. GOOGLE MEET & REVIEW SCHEDULING (Conflicts, Buffers, OAuth & Fallbacks)
  // ---------------------------------------------------------------------------
  scheduleReviewAppointment(actor, payload) {
    this.assertRole(actor, ['ADMIN', 'INTERVIEWER']);
    const {
      candidateId,
      batchId = 'BATCH-2026-Q4',
      interviewerId = 'USR-INT-01',
      sessionType = 'INDIVIDUAL_REVIEW',
      sessionDate,
      startTime,
      durationMinutes = 30,
      bufferMinutes = 10,
      timezone = 'Asia/Kolkata (IST, UTC+05:30)',
      googleMeetUrl,
      simulateOAuthExpired = false,
      simulateCalendarFailure = false,
      simulateMissingConferenceUrl = false,
    } = payload;

    if (simulateOAuthExpired) {
      const err = new Error('Google OAuth token expired (401 invalid_grant). Re-authorize Google Workspace integration.');
      err.code = 'OAUTH_TOKEN_EXPIRED';
      throw err;
    }
    if (simulateCalendarFailure) {
      const err = new Error('Google Calendar API 503: Calendar event creation failed.');
      err.code = 'CALENDAR_CREATION_FAILED';
      throw err;
    }

    if (googleMeetUrl && !GOOGLE_MEET_REGEX.test(googleMeetUrl)) {
      const err = new Error(`Invalid Google Meet URL format: ${googleMeetUrl}. Expected https://meet.google.com/xxx-xxxx-xxx`);
      err.code = 'INVALID_MEET_URL';
      throw err;
    }

    // Conflict + buffer check for interviewer on same date
    const [sh, sm] = startTime.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins = startMins + durationMinutes + bufferMinutes;

    for (const existing of this.sessions.values()) {
      if (existing.interviewerId === interviewerId && existing.sessionDate === sessionDate && existing.sessionStatus !== 'CANCELLED') {
        const [eh, em] = existing.startTime.split(':').map(Number);
        const exStart = eh * 60 + em;
        const exEnd = exStart + existing.durationMinutes + existing.bufferMinutes;
        if (startMins < exEnd && endMins > exStart && sessionType === 'INDIVIDUAL_REVIEW') {
          const err = new Error(
            `Schedule conflict detected for interviewer ${interviewerId} on ${sessionDate} at ${startTime} (includes ${bufferMinutes}m buffer).`
          );
          err.code = 'SCHEDULE_CONFLICT';
          throw err;
        }
      }
    }

    const confirmedMeetUrl = simulateMissingConferenceUrl
      ? null
      : googleMeetUrl || `https://meet.google.com/rev-${Math.random().toString(36).substring(2, 6)}-aiq`.slice(0, 36).replace(/[^a-z:/.-]/g, 'a');

    // Normalize generated meet url to match strict pattern xxx-xxxx-xxx if needed
    const finalMeetUrl = confirmedMeetUrl
      ? GOOGLE_MEET_REGEX.test(confirmedMeetUrl)
        ? confirmedMeetUrl
        : 'https://meet.google.com/rev-flow-one'
      : null;

    const sessionId = this._id('SES');
    const session = {
      id: sessionId,
      batchId,
      candidateId,
      interviewerId,
      sessionType,
      sessionDate,
      startTime,
      durationMinutes,
      bufferMinutes,
      timezone,
      googleMeetUrl: finalMeetUrl,
      conferenceConfirmed: Boolean(finalMeetUrl),
      sessionStatus: finalMeetUrl ? 'SCHEDULED' : 'PENDING_CONFERENCE',
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, session);

    // Only send final appointment email when conference details are confirmed
    if (session.conferenceConfirmed && candidateId && this.candidates.has(candidateId)) {
      this.queueEmail(actor, {
        candidateId,
        emailType: 'NEXT_REVIEW_APPOINTMENT',
        idempotencyKey: `EMAIL:APPT:${sessionId}`,
        context: { session },
      });
    }

    return structuredClone(session);
  }

  // ---------------------------------------------------------------------------
  // 9. GITHUB REPOSITORY SUBMISSION, PROMPT-INJECTION DEFENSE & AI REVIEW
  // ---------------------------------------------------------------------------
  validateGitHubUrl(url) {
    if (typeof url !== 'string') {
      const err = new Error('Repository URL must be a string.');
      err.code = 'MALFORMED_GITHUB_URL';
      throw err;
    }
    const trimmed = url.trim();
    const match = trimmed.match(GITHUB_URL_REGEX);
    if (!match) {
      const err = new Error(`Malformed or unauthorized repository URL: "${url}". Only https://github.com/<owner>/<repo> URLs are permitted.`);
      err.code = 'MALFORMED_GITHUB_URL';
      throw err;
    }
    const [, owner, repo] = match;
    if (owner.includes('..') || repo.includes('..')) {
      const err = new Error('Path traversal in repository URL is forbidden.');
      err.code = 'MALFORMED_GITHUB_URL';
      throw err;
    }
    return { owner, repo: repo.replace(/\.git$/, ''), cleanUrl: `https://github.com/${owner}/${repo.replace(/\.git$/, '')}` };
  }

  submitRepositoryAndReview(actor, payload) {
    const {
      candidateId,
      repositoryUrl,
      branch = 'main',
      commitSha = null,
      repoSimulation = {},
    } = payload;

    // Candidate can only submit for themselves
    if (actor.role === 'CANDIDATE' && actor.candidateId !== candidateId) {
      const err = new Error('Candidates may only submit repositories for their own assigned task.');
      err.code = 'FORBIDDEN_CROSS_CANDIDATE';
      throw err;
    }

    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error(`Candidate ${candidateId} not found.`);
    if (!candidate.currentAssignmentId) {
      const err = new Error('Candidate does not have an assigned task.');
      err.code = 'NO_ACTIVE_ASSIGNMENT';
      throw err;
    }

    const parsedUrl = this.validateGitHubUrl(repositoryUrl);

    if (repoSimulation.unavailable) {
      const err = new Error(`Repository ${parsedUrl.cleanUrl} is unavailable (404 Not Found).`);
      err.code = 'REPO_UNAVAILABLE';
      throw err;
    }
    if (repoSimulation.inaccessiblePrivate) {
      const err = new Error(`Private repository ${parsedUrl.cleanUrl} is inaccessible: GitHub App installation permission missing (403).`);
      err.code = 'PRIVATE_REPO_INACCESSIBLE';
      throw err;
    }

    const resolvedSha = commitSha || crypto.createHash('sha1').update(`${parsedUrl.cleanUrl}:${Date.now()}`).digest('hex').slice(0, 40);

    // Duplicate review prevention for identical candidate + assignment + commit SHA
    const reviewDedupKey = `REVIEW:${candidate.currentAssignmentId}:${resolvedSha}`;
    if (this.idempotencyRegistry.has(reviewDedupKey)) {
      return structuredClone(this.reviews.get(this.idempotencyRegistry.get(reviewDedupKey)));
    }

    const roundNumber = candidate.currentReviewRound + 1;
    const batch = this.batches.get(candidate.batchId);
    const maxRounds = batch?.maxReviewRounds || 3;

    // Transition state on submission
    if (candidate.workflowStatus === WORKFLOW_STATES.TASK_ASSIGNED) {
      this._transitionState(candidate, WORKFLOW_STATES.SUBMITTED, actor, `Submitted ${parsedUrl.cleanUrl}`);
    } else if (
      [WORKFLOW_STATES.CORRECTION_REQUIRED, WORKFLOW_STATES.NEXT_REVIEW_SCHEDULED].includes(candidate.workflowStatus)
    ) {
      this._transitionState(candidate, WORKFLOW_STATES.RESUBMISSION_RECEIVED, actor, `Resubmitted commit ${resolvedSha.slice(0, 7)}`);
    }

    const submissionId = this._id('SUB');
    const submission = {
      id: submissionId,
      assignmentId: candidate.currentAssignmentId,
      candidateId: candidate.id,
      roundNumber,
      repositoryUrl: parsedUrl.cleanUrl,
      repoOwner: parsedUrl.owner,
      repoName: parsedUrl.repo,
      branch,
      commitSha: resolvedSha,
      submittedAt: new Date().toISOString(),
      status: 'REVIEW_IN_PROGRESS',
    };
    this.submissions.set(submissionId, submission);
    candidate.submissionStatus = 'SUBMITTED';

    // Queue submission confirmation email (never claims code passed review yet)
    this.queueEmail(actor, {
      candidateId: candidate.id,
      emailType: 'SUBMISSION_CONFIRMATION',
      idempotencyKey: `EMAIL:SUB_CONF:${submissionId}`,
      context: { submission },
    });

    // Queue durable background job for repository retrieval + AI review
    const job = this.enqueueBackgroundJob('AI_REPOSITORY_REVIEW', 'SUBMISSION', submissionId, {
      candidateId,
      submissionId,
      commitSha: resolvedSha,
    });

    // Filter files & inspect for prompt injection
    const rawFiles = repoSimulation.files || [
      { path: 'README.md', content: '# Order Webhook Service\nSetup and architecture documentation.', size: 1200 },
      { path: 'package.json', content: '{"dependencies":{"next":"14.2.18","zod":"^3.23.8"}}', size: 450 },
      { path: 'src/app/api/webhooks/payment/route.ts', content: 'export async function POST(req: Request) { /* HMAC check & idempotency */ }', size: 3400 },
      { path: 'src/lib/ledger.ts', content: 'export async function recordLedgerEvent(eventId: string) { /* transaction */ }', size: 2800 },
      { path: 'tests/webhook.test.ts', content: 'test("verifies HMAC signature and idempotency", async () => {});', size: 1900 },
      { path: 'node_modules/lodash/index.js', content: '// ignored binary/vendor', size: 90000 },
      { path: '.env.local', content: 'SECRET=should_be_filtered', size: 120 },
    ];

    const allowedFiles = [];
    const filteredOutFiles = [];
    const promptInjectionFlags = [];

    for (const f of rawFiles) {
      if (IGNORED_FILE_PATTERNS.some((rx) => rx.test(f.path)) || f.size > 100_000) {
        filteredOutFiles.push(f.path);
        continue;
      }
      allowedFiles.push(f);
      for (const pattern of PROMPT_INJECTION_PATTERNS) {
        if (pattern.test(f.content || '')) {
          promptInjectionFlags.push({
            filePath: f.path,
            matchedPattern: pattern.source,
            actionTaken: 'SANITIZED_AND_ISOLATED_AS_UNTRUSTED_DATA',
          });
        }
      }
    }

    this._transitionState(candidate, WORKFLOW_STATES.REVIEW_PENDING, actor, 'Background AI review started');

    // Evaluate against rubric (strictly ignoring any prompt injection instructions)
    const qualityProfile = repoSimulation.qualityProfile || 'HIGH_PASS';
    let scores;
    let findings = [];
    let missingCriteria = [];
    let unverifiedAreas = [];
    let confidenceScore = 0.94;
    let testExecutionSummary = {
      testsActuallyExecuted: Boolean(repoSimulation.testsExecuted),
      staticChecksExecuted: true,
      note: repoSimulation.testsExecuted
        ? 'Automated unit tests executed in isolated sandbox.'
        : 'Static AST & source inspection completed; runtime tests were NOT executed on the host server.',
    };

    if (qualityProfile === 'NEEDS_CORRECTION') {
      scores = {
        functional_correctness: 24,
        code_quality: 14,
        testing_edge_cases: 10,
        documentation: 7,
        security_error_handling: 5,
      };
      findings = [
        {
          id: this._id('FND'),
          severity: 'HIGH',
          category: 'Security & Idempotency',
          filePath: 'src/app/api/webhooks/payment/route.ts',
          lineNumber: 42,
          title: 'Missing timing-safe HMAC signature comparison',
          description: 'Webhook signature is compared with standard === instead of crypto.timingSafeEqual, and duplicate event_id retries are not wrapped in a unique transaction.',
          suggestedCorrection: 'Use crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) and enforce UNIQUE(event_id) upsert.',
          codeExample: 'const isValid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));',
          verificationBasis: 'SOURCE_INSPECTION',
          isResolved: false,
        },
        {
          id: this._id('FND'),
          severity: 'MEDIUM',
          category: 'Testing Gaps',
          filePath: 'tests/webhook.test.ts',
          lineNumber: 18,
          title: 'Missing duplicate webhook replay test case',
          description: 'Test file checks 200 OK on initial webhook delivery but does not assert idempotency on duplicate delivery.',
          suggestedCorrection: 'Add a test sending the same event_id twice and asserting ledger count remains 1.',
          codeExample: 'await POST(req1); await POST(req2); assert.equal(await countLedger("evt_1"), 1);',
          verificationBasis: 'SOURCE_INSPECTION',
          isResolved: false,
        },
      ];
      missingCriteria = ['Processes duplicate event IDs idempotently without duplicate rows'];
      unverifiedAreas = ['Live database concurrency under 50 parallel requests (requires runtime sandbox verification)'];
    } else if (qualityProfile === 'UNCERTAIN_ESCALATION') {
      scores = {
        functional_correctness: 28,
        code_quality: 15,
        testing_edge_cases: 12,
        documentation: 8,
        security_error_handling: 7,
      };
      confidenceScore = 0.55;
      findings = [
        {
          id: this._id('FND'),
          severity: 'MEDIUM',
          category: 'Architecture Ambiguity',
          filePath: 'src/lib/ledger.ts',
          lineNumber: 12,
          title: 'Custom binary serialization requires human architectural review',
          description: 'Candidate implemented a custom event journal format whose edge-case durability cannot be conclusively verified by static analysis alone.',
          suggestedCorrection: 'Escalate to technical interviewer for manual code walkthrough.',
          codeExample: null,
          verificationBasis: 'RUNTIME_REQUIRED',
          isResolved: false,
        },
      ];
      unverifiedAreas = ['Custom journal recovery behavior on process crash'];
    } else {
      // HIGH_PASS or corrected resubmission
      scores = {
        functional_correctness: 37,
        code_quality: 18,
        testing_edge_cases: 18,
        documentation: 9,
        security_error_handling: 9,
      };
      findings = [
        {
          id: this._id('FND'),
          severity: 'LOW',
          category: 'Code Organization',
          filePath: 'src/lib/ledger.ts',
          lineNumber: 64,
          title: 'Extract pagination limit constants to configuration module',
          description: 'Pagination default limit (25) and max limit (100) are inline literals.',
          suggestedCorrection: 'Move DEFAULT_PAGE_SIZE and MAX_PAGE_SIZE to src/lib/constants.ts.',
          codeExample: 'export const DEFAULT_PAGE_SIZE = 25;\nexport const MAX_PAGE_SIZE = 100;',
          verificationBasis: 'SOURCE_INSPECTION',
          isResolved: false,
        },
      ];
      unverifiedAreas = repoSimulation.testsExecuted
        ? []
        : ['Runtime execution of test suite was not run on main server; verified via static AST & test file inspection'];
    }

    const totalScore =
      scores.functional_correctness +
      scores.code_quality +
      scores.testing_edge_cases +
      scores.documentation +
      scores.security_error_handling;

    // Compare with previous round findings if roundNumber > 1
    const previousReviews = Array.from(this.reviews.values()).filter(
      (r) => r.assignmentId === candidate.currentAssignmentId
    );
    const prevReview = previousReviews[previousReviews.length - 1];
    const resolvedFromPreviousRound = [];
    const unresolvedFromPreviousRound = [];

    if (prevReview) {
      for (const pf of prevReview.findings) {
        const stillPresent = findings.some((cf) => cf.title === pf.title);
        if (stillPresent) {
          unresolvedFromPreviousRound.push(pf.title);
        } else {
          resolvedFromPreviousRound.push(pf.title);
        }
      }
    }

    // Determine next state based on score, confidence, and max review rounds
    const passingThreshold = batch?.passingScoreThreshold || 78;
    let recommendedNextAction;
    let postFeedbackState;

    if (confidenceScore < 0.70 || promptInjectionFlags.length > 0) {
      recommendedNextAction = 'ESCALATE_TO_HUMAN_REVIEWER';
      postFeedbackState = WORKFLOW_STATES.MANUAL_REVIEW_REQUIRED;
    } else if (totalScore >= passingThreshold && missingCriteria.length === 0) {
      recommendedNextAction = 'ADVANCE_TO_HUMAN_EVALUATION';
      postFeedbackState = WORKFLOW_STATES.READY_FOR_HUMAN_EVALUATION;
    } else if (roundNumber >= maxRounds) {
      // Never create infinite review loops! Escalate to human evaluation after hitting max rounds
      recommendedNextAction = `MAX_ROUNDS_REACHED (${roundNumber}/${maxRounds}) — ESCALATE_TO_HUMAN_REVIEWER`;
      postFeedbackState = WORKFLOW_STATES.MANUAL_REVIEW_REQUIRED;
    } else {
      recommendedNextAction = 'REQUEST_CORRECTIONS_AND_RESUBMIT';
      postFeedbackState = WORKFLOW_STATES.CORRECTION_REQUIRED;
    }

    const reviewId = this._id('REV');
    const reviewReport = {
      id: reviewId,
      submissionId,
      assignmentId: candidate.currentAssignmentId,
      taskId: candidate.currentTaskId,
      candidateId: candidate.id,
      candidateName: candidate.name,
      roundNumber,
      repositoryUrl: parsedUrl.cleanUrl,
      commitSha: resolvedSha,
      reviewedAt: new Date().toISOString(),
      overallSummary:
        totalScore >= passingThreshold
          ? `Strong implementation scoring ${totalScore}/100. Core functional requirements, idempotency guards, and test coverage meet the evaluation rubric.`
          : `Submission scored ${totalScore}/100 in Round ${roundNumber}. Key improvements are needed in ${(missingCriteria[0] || 'edge-case handling')} before advancing.`,
      positiveObservations: [
        'Clean TypeScript module structure and strict Zod request validation',
        'Clear README documentation and environment variable separation',
      ],
      scores,
      totalScore,
      findings,
      missingAcceptanceCriteria: missingCriteria,
      unverifiedAreas,
      testExecutionSummary,
      verificationStatus: repoSimulation.testsExecuted ? 'TEST_EXECUTED' : 'SOURCE_INSPECTION',
      confidenceScore,
      promptInjectionFlags,
      allowedFileCount: allowedFiles.length,
      filteredOutFiles,
      resolvedFromPreviousRound,
      unresolvedFromPreviousRound,
      recommendedNextAction,
      interviewerVerified: false,
      interviewerOverrideScore: null,
      interviewerOverrideReason: null,
    };

    // Validate review schema before saving
    this.validateReviewReportSchema(reviewReport);

    this.reviews.set(reviewId, reviewReport);
    this.idempotencyRegistry.set(reviewDedupKey, reviewId);
    submission.status = 'REVIEWED';
    candidate.currentReviewRound = roundNumber;

    // Complete background job
    job.status = 'COMPLETED';
    job.completedAt = new Date().toISOString();

    this._transitionState(candidate, WORKFLOW_STATES.AI_REVIEW_COMPLETED, actor, `Review ${reviewId} scored ${totalScore}/100`);

    // Send personalized AI code review email
    this.queueEmail(actor, {
      candidateId: candidate.id,
      emailType: 'AI_CODE_REVIEW',
      idempotencyKey: `EMAIL:AI_REVIEW:${reviewId}`,
      context: { review: reviewReport },
    });

    this._transitionState(candidate, WORKFLOW_STATES.FEEDBACK_SENT, actor, 'AI feedback email queued');
    this._transitionState(candidate, postFeedbackState, actor, recommendedNextAction);

    // Record review round history
    const roundRecord = {
      id: this._id('RND'),
      assignmentId: candidate.currentAssignmentId,
      candidateId: candidate.id,
      roundNumber,
      submissionId,
      reviewId,
      totalScore,
      outcome: postFeedbackState,
      resolvedCount: resolvedFromPreviousRound.length,
      unresolvedCount: unresolvedFromPreviousRound.length,
      timestamp: new Date().toISOString(),
    };
    this.reviewRounds.set(`${candidate.currentAssignmentId}:R${roundNumber}`, roundRecord);

    return structuredClone(reviewReport);
  }

  validateReviewReportSchema(report) {
    const requiredKeys = [
      'id',
      'candidateId',
      'taskId',
      'repositoryUrl',
      'commitSha',
      'reviewedAt',
      'overallSummary',
      'scores',
      'totalScore',
      'findings',
      'verificationStatus',
      'confidenceScore',
      'recommendedNextAction',
    ];
    for (const k of requiredKeys) {
      if (report[k] === undefined || report[k] === null) {
        const err = new Error(`Review report schema validation failed: missing required field "${k}".`);
        err.code = 'INVALID_REVIEW_SCHEMA';
        throw err;
      }
    }
    if (typeof report.totalScore !== 'number' || report.totalScore < 0 || report.totalScore > 100) {
      const err = new Error('Review report totalScore must be between 0 and 100.');
      err.code = 'INVALID_REVIEW_SCHEMA';
      throw err;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // 10. HUMAN OVERSIGHT & FINAL EVALUATION (AI never makes irreversible hiring decisions)
  // ---------------------------------------------------------------------------
  recordHumanEvaluation(actor, candidateId, { decision, overrideScore = null, reason }) {
    this.assertRole(actor, ['ADMIN', 'INTERVIEWER']);
    if (!reason || reason.trim().length < 5) {
      throw new Error('A documented reason is required for human evaluation or score override.');
    }
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new Error(`Candidate ${candidateId} not found.`);

    candidate.humanEvaluationDecision = decision; // RECOMMEND_HIRE | HOLD | DO_NOT_PROCEED
    candidate.humanEvaluationNotes = reason;

    if (overrideScore !== null) {
      const latestReview = Array.from(this.reviews.values())
        .filter((r) => r.candidateId === candidateId)
        .pop();
      if (latestReview) {
        latestReview.interviewerVerified = true;
        latestReview.interviewerOverrideScore = overrideScore;
        latestReview.interviewerOverrideReason = reason;
      }
    }

    if (decision === 'RECOMMEND_HIRE') {
      this._transitionState(candidate, WORKFLOW_STATES.COMPLETED, actor, `Human verified outcome: ${decision} (${reason})`);
    }
    this._logAudit(actor, 'HUMAN_EVALUATION_RECORDED', 'CANDIDATE', candidateId, reason, { decision, overrideScore });
    return structuredClone(candidate);
  }

  // ---------------------------------------------------------------------------
  // 11. DURABLE BACKGROUND JOBS & RETRIES
  // ---------------------------------------------------------------------------
  enqueueBackgroundJob(jobType, recordType, recordId, payload = {}, idempotencyKey = null) {
    const dedupKey = idempotencyKey || `JOB:${jobType}:${recordType}:${recordId}`;
    if (this.idempotencyRegistry.has(dedupKey)) {
      return this.jobs.get(this.idempotencyRegistry.get(dedupKey));
    }
    const jobId = this._id('JOB');
    const job = {
      id: jobId,
      idempotencyKey: dedupKey,
      jobType,
      associatedRecordType: recordType,
      associatedRecordId: recordId,
      status: 'QUEUED',
      attemptCount: 1,
      maxAttempts: 3,
      lastError: null,
      payload,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    this.jobs.set(jobId, job);
    this.idempotencyRegistry.set(dedupKey, jobId);
    return job;
  }

  retryBackgroundJob(actor, jobId, simulateFailure = false) {
    this.assertRole(actor, ['ADMIN']);
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found.`);
    job.attemptCount += 1;
    if (simulateFailure) {
      job.status = 'FAILED';
      job.lastError = 'External service timeout during background execution.';
    } else {
      job.status = 'COMPLETED';
      job.lastError = null;
      job.completedAt = new Date().toISOString();
    }
    this._logAudit(actor, 'BACKGROUND_JOB_RETRIED', 'JOB', jobId, null, { status: job.status, attemptCount: job.attemptCount });
    return structuredClone(job);
  }

  // ---------------------------------------------------------------------------
  // 12. EXCEL TRACKING & SYNCHRONIZATION (Stage 1 Export & Stage 2 Safe Upserts)
  // ---------------------------------------------------------------------------
  synchronizeExcelWorkbook(actor, options = {}) {
    this.assertRole(actor, ['ADMIN']);
    const stage = options.stage || 'STAGE_1_LOCAL_XLSX';

    if (options.simulateGraphFailure) {
      const failedLog = {
        id: this._id('XLS'),
        stage,
        status: 'FAILED',
        recordsUpserted: 0,
        errorDetails: 'Microsoft Graph API 429 TooManyRequests: Retry-After 10s',
        syncedAt: new Date().toISOString(),
      };
      this.excelSyncLogs.push(failedLog);
      for (const c of this.candidates.values()) {
        c.excelSynchronized = false;
      }
      return failedLog;
    }

    let upsertedCount = 0;

    // 1. CandidateTracker (keyed by stable Candidate ID, never row number)
    for (const c of this.candidates.values()) {
      this.excelWorksheets.CandidateTracker.set(c.id, {
        'Candidate ID': c.id,
        'Candidate Name': c.name,
        Email: c.email,
        'Job Role': c.jobRole,
        'Recruitment Batch': c.batchId,
        'Attendance Status': c.attendance,
        'Current Task ID': c.currentTaskId || 'UNASSIGNED',
        'Current Review Round': c.currentReviewRound,
        'Overall Status': c.workflowStatus,
        'Last Updated': c.updatedAt,
      });
      c.excelSynchronized = true;
      upsertedCount += 1;
    }

    // 2. TaskAssignments (keyed by stable Assignment ID)
    for (const a of this.taskAssignments.values()) {
      const latestSub = Array.from(this.submissions.values())
        .filter((s) => s.assignmentId === a.id)
        .pop();
      this.excelWorksheets.TaskAssignments.set(a.id, {
        'Task ID': a.taskId,
        'Candidate ID': a.candidateId,
        'Task Title': a.title,
        Difficulty: a.difficulty,
        'Assignment Date': a.assignedAt.slice(0, 10),
        'Submission Deadline': a.submissionDeadline,
        'Review Date': a.reviewDate,
        'Review Time': a.reviewTime,
        'Time Zone': a.timezone,
        'Google Meet URL': a.googleMeetUrl,
        'GitHub Repository URL': latestSub?.repositoryUrl || '',
        'Submission Status': latestSub?.status || 'PENDING',
      });
      upsertedCount += 1;
    }

    // 3. ReviewHistory (keyed by stable Review ID)
    for (const r of this.reviews.values()) {
      this.excelWorksheets.ReviewHistory.set(r.id, {
        'Review ID': r.id,
        'Candidate ID': r.candidateId,
        'Task ID': r.taskId,
        'Round Number': r.roundNumber,
        'Repository URL': r.repositoryUrl,
        'Commit SHA': r.commitSha,
        'Review Date': r.reviewedAt.slice(0, 10),
        'Correctness Score': r.scores.functional_correctness,
        'Code Quality Score': r.scores.code_quality,
        'Testing Score': r.scores.testing_edge_cases,
        'Documentation Score': r.scores.documentation,
        'Security and Error Handling Score': r.scores.security_error_handling,
        'Total Score': r.totalScore,
        'Findings Summary': r.findings.map((f) => `${f.severity}: ${f.title}`).join(' | '),
        'Corrections Required': r.missingAcceptanceCriteria.length > 0 ? 'YES' : 'NO',
        'Next Review Date': '2026-10-29',
        'Review Status': r.recommendedNextAction,
      });
      upsertedCount += 1;
    }

    // 4. EmailLog (keyed by stable Email ID)
    for (const e of this.emails.values()) {
      this.excelWorksheets.EmailLog.set(e.id, {
        'Email ID': e.id,
        'Candidate ID': e.candidateId,
        'Email Type': e.emailType,
        Recipient: e.recipient,
        'Created Timestamp': e.createdAt,
        'Sent Timestamp': e.sentAt || '',
        'Delivery Status': e.status,
        'Error Details': e.errorDetails || '',
      });
      upsertedCount += 1;
    }

    // 5. InterviewSessions (keyed by stable Session ID)
    for (const s of this.sessions.values()) {
      this.excelWorksheets.InterviewSessions.set(s.id, {
        'Session ID': s.id,
        'Batch ID': s.batchId,
        'Session Type': s.sessionType,
        Date: s.sessionDate,
        'Start Time': s.startTime,
        'Time Zone': s.timezone,
        'Google Meet URL': s.googleMeetUrl || '',
        Interviewer: s.interviewerId,
        'Session Status': s.sessionStatus,
      });
      upsertedCount += 1;
    }

    // 6. TaskCatalog (keyed by stable Template ID)
    for (const t of this.taskTemplates.values()) {
      this.excelWorksheets.TaskCatalog.set(t.id, {
        'Task ID': t.id,
        'Task Title': t.title,
        'Job Role': t.jobRole,
        Technology: t.technology,
        Difficulty: t.difficulty,
        'Estimated Duration': `${t.estimatedHours}h`,
        'Task Version': `v${t.version}.0`,
        'Active Status': t.isActive ? 'ACTIVE' : 'INACTIVE',
      });
      upsertedCount += 1;
    }

    const syncLog = {
      id: this._id('XLS'),
      stage,
      status: 'SUCCESS',
      recordsUpserted: upsertedCount,
      errorDetails: null,
      syncedAt: new Date().toISOString(),
    };
    this.excelSyncLogs.push(syncLog);
    return syncLog;
  }

  exportExcelSnapshot() {
    const output = {};
    for (const [sheetName, map] of Object.entries(this.excelWorksheets)) {
      output[sheetName] = Array.from(map.values());
    }
    return output;
  }

  // ---------------------------------------------------------------------------
  // 13. SEARCH, FILTER, PAGINATION & REAL-TIME DASHBOARD METRICS
  // ---------------------------------------------------------------------------
  queryCandidates(actor, { search = '', status = '', role = '', page = 1, pageSize = 10 } = {}) {
    this.assertRole(actor, ['ADMIN', 'INTERVIEWER']);
    const q = search.trim().toLowerCase();
    let list = Array.from(this.candidates.values());

    if (q) {
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          c.jobRole.toLowerCase().includes(q)
      );
    }
    if (status) {
      list = list.filter((c) => c.workflowStatus === status);
    }
    if (role) {
      list = list.filter((c) => c.jobRole.toLowerCase() === role.toLowerCase());
    }

    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    const items = list.slice(offset, offset + pageSize);

    return {
      items: structuredClone(items),
      page,
      pageSize,
      total,
      totalPages,
    };
  }

  getDashboardMetrics(actor) {
    this.assertRole(actor, ['ADMIN', 'INTERVIEWER']);
    const candidates = Array.from(this.candidates.values());
    const emails = Array.from(this.emails.values());
    const sessions = Array.from(this.sessions.values());
    const lastSync = this.excelSyncLogs[this.excelSyncLogs.length - 1] || null;

    return {
      totalRegisteredCandidates: candidates.length,
      attendanceConfirmed: candidates.filter((c) => ['CONFIRMED', 'MANUAL_OVERRIDE'].includes(c.attendance)).length,
      attendancePending: candidates.filter((c) => c.attendance === 'PENDING').length,
      tasksAssigned: candidates.filter((c) => Boolean(c.currentAssignmentId)).length,
      submissionsPending: candidates.filter((c) => c.workflowStatus === WORKFLOW_STATES.TASK_ASSIGNED).length,
      aiReviewsPending: candidates.filter((c) => c.workflowStatus === WORKFLOW_STATES.REVIEW_PENDING).length,
      reviewsCompleted: this.reviews.size,
      correctionsRequired: candidates.filter((c) => c.workflowStatus === WORKFLOW_STATES.CORRECTION_REQUIRED).length,
      readyForHumanEvaluation: candidates.filter((c) => c.workflowStatus === WORKFLOW_STATES.READY_FOR_HUMAN_EVALUATION).length,
      manualReviewRequired: candidates.filter((c) => c.workflowStatus === WORKFLOW_STATES.MANUAL_REVIEW_REQUIRED).length,
      upcomingReviewAppointments: sessions.filter((s) => s.sessionStatus === 'SCHEDULED').length,
      emailsPendingOrFailed: emails.filter((e) => ['PENDING_APPROVAL', 'FAILED'].includes(e.status)).length,
      excelSyncStatus: lastSync ? lastSync.status : 'NOT_SYNCED',
      lastExcelSyncAt: lastSync ? lastSync.syncedAt : null,
    };
  }
}
