import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultConfig,
  ModelCapabilityMismatchError,
  ProviderRateLimitError,
  ProviderResponseValidationError,
} from "@pi-mentis/pi-mentis-core";
import {
  mapEmbeddingVectors,
  mapRerankItems,
  parseEmbeddingResponse,
  parseRerankResponse,
  postJson,
  ProviderRequestGate,
  SiliconFlowEmbeddingProvider,
  SiliconFlowRerankProvider,
} from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("SiliconFlow wire contracts", () => {
  it("maps float and base64 Embeddings by index", () => {
    const bytes = Buffer.alloc(8);
    bytes.writeFloatLE(0.25, 0);
    bytes.writeFloatLE(-0.5, 4);
    const parsed = parseEmbeddingResponse({
      object: "list",
      model: "m",
      data: [
        { index: 1, embedding: bytes.toString("base64") },
        { index: 0, embedding: [1, 2] },
      ],
    });
    const vectors = mapEmbeddingVectors(parsed, 2, 2);
    expect([...vectors[0]!.values]).toEqual([1, 2]);
    expect([...vectors[1]!.values]).toEqual([0.25, -0.5]);
  });

  it("rejects invalid dimensions, counts, floats, and indexes", () => {
    expect(() =>
      mapEmbeddingVectors(
        parseEmbeddingResponse({
          object: "list",
          model: "m",
          data: [{ index: 0, embedding: [1] }],
        }),
        2,
        1,
      ),
    ).toThrow(ProviderResponseValidationError);
    expect(() =>
      parseEmbeddingResponse({
        object: "list",
        model: "m",
        data: [{ index: 0, embedding: [Number.NaN] }],
      }),
    ).toThrow(ProviderResponseValidationError);
    const rerank = parseRerankResponse({
      id: "r",
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.8 },
      ],
    });
    expect(() => mapRerankItems(rerank, [{ id: "local-id", text: "document" }])).toThrow(
      ProviderResponseValidationError,
    );
    expect(() => parseRerankResponse({ id: "r", results: [{ index: 0 }] })).toThrow(
      ProviderResponseValidationError,
    );
  });

  it("maps 429 and preserves the provider trace ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"message":"slow down"}', {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "0",
              "x-siliconcloud-trace-id": "trace-429",
            },
          }),
      ),
    );
    await expect(
      postJson(
        "https://api.siliconflow.cn/v1/embeddings",
        "redacted",
        {},
        {
          providerId: "siliconflow",
          modelId: "m",
          operation: "embedding",
          timeoutMs: 1000,
          maxAttempts: 1,
          baseDelayMs: 1,
          maxDelayMs: 1,
          estimatedTokens: 1,
        },
      ),
    ).rejects.toMatchObject({
      code: new ProviderRateLimitError("").code,
      context: { traceId: "trace-429", retryable: true },
    });
  });

  it("never retries authentication failures", async () => {
    const request = vi.fn(
      async () =>
        new Response('{"message":"unauthorized"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", request);
    await expect(
      postJson(
        "https://api.siliconflow.cn/v1/embeddings",
        "invalid",
        {},
        {
          providerId: "siliconflow",
          modelId: "m",
          operation: "embedding",
          timeoutMs: 1_000,
          maxAttempts: 3,
          baseDelayMs: 1,
          maxDelayMs: 1,
          estimatedTokens: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_AUTHENTICATION" });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([429, 503, 504])("retries HTTP %i and returns the recovered response", async (status) => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts++;
        if (attempts === 1) {
          return new Response('{"message":"retry"}', {
            status,
            headers: { "content-type": "application/json", "retry-after": "0" },
          });
        }
        return Response.json({ ok: true });
      }),
    );
    await expect(
      postJson(
        "https://api.siliconflow.cn/v1/embeddings",
        "redacted",
        {},
        {
          providerId: "siliconflow",
          modelId: "m",
          operation: "embedding",
          timeoutMs: 1_000,
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          estimatedTokens: 1,
        },
      ),
    ).resolves.toMatchObject({ value: { ok: true }, retryCount: 1 });
    expect(attempts).toBe(2);
  });

  it("maps a timed-out fetch to a retryable provider timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    await expect(
      postJson(
        "https://api.siliconflow.cn/v1/embeddings",
        "redacted",
        {},
        {
          providerId: "siliconflow",
          modelId: "m",
          operation: "embedding",
          timeoutMs: 5,
          maxAttempts: 1,
          baseDelayMs: 1,
          maxDelayMs: 1,
          estimatedTokens: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", context: { retryable: true } });
  });

  it("omits dimensions for the fixed-dimension bge-m3 model", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          object: "list",
          model: "BAAI/bge-m3",
          data: [{ index: 0, embedding: Array.from({ length: 1_024 }, () => 0.01) }],
        });
      }),
    );
    const defaults = createDefaultConfig(process.cwd()).inference.siliconflow;
    const provider = new SiliconFlowEmbeddingProvider(
      {
        ...defaults,
        embedding: {
          ...defaults.embedding,
          model: "BAAI/bge-m3",
          dimensions: 1_024,
        },
        rerank: {
          ...defaults.rerank,
          model: "BAAI/bge-reranker-v2-m3",
          maxInputTokens: 8_192,
        },
      },
      { SILICONFLOW_API_KEY: "redacted" },
    );
    await provider.embed({
      inputs: ["fixed dimension"],
      inputKind: "query",
      dimensions: 1_024,
    });
    expect(requestBody).toMatchObject({ model: "BAAI/bge-m3" });
    expect(requestBody).not.toHaveProperty("dimensions");
  });

  it("rejects an Embedding response from a different model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          object: "list",
          model: "unexpected/model",
          data: [{ index: 0, embedding: Array.from({ length: 1_024 }, () => 0.01) }],
        }),
      ),
    );
    const defaults = createDefaultConfig(process.cwd()).inference.siliconflow;
    const provider = new SiliconFlowEmbeddingProvider(defaults, {
      SILICONFLOW_API_KEY: "redacted",
    });
    await expect(
      provider.embed({
        inputs: ["model identity"],
        inputKind: "query",
        dimensions: 1_024,
      }),
    ).rejects.toBeInstanceOf(ModelCapabilityMismatchError);
  });

  it("isolates Embedding and Rerank capability validation", () => {
    const defaults = createDefaultConfig(process.cwd()).inference.siliconflow;
    const invalidRerank = {
      ...defaults,
      rerank: { ...defaults.rerank, model: "nonexistent/reranker" },
    };
    expect(
      () =>
        new SiliconFlowEmbeddingProvider(invalidRerank, {
          SILICONFLOW_API_KEY: "redacted",
        }),
    ).not.toThrow();
    expect(
      () =>
        new SiliconFlowRerankProvider(invalidRerank, {
          SILICONFLOW_API_KEY: "redacted",
        }),
    ).toThrow(ModelCapabilityMismatchError);
  });

  it("opens a bounded circuit after repeated provider throttling", async () => {
    const gate = new ProviderRequestGate({
      concurrentRequests: 1,
      circuitFailureThreshold: 1,
      circuitOpenMs: 1000,
    });
    await expect(
      gate.run(1, undefined, async () => {
        throw new ProviderRateLimitError("throttled");
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMIT" });
    await expect(gate.run(1, undefined, async () => "not-called")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });
});
