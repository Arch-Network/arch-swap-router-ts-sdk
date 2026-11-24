import type { SwapCandidateFailure } from "./swap-types.js";

export interface SwapSdkErrorOptions extends ErrorOptions {
  readonly status?: number;
  readonly failures?: readonly SwapCandidateFailure[];
  readonly transactionHash?: string;
  readonly submissionUncertain?: boolean;
}

export class SwapSdkError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly failures: readonly SwapCandidateFailure[];
  readonly transactionHash: string | undefined;
  /** Reconcile through attempt lookup and the chain; do not automatically resubmit. */
  readonly submissionUncertain: boolean;

  constructor(code: string, message: string, options: SwapSdkErrorOptions = {}) {
    super(message, options);
    this.name = "SwapSdkError";
    this.code = code;
    this.status = options.status;
    this.failures = options.failures ?? [];
    this.transactionHash = options.transactionHash;
    this.submissionUncertain = options.submissionUncertain ?? false;
  }
}
