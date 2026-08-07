export interface MentisErrorContext {
  readonly operation?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly sourceId?: string;
  readonly documentId?: string;
  readonly traceId?: string;
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface MentisErrorOptions extends MentisErrorContext {
  readonly cause?: unknown;
}

export class MentisError extends Error {
  readonly code: string;
  readonly context: MentisErrorContext;

  constructor(code: string, message: string, options: MentisErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.context = Object.fromEntries(
      Object.entries(options).filter(([key]) => key !== "cause"),
    ) as MentisErrorContext;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...this.context,
    };
  }
}

type ErrorConstructor = new (message: string, options?: MentisErrorOptions) => MentisError;

function defineError(name: string, code: string): ErrorConstructor {
  return class extends MentisError {
    constructor(message: string, options: MentisErrorOptions = {}) {
      super(code, message, options);
      this.name = name;
    }
  };
}

export const ConfigurationError = defineError("ConfigurationError", "CONFIGURATION_ERROR");
export const RuntimeProtocolMismatchError = defineError(
  "RuntimeProtocolMismatchError",
  "RUNTIME_PROTOCOL_MISMATCH",
);
export const ProviderConflictError = defineError("ProviderConflictError", "PROVIDER_CONFLICT");
export const UnsupportedKnowledgeSourceError = defineError(
  "UnsupportedKnowledgeSourceError",
  "UNSUPPORTED_KNOWLEDGE_SOURCE",
);
export const AmbiguousParserError = defineError("AmbiguousParserError", "AMBIGUOUS_PARSER");
export const ParserFailureError = defineError("ParserFailureError", "PARSER_FAILURE");
export const EmbeddingUnavailableError = defineError(
  "EmbeddingUnavailableError",
  "EMBEDDING_UNAVAILABLE",
);
export const UnsupportedEmbeddingDimensionError = defineError(
  "UnsupportedEmbeddingDimensionError",
  "UNSUPPORTED_EMBEDDING_DIMENSION",
);
export const EmbeddingVectorValidationError = defineError(
  "EmbeddingVectorValidationError",
  "EMBEDDING_VECTOR_VALIDATION",
);
export const RerankUnavailableError = defineError("RerankUnavailableError", "RERANK_UNAVAILABLE");
export const RerankBudgetExceededError = defineError(
  "RerankBudgetExceededError",
  "RERANK_BUDGET_EXCEEDED",
);
export const ModelCapabilityMismatchError = defineError(
  "ModelCapabilityMismatchError",
  "MODEL_CAPABILITY_MISMATCH",
);
export const InvalidInferenceRequestError = defineError(
  "InvalidInferenceRequestError",
  "INVALID_INFERENCE_REQUEST",
);
export const ProviderAuthenticationError = defineError(
  "ProviderAuthenticationError",
  "PROVIDER_AUTHENTICATION",
);
export const ProviderPermissionError = defineError(
  "ProviderPermissionError",
  "PROVIDER_PERMISSION",
);
export const ModelNotFoundError = defineError("ModelNotFoundError", "MODEL_NOT_FOUND");
export const ProviderRateLimitError = defineError("ProviderRateLimitError", "PROVIDER_RATE_LIMIT");
export const ProviderOverloadedError = defineError(
  "ProviderOverloadedError",
  "PROVIDER_OVERLOADED",
);
export const ProviderTimeoutError = defineError("ProviderTimeoutError", "PROVIDER_TIMEOUT");
export const ProviderProtocolError = defineError("ProviderProtocolError", "PROVIDER_PROTOCOL");
export const ProviderResponseValidationError = defineError(
  "ProviderResponseValidationError",
  "PROVIDER_RESPONSE_VALIDATION",
);
export const ProviderUnavailableError = defineError(
  "ProviderUnavailableError",
  "PROVIDER_UNAVAILABLE",
);
export const SearchTimeoutError = defineError("SearchTimeoutError", "SEARCH_TIMEOUT");
export const StorageBusyError = defineError("StorageBusyError", "STORAGE_BUSY");
export const StorageCorruptionError = defineError("StorageCorruptionError", "STORAGE_CORRUPTION");
export const QueueFullError = defineError("QueueFullError", "QUEUE_FULL");
export const OperationCancelledError = defineError(
  "OperationCancelledError",
  "OPERATION_CANCELLED",
);
export const RevisionCommitError = defineError("RevisionCommitError", "REVISION_COMMIT");
export const EmbeddingMigrationError = defineError(
  "EmbeddingMigrationError",
  "EMBEDDING_MIGRATION",
);

export class UnsupportedPiVersionError extends MentisError {
  readonly currentVersion: string;
  readonly minVersion: string;
  readonly installCommand: string;

  constructor(currentVersion: string, minVersion: string) {
    const installCommand = `pnpm add -E @earendil-works/pi-coding-agent@^${minVersion}`;
    super(
      "UNSUPPORTED_PI_VERSION",
      `Detected Pi ${currentVersion}; Pi Mentis requires at least ${minVersion}. Update Pi with: ${installCommand}. Initialization stopped before tool registration, Zvec open, or background startup.`,
      {
        operation: "pi-compatibility-check",
        retryable: false,
        details: {
          currentVersion,
          minVersion,
          installCommand,
          initializationStopped: true,
        },
      },
    );
    this.currentVersion = currentVersion;
    this.minVersion = minVersion;
    this.installCommand = installCommand;
  }
}

export function asMentisError(error: unknown, fallback: MentisError): MentisError {
  return error instanceof MentisError ? error : fallback;
}
