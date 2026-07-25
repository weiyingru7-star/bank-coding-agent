export const errorCodes = {
  INVALID_TRANSFER_AMOUNT: "INVALID_TRANSFER_AMOUNT",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  TRANSFER_DAILY_LIMIT_EXCEEDED: "TRANSFER_DAILY_LIMIT_EXCEEDED",
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

export class TransferError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "TransferError";
    this.code = code;
  }
}

