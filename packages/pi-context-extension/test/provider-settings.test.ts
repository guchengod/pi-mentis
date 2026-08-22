import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ProviderAuthenticationError } from "@pi-mentis/pi-mentis-core";
import { ReloadableEmbeddingProvider } from "@pi-mentis/pi-mentis-inference";

import {
  MentisSettingsController,
  type ProviderRuntimeStatus,
} from "../src/mentis-settings-controller.js";
import {
  MacOSKeychainSecretStore,
  ProviderConfigStore,
  ProviderRegistry,
  SILICONFLOW_PROVIDER,
  resolveCredential,
  safeProviderError,
  type MentisProviderDefinition,
  type SecretStore,
} from "../src/provider-settings.js";
import { MaskedSecretInput } from "../src/secret-input.js";

class MemorySecretStore implements SecretStore {
  readonly available = true;
  readonly values = new Map<string, string>();
  has(id: string) {
    return Promise.resolve(this.values.has(id));
  }
  get(id: string) {
    return Promise.resolve(this.values.get(id));
  }
  async set(id: string, value: string) {
    this.values.set(id, value);
  }
  async delete(id: string) {
    this.values.delete(id);
  }
}

describe("provider settings secret boundary", () => {
  it("resolves secure settings before environment and preserves legacy environment fallback", async () => {
    const store = new MemorySecretStore();
    store.values.set(SILICONFLOW_PROVIDER.credential.secretId, "secure-value");
    await expect(
      resolveCredential(SILICONFLOW_PROVIDER, store, { SILICONFLOW_API_KEY: "environment-value" }),
    ).resolves.toMatchObject({ source: "secure", value: "secure-value", environmentPresent: true });
    store.values.clear();
    await expect(
      resolveCredential(SILICONFLOW_PROVIDER, store, { SILICONFLOW_API_KEY: "environment-value" }),
    ).resolves.toMatchObject({ source: "environment", value: "environment-value" });
    await expect(resolveCredential(SILICONFLOW_PROVIDER, store, {})).resolves.toMatchObject({
      source: "missing",
      configured: false,
    });
  });

  it("passes Keychain secrets directly to the native entry without process argv", async () => {
    const nonce = "TEST_ONLY_SECRET_keychain_8f1";
    const calls: Array<{ service: string; account: string; value?: string }> = [];
    const store = new MacOSKeychainSecretStore("pi-mentis-test", async (service, account) => {
      const call = { service, account };
      calls.push(call);
      return {
        getPassword: () => "",
        setPassword: (value) => Object.assign(call, { value }),
        deletePassword: () => true,
      };
    });
    await store.set("provider:siliconflow:test", nonce);
    expect(calls[0]).toEqual({
      service: "pi-mentis-test",
      account: "provider:siliconflow:test",
      value: nonce,
    });
  });

  it("never serializes a credential into the versioned config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mentis-provider-settings-"));
    const filename = path.join(root, "config.json");
    const nonce = "TEST_ONLY_SECRET_config_91c";
    try {
      await writeFile(filename, "{}\n", { mode: 0o600 });
      const store = new ProviderConfigStore(filename);
      const current = await store.load(root, {});
      await store.save(
        root,
        {
          endpoint: current.inference.siliconflow.baseUrl,
          embeddingModel: current.inference.siliconflow.embedding.model,
          rerankModel: current.inference.siliconflow.rerank.model,
        },
        { SILICONFLOW_API_KEY: nonce },
      );
      const serialized = await readFile(filename, "utf8");
      expect(serialized).not.toContain(nonce);
      expect(JSON.parse(serialized)).toMatchObject({ mentisSettings: { version: 1, revision: 1 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects provider errors without response or credential content", () => {
    const nonce = "TEST_ONLY_SECRET_error_f77";
    const error = new ProviderAuthenticationError(`HTTP 401 echoed ${nonce}`, {
      details: { statusCode: 401, response: nonce },
    });
    const safe = safeProviderError(error);
    expect(JSON.stringify(safe)).not.toContain(nonce);
    expect(safe).toEqual({
      category: "authentication",
      message: "HTTP 401: credential rejected",
      httpStatus: 401,
    });
  });

  it("lets a fake provider definition drive the same registry without production registration", () => {
    const fake: MentisProviderDefinition = {
      id: "fake-provider",
      displayName: "Fake Provider",
      credential: { secretId: "provider:fake:default", envNames: ["FAKE_KEY"] },
      defaults: { endpoint: "https://localhost/v1", embeddingModel: "e", rerankModel: "r" },
      capabilities: { embeddings: true, rerank: false },
    };
    expect(new ProviderRegistry([fake]).get("fake-provider")?.displayName).toBe("Fake Provider");
    expect(new ProviderRegistry().list().map(({ id }) => id)).toEqual(["siliconflow"]);
  });

  it("masks secret input and clears cancellation without rendering plaintext", () => {
    const nonce = "TEST_ONLY_SECRET_input_a42";
    const done = vi.fn();
    const component = new MaskedSecretInput(
      { requestRender: vi.fn() },
      { fg: (_color, text) => text },
      {
        matches: (data, action) =>
          (action === "tui.select.cancel" && data === "ESC") ||
          (action === "tui.input.submit" && data === "ENTER"),
      },
      done,
    );
    component.handleInput(nonce);
    expect(component.render().join("\n")).not.toContain(nonce);
    component.handleInput("ESC");
    expect(done).toHaveBeenCalledWith(undefined);
    expect(component.render().join("\n")).not.toContain(nonce);
  });

  it("keeps slash-command credential input out of notifications and runtime IPC", async () => {
    const nonce = "TEST_ONLY_SECRET_capture_d31";
    const store = new MemorySecretStore();
    const notifications: string[] = [];
    const runtimeCalls: string[] = [];
    const status: ProviderRuntimeStatus = {
      ready: false,
      providerId: "siliconflow",
      providerName: "SiliconFlow",
      credentialSource: "missing",
      configured: false,
      endpoint: "https://api.siliconflow.cn/v1",
      embeddingModel: "Qwen/Qwen3-Embedding-8B",
      rerankEnabled: true,
      rerankModel: "Qwen/Qwen3-Reranker-8B",
    };
    const controller = new MentisSettingsController({
      configStore: new ProviderConfigStore("/unused/config.json"),
      secretStore: store,
      environment: {},
      runtime: {
        status: async () => status,
        reload: async () => {
          runtimeCalls.push("provider.reload:{}");
          return { activated: true };
        },
        test: async () => ({
          providerId: "siliconflow",
          providerName: "SiliconFlow",
          authentication: "missing",
          embedding: "not-run",
          rerank: "not-run",
          embeddingModel: status.embeddingModel,
          latencyMs: 0,
        }),
        models: vi.fn(),
      },
    });
    const context = {
      cwd: "/unused",
      ui: {
        custom: vi.fn(async () => nonce),
        notify: (message: string) => notifications.push(message),
      },
    } as unknown as ExtensionCommandContext;
    await controller.handle("key", context);
    expect(store.values.get(SILICONFLOW_PROVIDER.credential.secretId)).toBe(nonce);
    expect(JSON.stringify({ notifications, runtimeCalls })).not.toContain(nonce);
    expect(runtimeCalls).toEqual(["provider.reload:{}"]);
  });

  it("cancels a draft credential without changing the active credential", async () => {
    const store = new MemorySecretStore();
    store.values.set(SILICONFLOW_PROVIDER.credential.secretId, "original");
    const reload = vi.fn();
    const controller = new MentisSettingsController({
      configStore: new ProviderConfigStore("/unused/config.json"),
      secretStore: store,
      environment: {},
      runtime: {
        status: async () => ({
          ready: true,
          providerId: "siliconflow",
          providerName: "SiliconFlow",
          credentialSource: "secure",
          configured: true,
          endpoint: "https://api.siliconflow.cn/v1",
          embeddingModel: "e",
          rerankEnabled: false,
          rerankModel: "r",
        }),
        reload,
        test: vi.fn(),
        models: vi.fn(),
      },
    });
    const context = {
      cwd: "/unused",
      ui: {
        custom: vi.fn(async () => undefined),
        notify: vi.fn(),
      },
    } as unknown as ExtensionCommandContext;
    await controller.handle("key", context);
    expect(store.values.get(SILICONFLOW_PROVIDER.credential.secretId)).toBe("original");
    expect(reload).not.toHaveBeenCalled();
  });

  it("selects a provider, opens key input immediately, and shows save-free model settings", async () => {
    const store = new MemorySecretStore();
    let configured = false;
    const menus: Array<{ title: string; options: readonly string[] }> = [];
    const selections = ["SiliconFlow", "Back"];
    const controller = new MentisSettingsController({
      configStore: new ProviderConfigStore("/unused/config.json"),
      secretStore: store,
      environment: {},
      runtime: {
        status: async () => ({
          ready: configured,
          providerId: "siliconflow",
          providerName: "SiliconFlow",
          credentialSource: configured ? "secure" : "missing",
          configured,
          endpoint: "https://api.siliconflow.cn/v1",
          embeddingModel: "Qwen/Qwen3-Embedding-8B",
          rerankEnabled: true,
          rerankModel: "Qwen/Qwen3-Reranker-8B",
        }),
        reload: async () => {
          configured = true;
          return { activated: true };
        },
        test: vi.fn(),
        models: vi.fn(),
      },
    });
    const context = {
      cwd: "/unused",
      ui: {
        select: vi.fn(async (title: string, options: readonly string[]) => {
          menus.push({ title, options });
          return selections.shift();
        }),
        custom: vi.fn(async () => "new-secret"),
        notify: vi.fn(),
      },
    } as unknown as ExtensionCommandContext;

    await controller.handle("", context);

    expect(context.ui.custom).toHaveBeenCalledOnce();
    expect(menus[0]).toEqual({ title: "Select Provider", options: ["SiliconFlow"] });
    expect(menus[1]?.title).toBe("SiliconFlow");
    expect(menus[1]?.options.join("\n")).not.toMatch(/Endpoint|Replace|Save/u);
    expect(menus[1]?.options).toContain("Embedding Model — Qwen/Qwen3-Embedding-8B");
  });

  it("persists and activates a selected model immediately without a Save action", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mentis-model-select-"));
    const filename = path.join(root, "config.json");
    try {
      await writeFile(filename, "{}\n", { mode: 0o600 });
      const configStore = new ProviderConfigStore(filename);
      const current = await configStore.load(root, {});
      const selections = [
        `Embedding Model — ${current.inference.siliconflow.embedding.model}`,
        "BAAI/bge-m3",
        "Back",
      ];
      const reload = vi.fn(async () => ({ activated: true }));
      const controller = new MentisSettingsController({
        configStore,
        secretStore: new MemorySecretStore(),
        environment: { SILICONFLOW_API_KEY: "environment" },
        runtime: {
          status: async () => ({
            ready: true,
            providerId: "siliconflow",
            providerName: "SiliconFlow",
            credentialSource: "environment",
            configured: true,
            endpoint: current.inference.siliconflow.baseUrl,
            embeddingModel: current.inference.siliconflow.embedding.model,
            rerankEnabled: true,
            rerankModel: current.inference.siliconflow.rerank.model,
          }),
          reload,
          test: vi.fn(),
          models: async () => ({
            providerId: "siliconflow",
            providerName: "SiliconFlow",
            embeddingModels: ["Qwen/Qwen3-Embedding-8B", "BAAI/bge-m3"],
            rerankModels: ["Qwen/Qwen3-Reranker-8B"],
            source: "remote",
          }),
        },
      });
      const context = {
        cwd: root,
        ui: {
          select: vi.fn(async () => selections.shift()),
          notify: vi.fn(),
        },
      } as unknown as ExtensionCommandContext;

      await controller.handle("config", context);

      const updated = await configStore.load(root, {});
      expect(updated.inference.siliconflow.embedding).toMatchObject({
        model: "BAAI/bge-m3",
        dimensions: 1_024,
      });
      const persisted = JSON.parse(await readFile(filename, "utf8")) as {
        inference: { siliconflow: Record<string, unknown> };
      };
      expect(persisted.inference.siliconflow).not.toHaveProperty("baseUrl");
      expect(reload).toHaveBeenCalledOnce();
      expect(context.ui.select).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining(["Save"]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removing secure settings activates the environment fallback", async () => {
    const store = new MemorySecretStore();
    store.values.set(SILICONFLOW_PROVIDER.credential.secretId, "secure");
    const reload = vi.fn(async () => ({ activated: true }));
    const selections = ["Remove Stored API Key", "Back"];
    const controller = new MentisSettingsController({
      configStore: new ProviderConfigStore("/unused/config.json"),
      secretStore: store,
      environment: { SILICONFLOW_API_KEY: "environment" },
      runtime: {
        status: async () => ({
          ready: true,
          providerId: "siliconflow",
          providerName: "SiliconFlow",
          credentialSource: "secure",
          configured: true,
          endpoint: "https://api.siliconflow.cn/v1",
          embeddingModel: "e",
          rerankEnabled: false,
          rerankModel: "r",
        }),
        reload,
        test: vi.fn(),
        models: vi.fn(),
      },
    });
    const context = {
      cwd: "/unused",
      ui: {
        select: vi.fn(async () => selections.shift()),
        confirm: vi.fn(async () => true),
        notify: vi.fn(),
      },
    } as unknown as ExtensionCommandContext;
    await controller.handle("config", context);
    expect(store.values.has(SILICONFLOW_PROVIDER.credential.secretId)).toBe(false);
    await expect(
      resolveCredential(SILICONFLOW_PROVIDER, store, { SILICONFLOW_API_KEY: "environment" }),
    ).resolves.toMatchObject({ source: "environment", value: "environment" });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps the prior delegate when an invalid replacement is never swapped", async () => {
    const provider = new ReloadableEmbeddingProvider("siliconflow");
    const original = {
      id: "siliconflow",
      capabilities: vi.fn(),
      health: vi.fn(),
      embed: vi.fn(async () => ({ model: "original", vectors: [] })),
    };
    provider.swap(original);
    // Preparing a replacement failed, so the runtime deliberately does not call swap().
    await expect(
      provider.embed({ inputs: ["x"], inputKind: "query", dimensions: 1024 }),
    ).resolves.toMatchObject({ model: "original" });
  });

  it("rolls back persisted provider config when runtime activation fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mentis-provider-rollback-"));
    const filename = path.join(root, "config.json");
    try {
      await writeFile(filename, "{}\n", { mode: 0o600 });
      const configStore = new ProviderConfigStore(filename);
      const original = await configStore.load(root, {});
      const selections = [
        `Embedding Model — ${original.inference.siliconflow.embedding.model}`,
        "BAAI/bge-m3",
        "Back",
      ];
      const reload = vi
        .fn()
        .mockResolvedValueOnce({
          activated: false,
          error: { category: "configuration", message: "invalid model" },
        })
        .mockResolvedValueOnce({ activated: true });
      const controller = new MentisSettingsController({
        configStore,
        secretStore: new MemorySecretStore(),
        environment: {},
        runtime: {
          status: async () => ({
            ready: true,
            providerId: "siliconflow",
            providerName: "SiliconFlow",
            credentialSource: "environment",
            configured: true,
            endpoint: original.inference.siliconflow.baseUrl,
            embeddingModel: original.inference.siliconflow.embedding.model,
            rerankEnabled: true,
            rerankModel: original.inference.siliconflow.rerank.model,
          }),
          reload,
          test: vi.fn(),
          models: async () => ({
            providerId: "siliconflow",
            providerName: "SiliconFlow",
            embeddingModels: ["Qwen/Qwen3-Embedding-8B", "BAAI/bge-m3"],
            rerankModels: ["Qwen/Qwen3-Reranker-8B", "BAAI/bge-reranker-v2-m3"],
            source: "remote",
          }),
        },
      });
      const context = {
        cwd: root,
        ui: {
          select: vi.fn(async () => selections.shift()),
          notify: vi.fn(),
        },
      } as unknown as ExtensionCommandContext;
      await controller.handle("config", context);
      const restored = await configStore.load(root, {});
      expect(restored.inference.siliconflow.embedding.model).toBe(
        original.inference.siliconflow.embedding.model,
      );
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
