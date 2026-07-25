import type {
  AuditService,
  DailyLimitService,
  TransferRepository,
  TransferRequest,
  TransferResult,
} from "./contracts.ts";
import { errorCodes, TransferError } from "./errors.ts";

export class TransferService {
  private readonly repository: TransferRepository;
  private readonly auditService: AuditService;
  private readonly dailyLimitService: DailyLimitService;

  constructor(
    repository: TransferRepository,
    auditService: AuditService,
    dailyLimitService: DailyLimitService,
  ) {
    this.repository = repository;
    this.auditService = auditService;
    this.dailyLimitService = dailyLimitService;
  }

  async transfer(request: TransferRequest): Promise<TransferResult> {
    try {
      if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) {
        throw new TransferError(errorCodes.INVALID_TRANSFER_AMOUNT, "Transfer amount must be positive");
      }

      // TODO(bank-agent): validate and record the daily transfer limit.
      // The dependency is already injected, but the current implementation does not use it.
      void this.dailyLimitService;

      const remainingBalanceCents = await this.repository.debit(
        request.accountId,
        request.amountCents,
      );

      await this.auditService.record({
        eventType: "TRANSFER_COMPLETED",
        transferId: request.transferId,
        accountId: request.accountId,
        amountCents: request.amountCents,
      });

      return {
        transferId: request.transferId,
        status: "COMPLETED",
        remainingBalanceCents,
      };
    } catch (error) {
      await this.auditService.record({
        eventType: "TRANSFER_FAILED",
        transferId: request.transferId,
        accountId: request.accountId,
        amountCents: request.amountCents,
        errorCode: error instanceof TransferError ? error.code : undefined,
      });
      throw error;
    }
  }
}

