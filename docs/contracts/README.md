# Versioned cross-system contracts

- **Contract family:** Migration API
- **Major version:** 1
- **JSON Schema dialect:** Draft 2020-12

These schemas define the bounded payloads shared by the API, PostgreSQL
application layer, Step Functions, Fargate workers, S3 metadata, and agent
kernel. They do not define database tables or expose provider credentials.

## Schemas

| Contract           | Schema                                                           | Valid example                                                           |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Agent run          | [agent-run.schema.json](agent-run.schema.json)                   | [agent-run.valid.json](examples/agent-run.valid.json)                   |
| Agent action       | [agent-action.schema.json](agent-action.schema.json)             | [agent-action.valid.json](examples/agent-action.valid.json)             |
| Tool definition    | [tool.schema.json](tool.schema.json)                             | [tool.valid.json](examples/tool.valid.json)                             |
| Workflow event     | [workflow-event.schema.json](workflow-event.schema.json)         | [workflow-event.valid.json](examples/workflow-event.valid.json)         |
| Artifact reference | [artifact-reference.schema.json](artifact-reference.schema.json) | [artifact-reference.valid.json](examples/artifact-reference.valid.json) |

## Compatibility rules

- Producers write one explicit `schemaVersion`.
- Consumers reject unsupported major versions.
- Adding an optional field is minor-compatible only when every consumer ignores
  unknown minor fields after schema/version negotiation. The initial strict
  schemas otherwise reject unknown properties.
- Removing, renaming, changing meaning, or narrowing an accepted value requires
  a new major version.
- Stored events and artifacts retain the schema that created them.
- A schema change must update examples, contract tests, event consumers, and
  the relevant ADR/threat controls.

## Security rules

- Contracts carry IDs, versions, digests, safe codes, and bounded metadata.
- They never carry source text, raw prompts, tokens, keys, passwords, database
  URLs, presigned URLs, or arbitrary environment values.
- Object schemas default to `additionalProperties: false`.
- Strings and arrays have explicit bounds.
- Artifact bytes are addressed by trusted S3 metadata plus SHA-256, not included
  in workflow messages.
- `safeErrorCode` is an allowlisted public/operator classification, not an
  upstream error body.

## OpenAI strict-tool compatibility

The tool registry compiler converts `inputSchema` to an OpenAI function tool
with `strict: true`. In addition to JSON Schema validation, the compiler must
enforce:

1. every property in `inputSchema.properties` appears exactly once in
   `inputSchema.required`;
2. optional values use a nullable type but remain required as fields;
3. every nested object sets `additionalProperties: false`;
4. unsupported Structured Outputs keywords are rejected;
5. schema name/version and compiled digest are recorded.

Those set-equality and provider-subset checks are semantic contract tests; the
meta-schema alone does not prove them.

## Semantic checks not expressible cleanly in JSON Schema

- Terminal agent status and terminal code must agree.
- At least one agent-run context ID must be non-null.
- Agent-action sequences are unique and monotonic within a run.
- Workflow aggregate version is the expected current version.
- Artifact owner, S3 prefix, organisation, and KMS policy agree.
- `expiresAt`, when present, is after `createdAt`.
- Digests are recalculated from bytes at every trust boundary.

## Validation command target

Stage 1 must add a pinned JSON Schema validator and expose:

```text
npm run contracts:validate
```

The command must validate all schemas against the Draft 2020-12 meta-schema,
validate every example, and run the semantic checks above. Stage 0 performs
independent syntax and example validation without choosing the final monorepo
toolchain.
