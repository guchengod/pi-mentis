import {
  InvalidInferenceRequestError,
  ModelNotFoundError,
  OperationCancelledError,
  ProviderAuthenticationError,
  ProviderOverloadedError,
  ProviderPermissionError,
  ProviderProtocolError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  AsyncSemaphore,
  systemClock,
  type Clock,
  type MentisError,
} from "@pi-mentis/pi-mentis-core";

import { recordInferenceDiagnostic } from "./diagnostics.js";

export interface ProviderRequestGateOptions {
  readonly concurrentRequests: number;
  readonly requestsPerSecond?: number;
  readonly tokensPerMinute?: number;
  readonly circuitFailureThreshold: number;
  readonly circuitOpenMs: number;
}

export class ProviderRequestGate {
  readonly #options: ProviderRequestGateOptions;
  readonly #semaphore: AsyncSemaphore;
  readonly #clock: Clock;
  readonly #requests: number[] = [];
  readonly #tokens: { readonly at: number; readonly count: number }[] = [];
  #consecutiveThrottleFailures = 0;
  #openUntil = 0;

  constructor(options: ProviderRequestGateOptions, clock: Clock = systemClock) {
    this.#options = options;
    this.#semaphore = new AsyncSemaphore(options.concurrentRequests);
    this.#clock = clock;
  }

  async run<T>(
    estimatedTokens: number,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.#clock.now() < this.#openUntil) {
      throw new ProviderUnavailableError("SiliconFlow circuit breaker is temporarily open", {
        operation: "provider-rate-limit",
        provider: "siliconflow",
        retryable: true,
      });
    }
    await this.#waitForBudget(Math.max(0, estimatedTokens), signal);
    const release = await this.#semaphore.acquire(signal);
    try {
      const result = await operation();
      this.#consecutiveThrottleFailures = Math.max(0, this.#consecutiveThrottleFailures - 1);
      return result;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (
        code === "PROVIDER_RATE_LIMIT" ||
        code === "PROVIDER_OVERLOADED" ||
        code === "PROVIDER_TIMEOUT" ||
        code === "PROVIDER_UNAVAILABLE"
      ) {
        this.#consecutiveThrottleFailures++;
        if (this.#consecutiveThrottleFailures >= this.#options.circuitFailureThreshold) {
          this.#openUntil = this.#clock.now() + this.#options.circuitOpenMs;
        }
      }
      throw error;
    } finally {
      release();
    }
  }

  async #waitForBudget(tokens: number, signal: AbortSignal | undefined): Promise<void> {
    while (true) {
      if (signal?.aborted === true) {
        throw new OperationCancelledError("Provider rate-limit wait cancelled");
      }
      const now = this.#clock.now();
      while ((this.#requests[0] ?? now) <= now - 1_000) this.#requests.shift();
      while ((this.#tokens[0]?.at ?? now) <= now - 60_000) this.#tokens.shift();
      const usedTokens = this.#tokens.reduce((sum, item) => sum + item.count, 0);
      const requestAvailable =
        this.#options.requestsPerSecond === undefined ||
        this.#requests.length < this.#options.requestsPerSecond;
      const tokensAvailable =
        this.#options.tokensPerMinute === undefined ||
        usedTokens + tokens <= this.#options.tokensPerMinute;
      if (requestAvailable && tokensAvailable) {
        this.#requests.push(now);
        this.#tokens.push({ at: now, count: tokens });
        return;
      }
      const requestWait = requestAvailable
        ? 0
        : Math.max(1, (this.#requests[0] ?? now) + 1_000 - now);
      const tokenWait = tokensAvailable
        ? 0
        : Math.max(1, (this.#tokens[0]?.at ?? now) + 60_000 - now);
      await delay(Math.max(requestWait, tokenWait), signal);
    }
  }
}

export interface HttpOperation {
  readonly providerId: string;
  readonly modelId: string;
  readonly operation: "embedding" | "rerank";
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly signal?: AbortSignal;
  readonly dimensions?: number;
  readonly inputCount?: number;
  readonly documentCount?: number;
  readonly estimatedTokens: number;
}

export interface JsonHttpResult {
  readonly value: unknown;
  readonly traceId?: string;
  readonly httpStatus: number;
  readonly retryCount: number;
}

interface ErrorContext {
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
  readonly traceId?: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

function httpError(status: number, message: string, context: ErrorContext): MentisError {
  switch (status) {
    case 400:
      return new InvalidInferenceRequestError(message, context);
    case 401:
      return new ProviderAuthenticationError(message, context);
    case 403:
      return new ProviderPermissionError(message, context);
    case 404:
      return new ModelNotFoundError(message, context);
    case 429:
      return new ProviderRateLimitError(message, { ...context, retryable: true });
    case 503:
      return new ProviderOverloadedError(message, { ...context, retryable: true });
    case 504:
      return new ProviderTimeoutError(message, { ...context, retryable: true });
    default:
      return new ProviderUnavailableError(message, {
        ...context,
        retryable: status >= 500,
      });
  }
}

function retryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  const code =
    "code" in error && typeof (error as { readonly code?: unknown }).code === "string"
      ? (error as { readonly code: string }).code
      : "";
  return ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "ETIMEDOUT"].includes(code);
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new OperationCancelledError("Inference retry cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new OperationCancelledError("Inference retry cancelled"));
      },
      { once: true },
    );
  });
}

export async function postJson(
  url: string,
  apiKey: string,
  body: Readonly<Record<string, unknown>>,
  operation: HttpOperation,
): Promise<JsonHttpResult> {
  let lastError: unknown;
  const started = performance.now();
  for (let attempt = 1; attempt <= operation.maxAttempts; attempt++) {
    const timeoutSignal = AbortSignal.timeout(operation.timeoutMs);
    const signal =
      operation.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([operation.signal, timeoutSignal]);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error: unknown) {
      if (operation.signal?.aborted === true) {
        throw new OperationCancelledError(`${operation.operation} request cancelled`, {
          operation: operation.operation,
          provider: operation.providerId,
          model: operation.modelId,
          retryable: false,
          cause: error,
        });
      }
      const timedOut = timeoutSignal.aborted;
      const mapped = timedOut
        ? new ProviderTimeoutError(
            `${operation.operation} request exceeded ${operation.timeoutMs}ms`,
            {
              operation: operation.operation,
              provider: operation.providerId,
              model: operation.modelId,
              retryable: true,
              cause: error,
            },
          )
        : new ProviderUnavailableError(`${operation.operation} network request failed`, {
            operation: operation.operation,
            provider: operation.providerId,
            model: operation.modelId,
            retryable: retryableNetworkError(error),
            cause: error,
          });
      lastError = mapped;
      const finalAttempt = !mapped.context.retryable || attempt === operation.maxAttempts;
      await recordInferenceDiagnostic({
        timestamp: new Date().toISOString(),
        operation: operation.operation,
        providerId: "siliconflow",
        modelId: operation.modelId,
        ...(operation.dimensions === undefined ? {} : { dimensions: operation.dimensions }),
        ...(operation.inputCount === undefined ? {} : { inputCount: operation.inputCount }),
        ...(operation.documentCount === undefined
          ? {}
          : { documentCount: operation.documentCount }),
        estimatedTokens: operation.estimatedTokens,
        durationMs: performance.now() - started,
        status: finalAttempt ? "failed" : "retry",
        cacheHit: false,
        retryCount: attempt - 1,
      });
      if (finalAttempt) throw mapped;
      await delay(
        Math.random() * Math.min(operation.maxDelayMs, operation.baseDelayMs * 2 ** (attempt - 1)),
        operation.signal,
      );
      continue;
    }
    const traceId = response.headers.get("x-siliconcloud-trace-id") ?? undefined;
    if (!response.ok) {
      // Discard the body and never project it into errors. Provider responses may
      // echo request material and must not become logs, IPC errors, or TUI text.
      await response.body?.cancel();
      const mapped = httpError(
        response.status,
        `SiliconFlow ${operation.operation} failed with HTTP ${response.status}`,
        {
          provider: operation.providerId,
          model: operation.modelId,
          operation: operation.operation,
          ...(traceId === undefined ? {} : { traceId }),
          retryable: [429, 503, 504].includes(response.status),
          details: { statusCode: response.status },
        },
      );
      lastError = mapped;
      const finalAttempt = !mapped.context.retryable || attempt === operation.maxAttempts;
      await recordInferenceDiagnostic({
        timestamp: new Date().toISOString(),
        operation: operation.operation,
        providerId: "siliconflow",
        modelId: operation.modelId,
        ...(operation.dimensions === undefined ? {} : { dimensions: operation.dimensions }),
        ...(operation.inputCount === undefined ? {} : { inputCount: operation.inputCount }),
        ...(operation.documentCount === undefined
          ? {}
          : { documentCount: operation.documentCount }),
        estimatedTokens: operation.estimatedTokens,
        durationMs: performance.now() - started,
        status: finalAttempt ? "failed" : "retry",
        httpStatus: response.status,
        ...(traceId === undefined ? {} : { traceId }),
        cacheHit: false,
        retryCount: attempt - 1,
      });
      if (finalAttempt) throw mapped;
      const wait =
        retryAfterMs(response) ??
        Math.random() * Math.min(operation.maxDelayMs, operation.baseDelayMs * 2 ** (attempt - 1));
      await delay(wait, operation.signal);
      continue;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      throw new ProviderProtocolError(
        `SiliconFlow ${operation.operation} returned non-JSON Content-Type ${contentType || "<missing>"}`,
        {
          operation: operation.operation,
          provider: operation.providerId,
          model: operation.modelId,
          ...(traceId === undefined ? {} : { traceId }),
          retryable: false,
        },
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch (error: unknown) {
      throw new ProviderProtocolError(`SiliconFlow ${operation.operation} returned invalid JSON`, {
        operation: operation.operation,
        provider: operation.providerId,
        model: operation.modelId,
        ...(traceId === undefined ? {} : { traceId }),
        retryable: false,
        cause: error,
      });
    }
    await recordInferenceDiagnostic({
      timestamp: new Date().toISOString(),
      operation: operation.operation,
      providerId: "siliconflow",
      modelId: operation.modelId,
      ...(operation.dimensions === undefined ? {} : { dimensions: operation.dimensions }),
      ...(operation.inputCount === undefined ? {} : { inputCount: operation.inputCount }),
      ...(operation.documentCount === undefined ? {} : { documentCount: operation.documentCount }),
      estimatedTokens: operation.estimatedTokens,
      durationMs: performance.now() - started,
      status: "success",
      httpStatus: response.status,
      ...(traceId === undefined ? {} : { traceId }),
      cacheHit: false,
      retryCount: attempt - 1,
    });
    return {
      value,
      httpStatus: response.status,
      retryCount: attempt - 1,
      ...(traceId === undefined ? {} : { traceId }),
    };
  }
  throw lastError instanceof Error
    ? lastError
    : new ProviderUnavailableError(`SiliconFlow ${operation.operation} failed`, {
        operation: operation.operation,
        provider: operation.providerId,
        model: operation.modelId,
        retryable: true,
      });
}
