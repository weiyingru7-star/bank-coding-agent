export type QueueJobStatus =
  | "READY"
  | "LEASED"
  | "SUCCEEDED"
  | "FAILED"
  | "DEAD_LETTER"
  | "CANCELLED";

export interface QueueJob<TPayload = unknown, TResult = unknown> {
  jobId: string;
  tenantId: string;
  idempotencyKey: string;
  resourceKey: string;
  payload: TPayload;
  status: QueueJobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  createdAt: number;
  updatedAt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  cancelRequested: boolean;
  result?: TResult;
  lastErrorCode?: string;
}

export interface EnqueueRequest<TPayload> {
  jobId: string;
  tenantId: string;
  idempotencyKey: string;
  resourceKey: string;
  payload: TPayload;
  priority?: number;
  maxAttempts?: number;
}

export interface QueueEvent {
  sequence: number;
  jobId: string;
  type:
    | "ENQUEUED"
    | "IDEMPOTENT_REUSE"
    | "LEASED"
    | "HEARTBEAT"
    | "LEASE_EXPIRED"
    | "RETRY_SCHEDULED"
    | "SUCCEEDED"
    | "FAILED"
    | "DEAD_LETTERED"
    | "CANCEL_REQUESTED"
    | "CANCELLED";
  workerId?: string;
  timestamp: number;
  data?: Record<string, string | number | boolean>;
}

export interface QueueSnapshot<TPayload = unknown, TResult = unknown> {
  version: 1;
  sequence: number;
  jobs: Array<QueueJob<TPayload, TResult>>;
  idempotencyEntries: Array<[string, string]>;
  events: QueueEvent[];
}

export class QueueLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueLeaseError";
  }
}

export class InMemoryTaskQueue<TPayload = unknown, TResult = unknown> {
  private readonly jobs = new Map<string, QueueJob<TPayload, TResult>>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly events: QueueEvent[] = [];
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: {
    now?: () => number;
    snapshot?: QueueSnapshot<TPayload, TResult>;
  } = {}) {
    this.now = options.now ?? Date.now;
    if (options.snapshot) {
      this.restore(options.snapshot);
    }
  }

  enqueue(request: EnqueueRequest<TPayload>): {
    job: QueueJob<TPayload, TResult>;
    reused: boolean;
  } {
    validateEnqueueRequest(request);
    const idempotencyScope = `${request.tenantId}:${request.idempotencyKey}`;
    const existingJobId = this.idempotencyIndex.get(idempotencyScope);
    if (existingJobId) {
      const existing = this.requireJob(existingJobId);
      this.emit(existing.jobId, "IDEMPOTENT_REUSE");
      return { job: structuredClone(existing), reused: true };
    }
    if (this.jobs.has(request.jobId)) {
      throw new Error(`Queue job already exists: ${request.jobId}`);
    }

    const now = this.now();
    const job: QueueJob<TPayload, TResult> = {
      jobId: request.jobId,
      tenantId: request.tenantId,
      idempotencyKey: request.idempotencyKey,
      resourceKey: request.resourceKey,
      payload: structuredClone(request.payload),
      status: "READY",
      priority: clampInteger(request.priority ?? 0, -100, 100),
      attempts: 0,
      maxAttempts: clampInteger(request.maxAttempts ?? 3, 1, 20),
      availableAt: now,
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
    };
    this.jobs.set(job.jobId, job);
    this.idempotencyIndex.set(idempotencyScope, job.jobId);
    this.emit(job.jobId, "ENQUEUED");
    return { job: structuredClone(job), reused: false };
  }

  leaseNext(workerId: string, leaseMs = 30_000): QueueJob<TPayload, TResult> | undefined {
    validateWorkerId(workerId);
    const safeLeaseMs = clampInteger(leaseMs, 1_000, 600_000);
    this.recoverExpiredLeases();
    const now = this.now();
    const activeResources = new Set(
      [...this.jobs.values()]
        .filter(
          (job) =>
            job.status === "LEASED" &&
            (job.leaseExpiresAt ?? 0) > now,
        )
        .map((job) => job.resourceKey),
    );
    const candidate = [...this.jobs.values()]
      .filter(
        (job) =>
          job.status === "READY" &&
          !job.cancelRequested &&
          job.availableAt <= now &&
          !activeResources.has(job.resourceKey),
      )
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          left.availableAt - right.availableAt ||
          left.createdAt - right.createdAt ||
          left.jobId.localeCompare(right.jobId),
      )[0];
    if (!candidate) {
      return undefined;
    }

    candidate.status = "LEASED";
    candidate.leaseOwner = workerId;
    candidate.leaseExpiresAt = now + safeLeaseMs;
    candidate.attempts += 1;
    candidate.updatedAt = now;
    this.emit(candidate.jobId, "LEASED", workerId, {
      attempt: candidate.attempts,
      leaseExpiresAt: candidate.leaseExpiresAt,
    });
    return structuredClone(candidate);
  }

  heartbeat(jobId: string, workerId: string, leaseMs = 30_000): QueueJob<TPayload, TResult> {
    const job = this.requireActiveLease(jobId, workerId);
    job.leaseExpiresAt = this.now() + clampInteger(leaseMs, 1_000, 600_000);
    job.updatedAt = this.now();
    this.emit(jobId, "HEARTBEAT", workerId, {
      leaseExpiresAt: job.leaseExpiresAt,
    });
    return structuredClone(job);
  }

  complete(jobId: string, workerId: string, result: TResult): QueueJob<TPayload, TResult> {
    const job = this.requireActiveLease(jobId, workerId);
    job.updatedAt = this.now();
    job.leaseOwner = undefined;
    job.leaseExpiresAt = undefined;
    if (job.cancelRequested) {
      job.status = "CANCELLED";
      this.emit(jobId, "CANCELLED", workerId);
    } else {
      job.status = "SUCCEEDED";
      job.result = structuredClone(result);
      this.emit(jobId, "SUCCEEDED", workerId);
    }
    return structuredClone(job);
  }

  fail(
    jobId: string,
    workerId: string,
    options: {
      errorCode: string;
      retryable: boolean;
      retryDelayMs?: number;
    },
  ): QueueJob<TPayload, TResult> {
    const job = this.requireActiveLease(jobId, workerId);
    const now = this.now();
    job.updatedAt = now;
    job.lastErrorCode = sanitizeErrorCode(options.errorCode);
    job.leaseOwner = undefined;
    job.leaseExpiresAt = undefined;

    if (job.cancelRequested) {
      job.status = "CANCELLED";
      this.emit(jobId, "CANCELLED", workerId);
    } else if (options.retryable && job.attempts < job.maxAttempts) {
      job.status = "READY";
      job.availableAt = now + clampInteger(options.retryDelayMs ?? 0, 0, 3_600_000);
      this.emit(jobId, "RETRY_SCHEDULED", workerId, {
        attempt: job.attempts,
        availableAt: job.availableAt,
      });
    } else {
      job.status = options.retryable ? "DEAD_LETTER" : "FAILED";
      this.emit(
        jobId,
        options.retryable ? "DEAD_LETTERED" : "FAILED",
        workerId,
        {
          retryable: options.retryable,
          attempts: job.attempts,
        },
      );
    }
    return structuredClone(job);
  }

  requestCancel(jobId: string): QueueJob<TPayload, TResult> {
    const job = this.requireJob(jobId);
    if (["SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"].includes(job.status)) {
      return structuredClone(job);
    }
    job.cancelRequested = true;
    job.updatedAt = this.now();
    this.emit(jobId, "CANCEL_REQUESTED");
    if (job.status === "READY") {
      job.status = "CANCELLED";
      this.emit(jobId, "CANCELLED");
    }
    return structuredClone(job);
  }

  recoverExpiredLeases(): string[] {
    const now = this.now();
    const recovered: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "LEASED" || (job.leaseExpiresAt ?? 0) > now) {
        continue;
      }
      const previousWorker = job.leaseOwner;
      job.leaseOwner = undefined;
      job.leaseExpiresAt = undefined;
      job.updatedAt = now;
      if (job.cancelRequested) {
        job.status = "CANCELLED";
        this.emit(job.jobId, "CANCELLED", previousWorker);
      } else if (job.attempts < job.maxAttempts) {
        job.status = "READY";
        job.availableAt = now;
        this.emit(job.jobId, "LEASE_EXPIRED", previousWorker, {
          attempts: job.attempts,
        });
      } else {
        job.status = "DEAD_LETTER";
        job.lastErrorCode = "LEASE_EXPIRED";
        this.emit(job.jobId, "DEAD_LETTERED", previousWorker, {
          retryable: true,
          attempts: job.attempts,
        });
      }
      recovered.push(job.jobId);
    }
    return recovered;
  }

  get(jobId: string): QueueJob<TPayload, TResult> | undefined {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  listEvents(jobId?: string): QueueEvent[] {
    return this.events
      .filter((event) => !jobId || event.jobId === jobId)
      .map((event) => structuredClone(event));
  }

  snapshot(): QueueSnapshot<TPayload, TResult> {
    return {
      version: 1,
      sequence: this.sequence,
      jobs: [...this.jobs.values()].map((job) => structuredClone(job)),
      idempotencyEntries: [...this.idempotencyIndex.entries()],
      events: this.listEvents(),
    };
  }

  isCancellationRequested(jobId: string): boolean {
    return this.requireJob(jobId).cancelRequested;
  }

  private restore(snapshot: QueueSnapshot<TPayload, TResult>): void {
    if (snapshot.version !== 1) {
      throw new Error(`Unsupported queue snapshot version: ${snapshot.version}`);
    }
    this.sequence = snapshot.sequence;
    for (const job of snapshot.jobs) {
      this.jobs.set(job.jobId, structuredClone(job));
    }
    for (const [scope, jobId] of snapshot.idempotencyEntries) {
      if (!this.jobs.has(jobId)) {
        throw new Error(`Queue snapshot idempotency entry references missing job: ${jobId}`);
      }
      this.idempotencyIndex.set(scope, jobId);
    }
    this.events.push(...snapshot.events.map((event) => structuredClone(event)));
  }

  private requireJob(jobId: string): QueueJob<TPayload, TResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Queue job not found: ${jobId}`);
    }
    return job;
  }

  private requireActiveLease(
    jobId: string,
    workerId: string,
  ): QueueJob<TPayload, TResult> {
    validateWorkerId(workerId);
    const job = this.requireJob(jobId);
    if (job.status !== "LEASED" || job.leaseOwner !== workerId) {
      throw new QueueLeaseError(
        `Worker ${workerId} does not own the active lease for job ${jobId}`,
      );
    }
    if ((job.leaseExpiresAt ?? 0) <= this.now()) {
      throw new QueueLeaseError(`Lease expired for job ${jobId}`);
    }
    return job;
  }

  private emit(
    jobId: string,
    type: QueueEvent["type"],
    workerId?: string,
    data?: QueueEvent["data"],
  ): void {
    this.sequence += 1;
    this.events.push({
      sequence: this.sequence,
      jobId,
      type,
      ...(workerId ? { workerId } : {}),
      timestamp: this.now(),
      ...(data ? { data } : {}),
    });
  }
}

export interface QueueWorkerOptions<TPayload, TResult> {
  workerId: string;
  queue: InMemoryTaskQueue<TPayload, TResult>;
  leaseMs?: number;
  handler: (
    payload: TPayload,
    context: {
      jobId: string;
      attempt: number;
      heartbeat: () => void;
      isCancellationRequested: () => boolean;
    },
  ) => Promise<TResult>;
  isRetryable?: (error: unknown) => boolean;
  retryDelayMs?: (attempt: number) => number;
}

export class QueueWorker<TPayload, TResult> {
  private readonly options: QueueWorkerOptions<TPayload, TResult>;

  constructor(options: QueueWorkerOptions<TPayload, TResult>) {
    validateWorkerId(options.workerId);
    this.options = options;
  }

  async runOnce(): Promise<QueueJob<TPayload, TResult> | undefined> {
    const leaseMs = this.options.leaseMs ?? 30_000;
    const job = this.options.queue.leaseNext(this.options.workerId, leaseMs);
    if (!job) {
      return undefined;
    }
    try {
      const result = await this.options.handler(job.payload, {
        jobId: job.jobId,
        attempt: job.attempts,
        heartbeat: () => {
          this.options.queue.heartbeat(job.jobId, this.options.workerId, leaseMs);
        },
        isCancellationRequested: () =>
          this.options.queue.isCancellationRequested(job.jobId),
      });
      return this.options.queue.complete(job.jobId, this.options.workerId, result);
    } catch (error) {
      const retryable = this.options.isRetryable?.(error) ?? false;
      return this.options.queue.fail(job.jobId, this.options.workerId, {
        errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        retryable,
        retryDelayMs: this.options.retryDelayMs?.(job.attempts) ?? 0,
      });
    }
  }
}

function validateEnqueueRequest<TPayload>(request: EnqueueRequest<TPayload>): void {
  for (const [name, value] of [
    ["jobId", request.jobId],
    ["tenantId", request.tenantId],
    ["idempotencyKey", request.idempotencyKey],
    ["resourceKey", request.resourceKey],
  ] as const) {
    if (!value.trim() || value.length > 200) {
      throw new Error(`Invalid queue ${name}`);
    }
  }
}

function validateWorkerId(workerId: string): void {
  if (!workerId.trim() || workerId.length > 200) {
    throw new Error("Invalid queue worker ID");
  }
}

function sanitizeErrorCode(errorCode: string): string {
  const sanitized = errorCode.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
  return sanitized || "UNKNOWN_ERROR";
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}
