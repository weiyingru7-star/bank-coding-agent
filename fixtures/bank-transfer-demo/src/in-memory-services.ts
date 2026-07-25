import type {
  AuditEvent,
  AuditService,
  DailyLimitService,
  TransferRepository,
} from "./contracts.ts";
import { errorCodes, TransferError } from "./errors.ts";

export class InMemoryTransferRepository implements TransferRepository {
  readonly balances = new Map<string, number>();

  constructor(initialBalances: Record<string, number>) {
    for (const [accountId, balanceCents] of Object.entries(initialBalances)) {
      this.balances.set(accountId, balanceCents);
    }
  }

  async debit(accountId: string, amountCents: number): Promise<number> {
    const currentBalance = this.balances.get(accountId) ?? 0;
    if (currentBalance < amountCents) {
      throw new TransferError(errorCodes.INSUFFICIENT_BALANCE, "Insufficient account balance");
    }

    const remainingBalance = currentBalance - amountCents;
    this.balances.set(accountId, remainingBalance);
    return remainingBalance;
  }

  async getBalance(accountId: string): Promise<number> {
    return this.balances.get(accountId) ?? 0;
  }
}

export class InMemoryAuditService implements AuditService {
  readonly events: AuditEvent[] = [];

  async record(event: AuditEvent): Promise<void> {
    this.events.push({ ...event });
  }
}

export class InMemoryDailyLimitService implements DailyLimitService {
  readonly usedAmounts = new Map<string, number>();
  readonly dailyLimitCents: number;

  constructor(dailyLimitCents: number) {
    this.dailyLimitCents = dailyLimitCents;
  }

  async assertAllowed(accountId: string, amountCents: number, occurredAt: Date): Promise<void> {
    const usedAmount = await this.getUsedAmount(accountId, occurredAt);
    if (usedAmount + amountCents > this.dailyLimitCents) {
      throw new TransferError(
        errorCodes.TRANSFER_DAILY_LIMIT_EXCEEDED,
        "Transfer daily limit exceeded",
      );
    }
  }

  async recordUsage(accountId: string, amountCents: number, occurredAt: Date): Promise<void> {
    const key = this.buildKey(accountId, occurredAt);
    const currentAmount = this.usedAmounts.get(key) ?? 0;
    this.usedAmounts.set(key, currentAmount + amountCents);
  }

  async getUsedAmount(accountId: string, occurredAt: Date): Promise<number> {
    return this.usedAmounts.get(this.buildKey(accountId, occurredAt)) ?? 0;
  }

  private buildKey(accountId: string, occurredAt: Date): string {
    return `${accountId}:${occurredAt.toISOString().slice(0, 10)}`;
  }
}

