# Progress

The Tencent-stage execution evidence pipeline remains the baseline: Artifact offload, symbolic tool
results, task/experience/provenance data, and token accounting are not P8–P13 work.

The first P8 vertical slice is connected. Both integrated and memory-only Pi extensions resolve an
immutable faceted context before capture and recall, use Pi's native leaf/parent relationship, leave
code facets absent outside code workspaces, propagate context metadata into episodes and memories,
and construct repository/project/task/topic/user recall scopes only when those facets exist. Every
memory is assigned one of eight unified domains.

Core P8 rules now include fingerprint-cache reuse and revision, repository identity normalization,
non-code Null-Workspace behavior, calibrated Topic decisions without per-turn creation, and weighted
Context Affinity with hard security/project boundaries. Unit coverage includes these cases.

P8 remains partial until context snapshots are persisted, deep refresh is backgrounded, Topic and
Task identity are persisted, and latency budgets are measured. P9–P13 have contracts only and are
not implemented. See [pi-native-roadmap.md](pi-native-roadmap.md) for the exact boundary and release
order.
