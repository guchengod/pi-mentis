import type { EmbeddingSpaceIdentity, StorageConfig } from "@pi-mentis/pi-mentis-core";

import { ZvecStore } from "./store.js";
import type { GenerationKind } from "./schema.js";

const SHARED_STORES_SYMBOL = Symbol.for("@pi-mentis/pi-mentis/zvec-stores/v1");

interface SharedStoreEntry {
  readonly store: ZvecStore;
  readonly start: Promise<void>;
  references: number;
}

type SharedStoreGlobal = typeof globalThis & {
  [SHARED_STORES_SYMBOL]?: Map<string, SharedStoreEntry>;
};

export interface SharedZvecStoreHandle {
  readonly store: ZvecStore;
  release(): Promise<void>;
}

export async function acquireSharedZvecStore(
  config: StorageConfig,
  spaces: Readonly<Record<GenerationKind, EmbeddingSpaceIdentity>>,
): Promise<SharedZvecStoreHandle> {
  const target = globalThis as SharedStoreGlobal;
  const stores = target[SHARED_STORES_SYMBOL] ?? new Map<string, SharedStoreEntry>();
  target[SHARED_STORES_SYMBOL] = stores;
  let entry = stores.get(config.rootDir);
  if (entry === undefined) {
    const store = new ZvecStore(config);
    entry = { store, start: store.start(spaces), references: 0 };
    stores.set(config.rootDir, entry);
  }
  await entry.start;
  entry.references++;
  let released = false;
  return {
    store: entry.store,
    release: async () => {
      if (released) return;
      released = true;
      entry.references--;
      if (entry.references === 0) {
        stores.delete(config.rootDir);
        await entry.store.close();
      }
    },
  };
}
