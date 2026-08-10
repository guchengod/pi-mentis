# Operations

Use `/kb add <path-or-url>`, `/kb sync <path>`, `/kb remove <source-id>`,
`/kb inspect <document-id>`, `/kb jobs <job-id>`, `/kb cancel <job-id>`, `/kb models`,
and the migration commands documented separately. Storage is single-writer; a second
writer receives `StorageBusyError`. Manifests are atomic and Zvec collections open
lazily.

The default profile uses one stable root at `~/.pi/.pi-mentis`; all workspaces and Pi
modes share it. Custom `PI_CODING_AGENT_DIR` values create explicit isolated profiles.
For compatibility, `~/.pi/agent/.pi-mentis` is selected only when it is the sole existing
default-profile store. If both locations exist, the stable home root is active and the agent-root
store is reported as inactive. Do not copy Zvec directories over one another.

Back up the entire configured storage directory only after stopping the writer. Restore
the directory as one unit. Do not edit collection files or the active manifest by hand.
Telemetry records hashes, counts, dimensions, durations, trace IDs, and status—not API
keys or full sensitive documents.
