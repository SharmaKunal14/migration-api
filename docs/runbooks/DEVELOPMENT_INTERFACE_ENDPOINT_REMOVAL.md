# Development interface VPC endpoint removal

## Scope

This procedure removes the seven paid development interface VPC endpoints for
ECR API, ECR Docker, CloudWatch Logs, KMS, Lambda, Secrets Manager, and STS.
AWS deletes the endpoint-owned network interfaces as part of deleting each VPC
endpoint. Do not delete those network interfaces manually.

The S3 gateway endpoint remains attached to the shared application route table.
It has no hourly endpoint charge and is required for private ECR image-layer
downloads.

The change deliberately moves regional AWS API traffic to the existing NAT
instance. It reduces fixed PrivateLink cost, but makes fresh ECS task starts,
Lambda cold starts, log delivery, secret retrieval, STS calls, and Lambda API
calls dependent on that single NAT instance.

## Approved topology

```text
VPC                         vpc-04a96e1ce724988ae
NAT route table             rtb-0d877aa0f73f6ee09
NAT network interface       eni-0dd6f17bc574a317a
NAT public IP               13.55.45.250
S3 gateway endpoint         vpce-0cfc0a5212fa54e53
Application subnets         8
Paid interface endpoints    0
```

Terraform controls the desired endpoint state through
`enable_interface_vpc_endpoints`. Its development default is `false`. The CI
workflow reads the non-secret GitHub environment variable
`ENABLE_INTERFACE_VPC_ENDPOINTS` and also defaults it to `false`.

## 1. Preflight

Run these read-only checks from AWS CloudShell:

```bash
export AWS_REGION="ap-southeast-2"
export VPC_ID="vpc-04a96e1ce724988ae"
export GREEN_RTB="rtb-0d877aa0f73f6ee09"
export NAT_ENI="eni-0dd6f17bc574a317a"
export S3_VPCE="vpce-0cfc0a5212fa54e53"

aws ec2 describe-network-interfaces \
  --network-interface-ids "$NAT_ENI" \
  --region "$AWS_REGION" \
  --query 'NetworkInterfaces[0].{Status:Status,SourceDestCheck:SourceDestCheck,PrivateIp:PrivateIpAddress,PublicIp:Association.PublicIp}' \
  --output table \
  --no-cli-pager

aws ec2 describe-route-tables \
  --route-table-ids "$GREEN_RTB" \
  --region "$AWS_REGION" \
  --query 'RouteTables[0].{Default:Routes[?DestinationCidrBlock==`0.0.0.0/0`]|[0].{ENI:NetworkInterfaceId,State:State},Subnets:Associations[].SubnetId}' \
  --output json \
  --no-cli-pager

aws ec2 describe-vpc-endpoints \
  --vpc-endpoint-ids "$S3_VPCE" \
  --region "$AWS_REGION" \
  --query 'VpcEndpoints[0].{Type:VpcEndpointType,State:State,RouteTables:RouteTableIds}' \
  --output json \
  --no-cli-pager

aws ec2 describe-vpc-endpoints \
  --filters \
    Name=vpc-id,Values="$VPC_ID" \
    Name=vpc-endpoint-type,Values=Interface \
  --region "$AWS_REGION" \
  --query 'sort_by(VpcEndpoints,&ServiceName)[].{Id:VpcEndpointId,Service:ServiceName,State:State,Subnets:SubnetIds}' \
  --output table \
  --no-cli-pager
```

Required result before deployment:

- the NAT ENI is `in-use`, has source/destination checking disabled, and has
  public IP `13.55.45.250`;
- the default route is active and targets the NAT ENI;
- exactly eight application subnets use the route table;
- the S3 endpoint is available and includes the route table;
- the seven interface endpoints are available before removal.

On the NAT instance, verify forwarding and capture a counter baseline:

```bash
sudo systemctl is-enabled migration-nat.service
sudo systemctl is-active migration-nat.service
sudo sysctl net.ipv4.ip_forward
sudo nft list chain inet migration_filter forward
sudo nft list chain ip migration_nat postrouting
```

Do not proceed unless the service is enabled and active, forwarding is `1`,
and the NAT rules cover all application CIDRs.

## 2. Deploy through CI/CD

1. Leave the GitHub development environment variable
   `ENABLE_INTERFACE_VPC_ENDPOINTS` unset or set it to `false`.
2. Commit and push the Terraform and validator changes.
3. Start the normal development deployment workflow.
4. Inspect `deployment-evidence/terraform-plan.txt` before approving the apply.
5. Require exactly these seven resource deletions:
   `aws_vpc_endpoint.interface["ecr.api"]`,
   `aws_vpc_endpoint.interface["ecr.dkr"]`,
   `aws_vpc_endpoint.interface["logs"]`,
   `aws_vpc_endpoint.interface["kms"]`,
   `aws_vpc_endpoint.interface["lambda"]`,
   `aws_vpc_endpoint.interface["secretsmanager"]`, and
   `aws_vpc_endpoint.interface["sts"]`.
6. Reject the plan if it changes the NAT route, any route-table association,
   any application subnet, the S3 gateway endpoint, or an unrelated resource
   unexpectedly.
7. Approve and apply the exact saved plan.

The plan validator enforces zero paid interface endpoints while the toggle is
false, preserves the NAT route and eight application associations, and protects
the S3 gateway endpoint from deletion.

## 3. Verify after deletion

Confirm that no interface endpoint remains and the S3 gateway endpoint still
exists:

```bash
aws ec2 describe-vpc-endpoints \
  --filters \
    Name=vpc-id,Values="$VPC_ID" \
    Name=vpc-endpoint-type,Values=Interface \
  --region "$AWS_REGION" \
  --query 'VpcEndpoints[?State!=`deleted`].{Id:VpcEndpointId,Service:ServiceName,State:State}' \
  --output table \
  --no-cli-pager

aws ec2 describe-vpc-endpoints \
  --vpc-endpoint-ids "$S3_VPCE" \
  --region "$AWS_REGION" \
  --query 'VpcEndpoints[0].{Type:VpcEndpointType,State:State,RouteTables:RouteTableIds}' \
  --output json \
  --no-cli-pager
```

The first command must return no rows. The second must show a gateway endpoint
in `available` state with `rtb-0d877aa0f73f6ee09`.

Run checks that force new outbound connections rather than relying only on
already-running tasks:

1. Run one complete product workflow covering GitHub fetch, OpenAI WIF/STS,
   package registry access, verification, and draft PR publication. The project
   uses on-demand Fargate tasks rather than long-running ECS services, so this
   is the correct fresh image-pull test.
2. Confirm each newly launched task starts successfully. There must be no
   `CannotPullContainerError` or `ResourceInitializationError`. This tests ECR
   API, ECR Docker, S3 image layers, Secrets Manager, and CloudWatch Logs
   through the new path.
3. Invoke the affected Lambda operations and verify their AWS API, secret, and
   database access. A warm invocation is useful but does not prove a future
   cold start, so continue monitoring after deployment.
4. Confirm recent application log streams contain the expected new events.
5. Re-run the route-table preflight and confirm all eight associations remain.

On the NAT instance, compare counters with the baseline:

```bash
sudo nft list chain inet migration_filter forward
sudo nft list chain ip migration_nat postrouting
sudo journalctl -k --since "30 minutes ago" --no-pager | \
  grep -E 'NAT-FWD-DROP|oom|Out of memory|NETDEV WATCHDOG' || true
sudo sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max
free -m
ip -s link show ens5
```

The accepted TCP 443 and masquerade counters must increase during the tests.
There must be no material increase in forwarding drops, no OOM or interface
errors, and ample conntrack and memory headroom.

Finally, run the normal Terraform plan again. It must be empty.

## 4. Rollback

Rollback is appropriate if fresh tasks cannot pull images, Lambda cold starts
cannot retrieve secrets or call AWS APIs, logs stop arriving, or the complete
workflow fails because an AWS regional API cannot be reached.

1. Set the GitHub development environment variable
   `ENABLE_INTERFACE_VPC_ENDPOINTS=true`.
2. Run the same protected deployment workflow.
3. Confirm the plan creates exactly the seven approved interface endpoints and
   does not alter the NAT path or S3 gateway endpoint.
4. Apply the saved plan and repeat the failed verification.
5. Set `ENABLE_INTERFACE_VPC_ENDPOINTS=false` only after the underlying NAT,
   DNS, security-group, or application issue is fixed.

Endpoint recreation can take several minutes. This rollback restores the
private AWS-service path but does not make the single NAT instance highly
available for public GitHub, OpenAI, Supabase, or registry traffic.
