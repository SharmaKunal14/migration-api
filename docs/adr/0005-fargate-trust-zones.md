# ADR-0005: Isolate execution capabilities in separate Fargate tasks

- **Status:** Accepted
- **Date:** 2026-07-24
- **Owners:** Platform and product security

## Context

Repository acquisition, model reasoning, patching, and test execution have
different inputs and capabilities. Customer repositories and their tests are
untrusted and may be deliberately hostile.

Known:

- Fargate gives each task dedicated infrastructure capacity.
- Containers in the same Fargate task share networking and ephemeral storage.
- Fargate does not support privileged containers or host access, but that does
  not make arbitrary code safe by itself.
- A task role is available to containers in the task unless the design removes
  or mediates that capability.

Assumed:

- Initial verification can run without private package credentials.
- Explicit resource and network limits are acceptable even when they make some
  repositories unsupported.

## Decision

Use separate Fargate tasks, task definitions, IAM roles, security groups, and
subnet classes for:

1. trusted source acquisition;
2. agent reasoning and patch workspace;
3. hostile-code verification.

Do not place these trust zones in sidecars within one task.

Keep the token broker and trusted publisher outside these tasks as narrowly
scoped Lambda control-plane workloads.

## Capability matrix

| Workload       | GitHub | OpenAI | PostgreSQL | S3                          | General internet |
| -------------- | ------ | ------ | ---------- | --------------------------- | ---------------- |
| Source fetcher | Broker | No     | No         | Input snapshot prefix       | GitHub only      |
| Agent          | No     | WIF    | No         | Exact run prefix            | OpenAI only      |
| Verifier       | No     | No     | No         | Exact one-shot capabilities | No               |
| Publisher      | Broker | No     | Limited    | Validated patch read        | GitHub only      |

The verifier downloads inputs before execution and removes S3 capability values
from the child-process environment. Test output is untrusted even when the
process exits successfully.

## Container baseline

- Linux, non-root user.
- Read-only container root filesystem.
- Dedicated disposable writable workspace.
- No privileged mode, Docker socket, host mount, or device access.
- Drop all Linux capabilities unless an individually documented exception is
  required.
- Fixed CPU, memory, PID, ephemeral-storage, output, and wall-clock limits.
- Minimal allowlisted environment.
- Direct process spawning with executable/argument arrays; no shell strings.
- Image referenced by digest, scanned, and accompanied by an SBOM.
- ECS Exec disabled by default; any production break-glass use is time-bound,
  approved, and audited.

## Network rules

- `awsvpc` networking and one security group per task class.
- Agent has no public IP and reaches regional STS/S3 endpoints plus the
  allowlisted OpenAI endpoint through controlled egress.
- Verifier has no route to general internet, PostgreSQL, GitHub, OpenAI,
  metadata services, or internal control APIs.
- Security groups alone are not considered hostname controls.

## Consequences

Benefits:

- Credential compromise in one workload does not automatically expose another.
- Hostile tests cannot directly publish code or query application state.
- Task-specific IAM and egress are independently testable.

Costs and limitations:

- More images, task definitions, and startup latency.
- Fargate is a containment layer, not a proof that arbitrary code cannot exploit
  the runtime.
- Dependency installation without network/private credentials supports fewer
  repositories.

## Rejected alternatives

- **One multi-container task:** shared task resources collapse the intended
  trust boundary.
- **Run tests inside the agent task:** exposes model and S3 run capabilities to
  repository code.
- **Lambda for repository execution:** insufficient execution and filesystem
  model and no meaningful security simplification.
- **Give verifier a normal AWS task role:** reusable credentials would be
  available to hostile code.

## Reversal triggers

Consider stronger isolation such as dedicated accounts, Firecracker-based
workers, customer-hosted runners, or one-time compute if adversarial testing,
customer policy, or real incidents show Fargate task isolation is insufficient.

## Validation

- Hostile fixtures attempt network access, credential discovery, fork bombs,
  disk exhaustion, memory exhaustion, symlink escape, and excessive output.
- Agent role cannot call GitHub or PostgreSQL.
- Verifier process environment contains no reusable cloud, model, GitHub, or
  database credential.
- Trust-zone tasks cannot communicate over localhost because they are not in the
  same task.

## References

- [Fargate security considerations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html)
- [ECS task and container security practices](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-tasks-containers.html)
- [ECS network security practices](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-network.html)
