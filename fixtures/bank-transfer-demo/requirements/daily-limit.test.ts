import assert from "node:assert/strict";
import test from "node:test";

import { errorCodes, TransferError } from "../src/errors.ts";
import {
  InMemoryAuditService,
  InMemoryDailyLimitService,
  InMemoryTransferRepository,
} from "../src/in-memory-services.ts";
import { TransferService } from "../src/transfer-service.ts";

test("rejects transfers that exceed the accumulated daily limit without debiting the account", async () => {
  const repository = new InMemoryTransferRepository({ "account-001": 20_000 });
  const auditService = new InMemoryAuditService();
  const dailyLimitService = new InMemoryDailyLimitService(7_000);
  const service = new TransferService(repository, auditService, dailyLimitService);
  const occurredAt = new Date("2026-07-25T09:00:00Z");

  await service.transfer({
    transferId: "transfer-limit-001",
    accountId: "account-001",
    amountCents: 4_000,
    occurredAt,
  });

  await assert.rejects(
    service.transfer({
      transferId: "transfer-limit-002",
      accountId: "account-001",
      amountCents: 4_000,
      occurredAt,
    }),
    (error: unknown) =>
      error instanceof TransferError &&
      error.code === errorCodes.TRANSFER_DAILY_LIMIT_EXCEEDED,
  );

  assert.equal(await repository.getBalance("account-001"), 16_000);
  assert.equal(await dailyLimitService.getUsedAmount("account-001", occurredAt), 4_000);
  assert.equal(auditService.events[1]?.eventType, "TRANSFER_FAILED");
  assert.equal(
    auditService.events[1]?.errorCode,
    errorCodes.TRANSFER_DAILY_LIMIT_EXCEEDED,
  );
});

