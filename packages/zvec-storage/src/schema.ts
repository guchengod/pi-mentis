import {
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  ZVecQuantizeType,
  type ZVecFieldSchema,
} from "@zvec/zvec";

const invert = { indexType: ZVecIndexType.INVERT } as const;

const baseFields: readonly ZVecFieldSchema[] = [
  { name: "kind", dataType: ZVecDataType.STRING, indexParams: invert },
  { name: "namespace", dataType: ZVecDataType.STRING, indexParams: invert },
  { name: "status", dataType: ZVecDataType.STRING, indexParams: invert },
  { name: "payload", dataType: ZVecDataType.STRING },
  { name: "created_at", dataType: ZVecDataType.INT64 },
  { name: "updated_at", dataType: ZVecDataType.INT64 },
];

export function scalarCollectionSchema(name: string): ZVecCollectionSchema {
  return new ZVecCollectionSchema({ name, fields: [...baseFields] });
}

export function vectorCollectionSchema(name: string, dimensions: number): ZVecCollectionSchema {
  return new ZVecCollectionSchema({
    name,
    vectors: {
      name: "embedding",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: dimensions,
      indexParams: {
        indexType: ZVecIndexType.HNSW,
        metricType: ZVecMetricType.COSINE,
        m: 32,
        efConstruction: 300,
        quantizeType: ZVecQuantizeType.INT8,
        quantizerParams: { enableRotate: true },
      },
    },
    fields: [
      ...baseFields,
      {
        name: "searchable_text",
        dataType: ZVecDataType.STRING,
        indexParams: {
          indexType: ZVecIndexType.FTS,
          tokenizerName: "standard",
          filters: ["lowercase", "ascii_folding"],
        },
      },
      { name: "content_hash", dataType: ZVecDataType.STRING, indexParams: invert },
      { name: "source_id", dataType: ZVecDataType.STRING, indexParams: invert },
      { name: "document_id", dataType: ZVecDataType.STRING, indexParams: invert },
      { name: "authority", dataType: ZVecDataType.INT32, indexParams: invert },
      { name: "token_count", dataType: ZVecDataType.INT32 },
      { name: "revision", dataType: ZVecDataType.INT32, indexParams: invert },
    ],
  });
}

export const SCALAR_COLLECTIONS = [
  "knowledge_sources_v1",
  "knowledge_documents_v1",
  "relationships_v1",
  "jobs_v1",
  "episodes_v1",
  "events_v1",
  "artifacts_v1",
  "mentis_state_v1",
  "mentis_views_v1",
] as const;

export type ScalarCollectionName = (typeof SCALAR_COLLECTIONS)[number];

export type GenerationKind = "knowledge" | "memory" | "capability";

export function generationCollectionName(kind: GenerationKind, generationId: string): string {
  const prefix =
    kind === "knowledge"
      ? "knowledge_chunks"
      : kind === "memory"
        ? "memory_records"
        : "capabilities";
  if (!/^[a-zA-Z0-9_-]+$/.test(generationId)) {
    throw new Error(`Invalid generation ID ${generationId}`);
  }
  return `${prefix}_g_${generationId}`;
}
