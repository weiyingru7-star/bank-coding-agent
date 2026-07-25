export interface TransferRequest {
  transferId: string;
  accountId: string;
  amountCents: number;
  occurredAt: Date;
}

export interface TransferResult {
  transferId: string;
  status: "COMPLETED";
  remainingBalanceCents: number;
}

export interface AuditEvent {
  eventType: "TRANSFER_COMPLETED" | "TRANSFER_FAILED";
  transferId: string;
  accountId: string;
  amountCents: number;
  errorCode?: string;
}

export interface TransferRepository {
  debit(accountId: string, amountCents: number): Promise<number>;
  getBalance(accountId: string): Promise<number>;
}

export interface AuditService {
  record(event: AuditEvent): Promise<void>;
}

export interface DailyLimitService {
  assertAllowed(accountId: string, amountCents: number, occurredAt: Date): Promise<void>;
  recordUsage(accountId: string, amountCents: number, occurredAt: Date): Promise<void>;
  getUsedAmount(accountId: string, occurredAt: Date): Promise<number>;
}

