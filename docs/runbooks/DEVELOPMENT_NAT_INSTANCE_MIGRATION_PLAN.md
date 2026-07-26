# Development NAT instance migration plan

## Decision summary

Replace the two managed NAT Gateways and the two-AZ AWS Network Firewall
deployment in the **development** environment with one hardened, self-managed
EC2 NAT instance and one new Elastic IP address.

This is a cost optimization, not a security-equivalent replacement. It keeps
private workloads and a stable Supabase allowlist address, but removes the
Network Firewall TLS-SNI destination allowlist and multi-AZ managed egress
availability.

No production environment should adopt this design without a separate risk,
availability, capacity, and operations review.

## Current state

The development VPC is `10.40.0.0/16` across two Availability Zones.

- Two public subnets host one managed NAT Gateway and Elastic IP per AZ.
- Control subnets route directly to their same-AZ NAT Gateway.
- Agent and source-fetcher subnets route through same-AZ Network Firewall
  endpoints and then through the NAT Gateways.
- The Network Firewall allows the agent to reach approved OpenAI TLS hostnames
  and the source fetcher to reach approved GitHub TLS hostnames.
- Control Lambdas, the database migrator, and the vendor fetcher require public
  PostgreSQL or HTTPS access through the control routing path.
- Supabase PostgreSQL network restrictions use
  `control_nat_egress_cidrs`, currently derived from both NAT Elastic IPs.
- S3 uses a gateway endpoint. ECR, CloudWatch Logs, KMS, Lambda, Secrets
  Manager, and STS use interface endpoints.
- Fargate tasks do not receive public IP addresses.

## Target state

```text
Control, agent, and source-fetcher private subnets
                         |
                         v
       Single hardened EC2 NAT instance
       - public subnet in one AZ
       - source/destination check disabled
       - one dedicated Elastic IP
       - no inbound administrative access
                         |
                         v
                  Internet Gateway
```

The following properties remain unchanged:

- Lambdas and Fargate tasks remain in private subnets.
- Fargate `AssignPublicIp` remains `DISABLED`.
- Supabase continues to allowlist one stable `/32` egress address.
- TLS certificate verification remains enabled.
- IAM, KMS encryption, Secrets Manager, VPC endpoints, task concurrency,
  application SSRF controls, byte limits, and timeouts remain enforced.

The following properties intentionally change:

- Development egress becomes single-AZ and a single point of failure.
- AWS no longer manages NAT patching, scaling, recovery, or availability.
- Network-level OpenAI and GitHub hostname enforcement is removed.
- All approved application workloads can make outbound connections on the
  explicitly permitted ports if their code or dependencies are compromised.
- Traffic from workloads in the other AZ incurs cross-AZ data-transfer charges.

## Assumptions and acceptance criteria

The migration may proceed only if all of these assumptions are accepted:

1. Development downtime during an egress failure is acceptable.
2. Synthetic or non-sensitive data remains the only development data.
3. A single-AZ egress dependency is acceptable.
4. The team accepts operational ownership of the NAT operating system.
5. Stable Supabase egress allowlisting must be preserved.
6. Expected throughput and concurrent connection counts are small.
7. No workload requires UDP internet access.
8. Current external requirements fit TCP ports `443`, `5432`, and `6543`.
9. The application-level OpenAI, GitHub, and vendor URL restrictions remain
   covered by tests.
10. A temporary overlap of old and new egress infrastructure is acceptable
    during a safe blue/green cutover.

Completion requires:

- All private workload route tables use the NAT instance.
- The observed public egress IP equals the new NAT instance Elastic IP.
- Supabase permits only the new approved development `/32` after cleanup.
- API, authentication, GitHub, repository scanning, agent execution, database
  migration, and vendor ingestion acceptance tests pass.
- No unexpected GitHub webhook DLQ messages or CloudWatch alarms are present.
- The prior NAT Gateways, their Elastic IPs, Network Firewall resources, and
  obsolete firewall routes are removed only after acceptance.
- A tested rollback path exists before destructive cleanup.

## Proposed infrastructure design

### Instance

Use a small ARM-based EC2 instance suitable for measured development traffic.
Start with `t4g.nano` only if load testing proves its CPU credits, memory,
network throughput, and connection tracking are sufficient; otherwise use
`t4g.micro`.

Pin a reviewed Amazon Linux 2023 ARM64 AMI ID in deployment configuration.
Do not automatically follow a mutable "latest AMI" parameter during routine
application deployments.

Configure:

- an encrypted `gp3` root volume;
- IMDSv2 required;
- metadata hop limit `1`;
- detailed instance metadata tags disabled unless required;
- source/destination check disabled;
- termination protection during the cutover;
- no SSH key pair;
- no inbound SSH rule;
- Systems Manager access through a minimal instance profile;
- a dedicated Elastic IP allocated before cutover;
- normal application and ownership tags;
- automatic recovery alarm for EC2 system-status failure;
- CPU, network, status-check, and disk-space monitoring;
- a finite log retention policy.

### Operating system

The bootstrap must be idempotent and fail closed:

1. Enable persistent `net.ipv4.ip_forward=1`.
2. Detect the primary network interface without hard-coding `eth0`.
3. Configure `nftables` rather than relying on ephemeral shell rules.
4. Permit forwarding only from the expected private workload CIDRs.
5. Permit only required outbound TCP destinations ports:
   - `443` for OpenAI, GitHub, Supabase HTTPS, and AWS public endpoints;
   - `5432` for PostgreSQL session pooling when configured;
   - `6543` for PostgreSQL transaction pooling when configured.
6. Apply source NAT/masquerading only on the public interface.
7. Permit established and related return traffic.
8. Drop and log unexpected forwarding with rate limits.
9. Persist rules across reboot.
10. Refuse to signal healthy until forwarding and firewall rules are active.

Do not place secrets, database credentials, API tokens, or private keys in user
data, launch-template data, tags, logs, or Terraform state.

### Security groups and network ACLs

Create a dedicated NAT-instance security group:

- no public ingress;
- forwarded ingress only from the control, agent, and source-fetcher subnet
  CIDRs on required destination ports;
- outbound only on TCP `443`, `5432`, and `6543`;
- no unrestricted administrative ingress.

Confirm that subnet network ACLs permit the required forward and return
ephemeral-port traffic. Prefer security groups and stateful `nftables` for
policy; avoid introducing complex custom network ACLs without packet-level
tests.

### Routing

The NAT instance resides in one existing public subnet whose route table
already sends `0.0.0.0/0` to the Internet Gateway.

After the canary phase, change `0.0.0.0/0` in every control, agent, and
source-fetcher route table to the NAT instance's primary network interface.

Remove, only in the cleanup phase:

- agent and source-fetcher routes to Network Firewall endpoints;
- public-subnet return routes through Network Firewall;
- firewall subnet default routes to managed NAT Gateways;
- firewall route-table associations;
- firewall endpoint lookup locals;
- Network Firewall logging configuration, firewall, policy, and rule group;
- managed NAT Gateways and their original Elastic IPs;
- unused firewall subnets and route tables;
- the obsolete Network Firewall log group after its retention requirement is
  satisfied.

Keep:

- Internet Gateway and public subnets;
- private workload subnets and associations;
- S3 gateway endpoint;
- required interface endpoints and their security group;
- Fargate private addressing.

### Outputs and external configuration

Replace `control_nat_egress_cidrs` with a provider-neutral output such as
`development_egress_cidrs`, containing only the new NAT instance Elastic IP as
a `/32`.

Update:

- the Stage 1 deployment runbook;
- infrastructure inventory, data-flow documentation, threat model, and Fargate
  trust-zone ADR;
- cost and operational ownership documentation;
- Supabase network restriction instructions;
- tests that currently assert Network Firewall SNI rules.

Do not remove the two existing Supabase allowlist entries until the new route is
verified from every workload class.

## Security trade-offs and compensating controls

Security groups cannot restrict outbound traffic by DNS hostname. Removing
Network Firewall means a compromised process can send TCP `443` traffic to an
arbitrary public address.

Required compensating controls:

- Keep the agent without a general HTTP or shell tool.
- Keep GitHub credentials isolated in the token broker.
- Keep repository selection and installation authorization server-side.
- Keep exact-host URL allowlists for GitHub and vendor acquisition.
- Reject URL credentials, non-HTTPS schemes, ports, queries, fragments, and
  unapproved redirects where contracts require them.
- Resolve DNS before connecting; reject private, loopback, link-local,
  documentation, multicast, reserved, and metadata addresses.
- Pin validated addresses into TLS connections while preserving hostname
  certificate validation.
- Enforce response media types, timeouts, byte limits, redirect limits, and
  bounded retries.
- Preserve read-only filesystems, non-root containers, dropped Linux
  capabilities, task timeouts, and bounded concurrency.
- Add VPC Flow Logs for accepted and rejected egress with encrypted,
  finite-retention storage.
- Alarm on unusual NAT-instance bytes, packets, connection counts, CPU,
  status-check failures, reboots, and stopped state.
- Add AWS Config or equivalent checks for IMDSv2, encrypted volumes, no public
  ingress, and source/destination check disabled only on the designated NAT.
- Explicitly record this development-only risk acceptance.

The change must not be described as security-equivalent to Network Firewall.

## Edge cases and failure modes

### Availability and recovery

- **Instance stop or crash:** all external HTTPS and PostgreSQL access fails
  closed. API operations requiring Supabase, GitHub, or workflow egress fail.
- **AZ failure:** workloads in both AZs lose egress because the one NAT instance
  is in a single AZ.
- **Failed boot configuration:** routes may point to an instance that is
  running but not forwarding. Cut over only after an explicit health check.
- **EC2 replacement:** the primary ENI ID can change. Terraform must update
  routes, and the dedicated Elastic IP must be re-associated.
- **AMI update:** an unsafe replacement can interrupt all egress. Use a
  blue/green NAT-instance replacement, never in-place mutation without
  rollback.
- **SSM unavailable:** no SSH fallback exists. Recovery is replacement from a
  reviewed image and bootstrap, or an offline root-volume repair procedure.

### Routing

- **Asymmetric routing:** ensure every private default route targets the same
  NAT ENI and return traffic leaves through its Elastic IP.
- **Cross-AZ traffic:** is functional but incurs cost and adds an AZ dependency.
- **Stale firewall return routes:** can black-hole agent/source-fetcher return
  traffic after firewall deletion.
- **Route replacement ordering:** deleting a firewall or NAT Gateway before
  replacing dependent routes causes an outage.
- **Terraform partial failure:** preserve the saved plan and inspect route
  targets after every apply; do not use broad `-target` as a recovery shortcut.
- **IPv6 bypass:** the current VPC is IPv4-only. Do not add `::/0`, public IPv6,
  or an egress-only Internet Gateway without equivalent policy and tests.

### Capacity

- **CPU credit exhaustion:** burstable instances can throttle and appear as
  intermittent network failures.
- **Connection tracking exhaustion:** parallel GitHub downloads, model calls,
  webhooks, and database connections can exhaust conntrack or ephemeral ports.
- **Large repository archives:** can saturate the instance network interface.
- **Packet fragmentation and MTU:** GitHub/OpenAI TLS failures can occur if path
  MTU discovery is blocked. Preserve required ICMP behavior or clamp TCP MSS
  only with evidence.
- **Disk exhaustion:** forwarding should not depend on local disk, but logs can
  fill the root volume if not bounded.

### Security and operations

- **NAT instance compromise:** it becomes a privileged traffic chokepoint.
  Minimize packages, patch it, prohibit interactive login, and restrict its IAM
  role.
- **User-data leakage:** EC2 user data is not a secret store.
- **Overbroad forwarding:** never allow arbitrary source CIDRs or all outbound
  protocols merely to make a test pass.
- **Direct workload public IP:** keep `AssignPublicIp = DISABLED`; otherwise
  traffic bypasses the NAT instance and Supabase allowlist.
- **Unexpected public endpoint use:** interface endpoints should remain the
  preferred path for supported AWS services.
- **DNS behavior:** workloads continue using the VPC resolver; the NAT instance
  must not become an ad hoc DNS server.
- **Time synchronization:** use the Amazon Time Sync Service; do not open broad
  public NTP.
- **Supabase lockout:** adding the new `/32` must precede route cutover, while
  removing old `/32` entries must follow full acceptance.

## Implementation phases

Use separate saved Terraform plans and protected applies for each phase. Do not
combine creation, route cutover, and destructive cleanup into one apply.

### Phase 0: baseline and backups

1. Confirm the working tree contains no unrelated changes.
2. Record the currently deployed revision and Terraform state serial.
3. Back up the remote Terraform state through its versioned S3 bucket.
4. Export:
   - current route tables and routes;
   - NAT Gateway IDs and Elastic IPs;
   - firewall ARN, endpoint IDs, policy, and rule group;
   - subnet/AZ mappings;
   - security groups and network ACLs;
   - Supabase allowlisted CIDRs;
   - relevant CloudWatch alarms and log groups.
5. Record a 24-hour baseline for NAT/firewall bytes, agent/source-fetcher
   concurrency, connection counts where available, and workflow durations.
6. Run and save results for the verification matrix below.
7. Resolve unrelated failing workflows before changing routing.
8. Confirm the Stage 3B HTTPS adapter fix is deployed before using vendor
   ingestion as a network acceptance test.

### Phase 1: create the NAT instance without changing routes

1. Add the pinned AMI, launch template or instance, encrypted root volume,
   minimal instance profile, dedicated security group, new Elastic IP, status
   alarms, and flow logging.
2. Set source/destination check to false.
3. Bootstrap and persist IPv4 forwarding and `nftables`.
4. Do not change workload routes.
5. Create and inspect a saved Terraform plan.
6. Verify the plan adds only the new canary egress resources and monitoring.
7. Apply after approval.
8. Use SSM to perform read-only health inspection:
   - forwarding sysctl is enabled;
   - expected `nftables` rules are loaded;
   - default route uses the public subnet;
   - Elastic IP is associated;
   - no listener is exposed publicly;
   - instance and system status checks pass.
9. Add the new Elastic IP `/32` to Supabase alongside both old NAT addresses.
10. Confirm the existing application remains healthy before proceeding.

### Phase 2: canary route

Use a dedicated temporary canary subnet or one non-critical development
workload route table. Do not use a production tenant or silently reroute every
subnet as the first test.

1. Route the canary subnet's `0.0.0.0/0` to the NAT ENI.
2. Launch a short-lived diagnostic task with no secrets and no inbound rules.
3. Verify:
   - observed public address equals the new Elastic IP;
   - approved HTTPS endpoint connectivity;
   - DNS resolution;
   - TLS certificate validation;
   - supported AWS endpoint connectivity;
   - blocked/unapproved port behavior;
   - no public task IP.
4. Verify VPC Flow Logs and instance metrics.
5. Restore the canary route immediately if any check fails.

### Phase 3: workload route cutover, old infrastructure retained

1. Create a saved plan that changes only control, agent, and source-fetcher
   default routes plus any obsolete public return routes required for correct
   symmetry.
2. Keep both managed NAT Gateways and Network Firewall provisioned for rollback.
3. Reject any plan that destroys old egress resources in this phase.
4. Apply during a development maintenance window.
5. Verify route targets using AWS APIs, not only Terraform output.
6. Run the complete verification matrix.
7. Observe for at least one normal development workflow cycle and an agreed
   soak period.
8. If acceptance fails, execute the pre-reviewed route rollback plan.

### Phase 4: destructive cleanup

Proceed only after the soak period and explicit approval.

1. Capture another remote-state version and current route export.
2. Create a saved plan removing:
   - Network Firewall logging configuration;
   - Network Firewall, policy, and rule group;
   - firewall-specific routes, tables, associations, subnets, and locals;
   - both managed NAT Gateways;
   - both original NAT Elastic IPs after confirming they are no longer used;
   - obsolete firewall alarms and tests.
3. Confirm the plan does not replace the VPC, application subnets, Internet
   Gateway, VPC endpoints, Lambda functions, ECS tasks, databases, S3 buckets,
   KMS keys, queues, or CloudFront/API resources.
4. Apply the exact saved plan.
5. Remove the two old NAT `/32` entries from Supabase only after AWS cleanup and
   a final database-connectivity check.
6. Run the complete verification matrix again.
7. Record actual costs after at least one billing cycle.

## Verification matrix

### Infrastructure

- Terraform formatting, validation, static tests, and saved-plan review pass.
- `terraform plan` is empty after the final apply.
- NAT instance is running with both EC2 status checks passing.
- Source/destination check is disabled only for the NAT instance.
- Root volume is encrypted.
- IMDSv2 is required.
- No SSH key or inbound public security-group rule exists.
- One Elastic IP is attached to the NAT instance.
- Every control, agent, and source-fetcher route table targets the NAT ENI.
- No workload has a public IP.
- No route references a deleted Network Firewall endpoint or NAT Gateway.
- S3 and required interface endpoints remain healthy.
- Flow Logs show expected egress and no unexpected source subnet.

### Public application and authentication

- Public product URL returns the expected security headers.
- CloudFront static assets load.
- API health check succeeds.
- Valid Supabase authentication succeeds.
- Missing, expired, wrong-issuer, and wrong-audience JWTs remain rejected.
- Organisation authorization and tenant isolation tests pass.
- No database connection string or secret appears in logs or responses.

### Database

- API runtime database queries succeed.
- Outbox dispatcher and workflow-control database operations succeed.
- GitHub token broker and reconciler database operations succeed.
- Repository scan-control database operations succeed.
- Vendor-fetcher database operations succeed.
- The migrator Fargate task pulls its image, reaches Supabase, applies no
  unexpected migrations, and exits `0`.
- Supabase records the observed connection source as the new Elastic IP where
  that evidence is available.

### GitHub

- Existing GitHub installation remains active.
- Installation and selected repositories load in the UI.
- Token broker issues a repository-scoped read token without logging it.
- A signed webhook is accepted and reconciled once.
- Invalid signatures remain rejected.
- Duplicate deliveries remain idempotent.
- SQS backlog and DLQ remain empty except for separately accepted historical
  test messages.
- Repository scan downloads the exact commit and records dependency evidence.

### Agent and artifacts

- Agent Fargate image pull succeeds.
- OpenAI workload identity authentication succeeds.
- Stage 1 OrbitChat evidence demo reaches its expected terminal state.
- Model and tool budgets remain enforced.
- Agent cannot use GitHub credentials or a general HTTP tool.
- KMS-encrypted S3 result write and subsequent read succeed.
- No prompt, repository source, token, or evidence body appears in logs.

### Vendor ingestion

- Start a new identifier-only OrbitChat vendor-ingestion execution.
- Fetch all six registered sources.
- Confirm six immutable evidence items.
- Confirm the release becomes `validated` while trust remains `draft`.
- Repeat with a new correlation ID and confirm idempotent success.
- Confirm private/metadata addresses, unsafe redirects, wrong media types,
  oversized responses, and timeouts remain covered by automated tests.

### Failure and recovery

- Stop the canary NAT instance during a controlled window and confirm internet
  access fails closed rather than bypassing through a public IP.
- Start it and confirm forwarding rules restore automatically.
- Reboot it and confirm route target, Elastic IP, `nftables`, forwarding, SSM,
  and workflows recover.
- Simulate CPU or connection pressure within safe bounds and confirm alarms.
- Confirm an operator can replace the instance and re-associate the Elastic IP
  using the documented process.
- Confirm the route-only rollback plan restores old egress during Phase 3.

## Rollback

### Before destructive cleanup

Rollback is a route change:

1. Stop new workflow starts.
2. Apply the reviewed route rollback plan:
   - control subnets back to same-AZ managed NAT Gateways;
   - agent/source-fetcher subnets back to same-AZ firewall endpoints;
   - required public return routes back to firewall endpoints.
3. Verify route propagation and workload connectivity.
4. Keep the new Supabase `/32` temporarily until rollback is confirmed.
5. Investigate without destroying the NAT instance or its logs.

### After destructive cleanup

Rollback requires recreation and is slower:

1. Stop new workflow starts.
2. Deploy the last known-good infrastructure revision that still contains the
   managed NAT and Network Firewall resources.
3. Review the recreation plan carefully; never restore Terraform state without
   reconciling real AWS resources.
4. Apply and wait for firewall endpoints and NAT Gateways to become available.
5. Restore old route topology.
6. Add recreated Elastic IP `/32` values to Supabase before directing database
   traffic through them.
7. Run the complete verification matrix.
8. Remove the NAT-instance `/32` only after rollback acceptance.

Remote-state rollback alone is prohibited: changing state does not recreate or
reroute real infrastructure safely.

## Operations after migration

- Patch the AMI on a defined cadence using blue/green replacement.
- Review Amazon Linux security advisories.
- Test reboot and replacement quarterly.
- Alert on status failure, instance stop/termination, CPU credit depletion,
  abnormal bytes/packets, disk usage, and missing flow logs.
- Keep SSM access auditable and least-privileged.
- Review conntrack and network capacity as repository sizes or concurrency grow.
- Reassess managed NAT or Network Firewall before real customer data,
  production workloads, stronger availability requirements, or higher traffic.
- Compare Cost Explorer totals for EC2, EBS, public IPv4, cross-AZ transfer,
  CloudWatch, Network Firewall, and NAT Gateway before and after the change.

## Explicit non-goals

- Production egress architecture.
- Multi-AZ automatic NAT-instance failover.
- TLS interception or payload inspection.
- A self-managed DNS resolver.
- General outbound internet access for the agent.
- Removing application-level SSRF, authentication, authorization, encryption,
  audit, or validation controls.
