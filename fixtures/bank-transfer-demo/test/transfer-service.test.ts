import assert from "node:assert/strict";
import test from "node:test";

import { errorCodes, TransferError } from "../src/errors.ts";
import {
  InMemoryAuditService,
  InMemoryDailyLimitService,
  InMemoryTransferRepository,
} from "../src/in-memory-services.ts";
import { TransferService } from "../src/transfer-service.ts";

function createService(balanceCents = 20_000) {
  const repository = new InMemoryTransferRepository({ "account-001": balanceCents });
  const auditService = new InMemoryAuditService();
  const dailyLimitService = new InMemoryDailyLimitService(10_000);
  const service = new TransferService(repository, auditService, dailyLimitService);
  return { service, repository, auditService };
}

test("completes a valid transfer and records a success audit event", async () => {
  const { service, repository, auditService } = createService();

  const result = await service.transfer({
    transferId: "transfer-001",
    accountId: "account-001",
    amountCents: 3_000,
    occurredAt: new Date("2026-07-25T09:00:00Z"),
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(await repository.getBalance("account-001"), 17_000);
  assert.deepEqual(auditService.events, [
    {
      eventType: "TRANSFER_COMPLETED",
      transferId: "transfer-001",
      accountId: "account-001",
      amountCents: 3_000,
    },
  ]);
});

test("rejects a transfer when the balance is insufficient and records the error code", async () => {
  const { service, repository, auditService } = createService(1_000);

  await assert.rejects(
    service.transfer({
      transferId: "transfer-002",
      accountId: "account-001",
      amountCents: 2_000,
      occurredAt: new Date("2026-07-25T09:00:00Z"),
    }),
    (error: unknown) =>
      error instanceof TransferError && error.code === errorCodes.INSUFFICIENT_BALANCE,
  );

  assert.equal(await repository.getBalance("account-001"), 1_000);
  assert.equal(auditService.events[0]?.eventType, "TRANSFER_FAILED");
  assert.equal(auditService.events[0]?.errorCode, errorCodes.INSUFFICIENT_BALANCE);
});

test("rejects a non-positive transfer amount", async () => {
  const { service, auditService } = createService();

  await assert.rejects(
    service.transfer({
      transferId: "transfer-003",
      accountId: "account-001",
      amountCents: 0,
      occurredAt: new Date("2026-07-25T09:00:00Z"),
    }),
    (error: unknown) =>
      error instanceof TransferError && error.code === errorCodes.INVALID_TRANSFER_AMOUNT,
  );

  assert.equal(auditService.events[0]?.eventType, "TRANSFER_FAILED");
});

