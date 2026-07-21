/**
 * Error taxonomy for the Kite Connect API and this CLI.
 *
 * Kite returns errors as:
 *   { "status": "error", "message": "...", "error_type": "GeneralException" }
 *
 * See https://kite.trade/docs/connect/v3/exceptions/
 */

/** Process exit codes. Distinct per failure mode so scripts can branch on them. */
export const ExitCode = {
  Ok: 0,
  /** Generic/unclassified failure. */
  Failure: 1,
  /** Bad CLI usage: unknown flag, missing argument, invalid value. */
  Usage: 2,
  /** No session, or the session expired. Run `kite login`. */
  Auth: 3,
  /** Kite rejected the input (InputException). */
  Input: 4,
  /** Order was rejected by the OMS (OrderException). */
  Order: 5,
  /** Insufficient funds (MarginException). */
  Margin: 6,
  /** Insufficient holdings to sell (HoldingException). */
  Holding: 7,
  /** Rate limited (HTTP 429). */
  RateLimit: 8,
  /** Kite or its upstream OMS is unreachable or erroring (5xx, network). */
  Upstream: 9,
  /** The user declined a confirmation prompt. */
  Aborted: 10,
  /** Confirmation required but stdin is not a TTY and --yes was not passed. */
  ConfirmationRequired: 11,
  /** Holdings need depository authorisation (HTTP 428). */
  AuthorisationRequired: 12,
  /** Trading is disabled by the local kill switch. */
  TradingDisabled: 13,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** Kite's documented `error_type` values. */
export type KiteErrorType =
  | 'TokenException'
  | 'UserException'
  | 'OrderException'
  | 'InputException'
  | 'MarginException'
  | 'HoldingException'
  | 'NetworkException'
  | 'DataException'
  | 'GeneralException';

/**
 * Base class for every error this CLI raises deliberately. Carries an exit code
 * and an optional remediation hint shown to the user.
 */
export class KiteCliError extends Error {
  readonly exitCode: ExitCodeValue;
  /** A short actionable next step, e.g. "Run `kite login`." */
  readonly hint: string | undefined;

  constructor(message: string, exitCode: ExitCodeValue = ExitCode.Failure, hint?: string) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

/** An error returned by the Kite API with a structured envelope. */
export class KiteApiError extends KiteCliError {
  readonly status: number;
  readonly errorType: KiteErrorType | string;

  constructor(opts: {
    message: string;
    status: number;
    errorType: KiteErrorType | string;
    hint?: string;
  }) {
    super(opts.message, exitCodeForApiError(opts.status, opts.errorType), opts.hint);
    this.status = opts.status;
    this.errorType = opts.errorType;
  }
}

/** The local session is missing or expired. */
export class AuthRequiredError extends KiteCliError {
  constructor(message = 'Not logged in.') {
    super(message, ExitCode.Auth, 'Run `kite login` to start a session.');
  }
}

/** Bad CLI usage — distinct from Kite rejecting valid-looking input. */
export class UsageError extends KiteCliError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.Usage, hint);
  }
}

/** The user answered "no" at a confirmation prompt. */
export class AbortedError extends KiteCliError {
  constructor(message = 'Aborted.') {
    super(message, ExitCode.Aborted);
  }
}

/** Network-level failure: DNS, TCP, TLS, or timeout. */
export class NetworkError extends KiteCliError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.Upstream, hint);
  }
}

function exitCodeForApiError(status: number, errorType: string): ExitCodeValue {
  // Status codes that are more specific than the error_type Kite pairs them
  // with are checked FIRST. A 428 always means "holdings need depository
  // authorisation", but Kite sends it as a generic OrderException — matching on
  // error_type first would collapse it to ExitCode.Order and make the
  // documented ExitCode.AuthorisationRequired unreachable, so a script could
  // never branch on the one condition that has a specific recovery flow.
  if (status === 428) return ExitCode.AuthorisationRequired;
  if (status === 429) return ExitCode.RateLimit;

  switch (errorType) {
    case 'TokenException':
      return ExitCode.Auth;
    case 'InputException':
      return ExitCode.Input;
    case 'OrderException':
      return ExitCode.Order;
    case 'MarginException':
      return ExitCode.Margin;
    case 'HoldingException':
      return ExitCode.Holding;
    case 'NetworkException':
    case 'DataException':
      return ExitCode.Upstream;
    default:
      break;
  }

  if (status === 403) return ExitCode.Auth;
  if (status >= 500) return ExitCode.Upstream;
  if (status >= 400) return ExitCode.Input;
  return ExitCode.Failure;
}

/**
 * Remediation hints for the error types where the right next step is not
 * obvious from Kite's own message.
 */
export function hintForApiError(status: number, errorType: string): string | undefined {
  if (errorType === 'TokenException') {
    return 'Your session expired or was invalidated (logging into Kite web ends API sessions). Run `kite login`.';
  }
  // A 403 that is NOT a TokenException is a permission problem, not an expired
  // session — most often an endpoint this app is not subscribed to (the
  // Historical Data API, for instance, is a paid Kite add-on). Telling the user
  // to re-login would send them round a loop that cannot fix it.
  if (status === 403) {
    return 'Kite denied this request. Your app may not have permission for this endpoint — historical data, for example, needs the paid Historical Data subscription. Only re-run `kite login` if your session was the problem.';
  }
  if (status === 428) {
    return 'Selling these holdings needs depository authorisation. Run `kite authorise`.';
  }
  if (status === 429) {
    return 'Rate limited by Kite. Quote calls are capped at 1/sec and historical at 3/sec.';
  }
  if (errorType === 'MarginException') {
    return 'Check available margin with `kite funds`.';
  }
  if (status === 502 || status === 503 || status === 504) {
    return "Zerodha's OMS backend is unavailable. This is usually transient; retry shortly.";
  }
  return undefined;
}
