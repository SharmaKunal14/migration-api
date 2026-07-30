#!/usr/bin/env bash
set -euo pipefail

aws_region="${AWS_REGION:-ap-southeast-2}"
expected_account_id="${AWS_ACCOUNT_ID:-393209814365}"
supabase_project_ref="${SUPABASE_PROJECT_REF:-cvuppaazutekcpkxjrxf}"
output_parent="${1:-deployment-evidence}"
captured_at="$(date -u +%Y%m%dT%H%M%SZ)"
evidence_directory="${output_parent%/}/development-network-baseline-${captured_at}"
report_path="${evidence_directory}/README.md"

export AWS_PAGER=""

require_command() {
  local command_name="$1"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "${command_name}" >&2
    exit 1
  fi
}

append_heading() {
  local heading="$1"

  printf '\n## %s\n\n' "${heading}" >>"${report_path}"
}

append_code_file() {
  local source_path="$1"

  printf '```text\n' >>"${report_path}"
  sed 's/```/` ` `/g' "${source_path}" >>"${report_path}"
  printf '```\n' >>"${report_path}"
}

require_command aws
require_command jq

mkdir -p "${evidence_directory}"

aws sts get-caller-identity --output json >"${evidence_directory}/aws-identity.json"
actual_account_id="$(jq -r '.Account' "${evidence_directory}/aws-identity.json")"
caller_arn="$(jq -r '.Arn' "${evidence_directory}/aws-identity.json")"

if [[ "${actual_account_id}" != "${expected_account_id}" ]]; then
  printf 'Refusing to inspect account %s; expected %s.\n' \
    "${actual_account_id}" \
    "${expected_account_id}" >&2
  exit 1
fi

aws ec2 describe-vpcs \
  --region "${aws_region}" \
  --filters \
  "Name=tag:Application,Values=migration-api" \
  "Name=tag:Environment,Values=development" \
  --output json >"${evidence_directory}/vpcs.json"

vpc_count="$(jq '.Vpcs | length' "${evidence_directory}/vpcs.json")"
if [[ "${vpc_count}" != "1" ]]; then
  printf 'Expected exactly one tagged development VPC, found %s.\n' "${vpc_count}" >&2
  exit 1
fi

vpc_id="$(jq -r '.Vpcs[0].VpcId' "${evidence_directory}/vpcs.json")"
vpc_cidr="$(jq -r '.Vpcs[0].CidrBlock' "${evidence_directory}/vpcs.json")"
vpc_name="$(jq -r '.Vpcs[0] | ([.Tags[]? | select(.Key == "Name").Value][0] // "")' \
  "${evidence_directory}/vpcs.json")"

aws ec2 describe-internet-gateways \
  --region "${aws_region}" \
  --filters "Name=attachment.vpc-id,Values=${vpc_id}" \
  --output json >"${evidence_directory}/internet-gateways.json"

aws ec2 describe-subnets \
  --region "${aws_region}" \
  --filters "Name=vpc-id,Values=${vpc_id}" \
  --output json >"${evidence_directory}/subnets.json"

aws ec2 describe-route-tables \
  --region "${aws_region}" \
  --filters "Name=vpc-id,Values=${vpc_id}" \
  --output json >"${evidence_directory}/route-tables.json"

aws ec2 describe-nat-gateways \
  --region "${aws_region}" \
  --filter "Name=vpc-id,Values=${vpc_id}" \
  --output json >"${evidence_directory}/nat-gateways.json"

aws ec2 describe-vpc-endpoints \
  --region "${aws_region}" \
  --filters "Name=vpc-id,Values=${vpc_id}" \
  --output json >"${evidence_directory}/vpc-endpoints.json"

aws network-firewall list-firewalls \
  --region "${aws_region}" \
  --output json >"${evidence_directory}/network-firewalls.json"

expected_firewall_name="${vpc_name%-vpc}-agent"
firewall_count="$(
  jq -r --arg firewall_name "${expected_firewall_name}" \
    '[.Firewalls[] | select(.FirewallName == $firewall_name)] | length' \
    "${evidence_directory}/network-firewalls.json"
)"

if (( firewall_count > 1 )); then
  printf 'Expected at most one Network Firewall named %s, found %s.\n' \
    "${expected_firewall_name}" \
    "${firewall_count}" >&2
  exit 1
fi

if (( firewall_count == 1 )); then
  firewall_arn="$(
    jq -r --arg firewall_name "${expected_firewall_name}" \
      '.Firewalls[] | select(.FirewallName == $firewall_name) | .FirewallArn' \
      "${evidence_directory}/network-firewalls.json"
  )"

  aws network-firewall describe-firewall \
    --region "${aws_region}" \
    --firewall-arn "${firewall_arn}" \
    --output json >"${evidence_directory}/network-firewall.json"

  described_firewall_vpc_id="$(
    jq -r '.Firewall.VpcId' "${evidence_directory}/network-firewall.json"
  )"
  if [[ "${described_firewall_vpc_id}" != "${vpc_id}" ]]; then
    printf 'Firewall %s belongs to VPC %s, not expected VPC %s.\n' \
      "${expected_firewall_name}" \
      "${described_firewall_vpc_id}" \
      "${vpc_id}" >&2
    exit 1
  fi
fi

aws cloudwatch describe-alarms \
  --region "${aws_region}" \
  --alarm-name-prefix "migration-api-development-" \
  --output json >"${evidence_directory}/cloudwatch-alarms.json"

expected_workload_cidrs="$(
  jq -cn '{
    control: ["10.40.32.0/24", "10.40.33.0/24"],
    agent: ["10.40.48.0/24", "10.40.49.0/24"],
    source_fetcher: ["10.40.64.0/24", "10.40.65.0/24"],
    verifier: ["10.40.80.0/24", "10.40.81.0/24"]
  }'
)"

actual_workload_cidrs="$(
  jq -c '
    def name:
      ([.Tags[]? | select(.Key == "Name").Value][0] // "");
    {
      control: [
        .Subnets[]
        | select((name | test("-control-[12]$")))
        | .CidrBlock
      ] | sort,
      agent: [
        .Subnets[]
        | select((name | test("-agent-[12]$")))
        | .CidrBlock
      ] | sort,
      source_fetcher: [
        .Subnets[]
        | select((name | test("-source-fetcher-[12]$")))
        | .CidrBlock
      ] | sort,
      verifier: [
        .Subnets[]
        | select((name | test("-verifier-[12]$")))
        | .CidrBlock
      ] | sort
    }
  ' "${evidence_directory}/subnets.json"
)"

jq -n \
  --argjson expected "${expected_workload_cidrs}" \
  --argjson actual "${actual_workload_cidrs}" \
  '
    ["control", "agent", "source_fetcher", "verifier"]
    | map({
        workload: .,
        expected: $expected[.],
        actual: $actual[.],
        matches: ($expected[.] == $actual[.])
      })
  ' >"${evidence_directory}/workload-cidr-validation.json"

cidrs_match="$(
  jq -r 'all(.[]; .matches == true)' \
    "${evidence_directory}/workload-cidr-validation.json"
)"

cat >"${report_path}" <<EOF
# Migration API development network baseline

Captured at: \`${captured_at}\`

| Field | Value |
| --- | --- |
| AWS account | \`${actual_account_id}\` |
| Caller | \`${caller_arn}\` |
| Region | \`${aws_region}\` |
| VPC | \`${vpc_id}\` |
| VPC name | \`${vpc_name}\` |
| VPC CIDR | \`${vpc_cidr}\` |
| Workload CIDRs match Terraform expectations | **${cidrs_match}** |
EOF

append_heading "Internet gateway"
{
  printf '| ID | Name |\n'
  printf '| --- | --- |\n'
  jq -r '
    .InternetGateways[]
    | [
        .InternetGatewayId,
        ([.Tags[]? | select(.Key == "Name").Value][0] // "")
      ]
    | "| `\(.[0])` | \(.[1]) |"
  ' "${evidence_directory}/internet-gateways.json"
} >>"${report_path}"

append_heading "Subnets"
{
  printf '| Name | Subnet ID | CIDR | Availability Zone |\n'
  printf '| --- | --- | --- | --- |\n'
  jq -r '
    .Subnets
    | sort_by([.Tags[]? | select(.Key == "Name").Value][0] // "")
    | .[]
    | [
        ([.Tags[]? | select(.Key == "Name").Value][0] // ""),
        .SubnetId,
        .CidrBlock,
        .AvailabilityZone
      ]
    | "| \(.[0]) | `\(.[1])` | `\(.[2])` | `\(.[3])` |"
  ' "${evidence_directory}/subnets.json"
} >>"${report_path}"

append_heading "Workload CIDR validation"
{
  printf '| Workload | Expected | Deployed | Match |\n'
  printf '| --- | --- | --- | --- |\n'
  jq -r '
    .[]
    | [
        .workload,
        (.expected | map("`" + . + "`") | join("<br>")),
        (.actual | map("`" + . + "`") | join("<br>")),
        (if .matches then "Yes" else "**NO**" end)
      ]
    | "| \(.[0]) | \(.[1]) | \(.[2]) | \(.[3]) |"
  ' "${evidence_directory}/workload-cidr-validation.json"
} >>"${report_path}"

append_heading "Route tables and associations"
{
  printf '| Route table | Name | Associated subnet | Main |\n'
  printf '| --- | --- | --- | --- |\n'
  jq -r '
    .RouteTables
    | sort_by(.RouteTableId)
    | .[] as $route_table
    | (
        if ($route_table.Associations | length) == 0
        then [{SubnetId: "", Main: false}]
        else $route_table.Associations
        end
      )[]
    | [
        $route_table.RouteTableId,
        ([$route_table.Tags[]? | select(.Key == "Name").Value][0] // ""),
        (.SubnetId // ""),
        ((.Main // false) | tostring)
      ]
    | "| `\(.[0])` | \(.[1]) | `\(.[2])` | \(.[3]) |"
  ' "${evidence_directory}/route-tables.json"
} >>"${report_path}"

append_heading "Routes"
{
  printf '| Route table | Destination | Target | State |\n'
  printf '| --- | --- | --- | --- |\n'
  jq -r '
    .RouteTables
    | sort_by(.RouteTableId)
    | .[] as $route_table
    | $route_table.Routes[]
    | [
        $route_table.RouteTableId,
        (
          .DestinationCidrBlock
          // .DestinationIpv6CidrBlock
          // .DestinationPrefixListId
          // ""
        ),
        (
          .GatewayId
          // .NatGatewayId
          // .NetworkInterfaceId
          // .VpcPeeringConnectionId
          // .TransitGatewayId
          // .VpcEndpointId
          // .InstanceId
          // ""
        ),
        (.State // "")
      ]
    | "| `\(.[0])` | `\(.[1])` | `\(.[2])` | \(.[3]) |"
  ' "${evidence_directory}/route-tables.json"
} >>"${report_path}"

append_heading "NAT gateways and public addresses"
{
  printf '| NAT gateway | State | Subnet | Allocation ID | Public IP | Private IP |\n'
  printf '| --- | --- | --- | --- | --- | --- |\n'
  jq -r '
    .NatGateways
    | sort_by(.NatGatewayId)
    | .[] as $nat
    | $nat.NatGatewayAddresses[]
    | [
        $nat.NatGatewayId,
        $nat.State,
        $nat.SubnetId,
        (.AllocationId // ""),
        (.PublicIp // ""),
        (.PrivateIp // "")
      ]
    | "| `\(.[0])` | \(.[1]) | `\(.[2])` | `\(.[3])` | `\(.[4])` | `\(.[5])` |"
  ' "${evidence_directory}/nat-gateways.json"
} >>"${report_path}"

append_heading "Network Firewall"
if [[ -f "${evidence_directory}/network-firewall.json" ]]; then
  {
    printf '| Firewall | ARN | Availability Zone | Endpoint ID | Subnet ID |\n'
    printf '| --- | --- | --- | --- | --- |\n'
    jq -r '
      . as $document
      | $document.FirewallStatus.SyncStates
      | to_entries[]
      | [
          $document.Firewall.FirewallName,
          $document.Firewall.FirewallArn,
          .key,
          .value.Attachment.EndpointId,
          .value.Attachment.SubnetId
        ]
      | "| \(.[0]) | `\(.[1])` | `\(.[2])` | `\(.[3])` | `\(.[4])` |"
    ' "${evidence_directory}/network-firewall.json"
  } >>"${report_path}"
else
  printf 'No Network Firewall was found in the VPC.\n' >>"${report_path}"
fi

append_heading "VPC endpoints"
{
  printf '| Endpoint ID | Type | Service | State | Subnets / route tables |\n'
  printf '| --- | --- | --- | --- | --- |\n'
  jq -r '
    .VpcEndpoints
    | sort_by(.ServiceName)
    | .[]
    | [
        .VpcEndpointId,
        .VpcEndpointType,
        .ServiceName,
        .State,
        (
          if .VpcEndpointType == "Gateway"
          then (.RouteTableIds | join("<br>"))
          else (.SubnetIds | join("<br>"))
          end
        )
      ]
    | "| `\(.[0])` | \(.[1]) | \(.[2]) | \(.[3]) | \(.[4]) |"
  ' "${evidence_directory}/vpc-endpoints.json"
} >>"${report_path}"

append_heading "CloudWatch alarms"
{
  printf '| Alarm | State | Namespace | Metric |\n'
  printf '| --- | --- | --- | --- |\n'
  jq -r '
    .MetricAlarms
    | sort_by(.AlarmName)
    | .[]
    | [
        .AlarmName,
        .StateValue,
        .Namespace,
        .MetricName
      ]
    | "| \(.[0]) | **\(.[1])** | \(.[2]) | \(.[3]) |"
  ' "${evidence_directory}/cloudwatch-alarms.json"
} >>"${report_path}"

append_heading "Supabase network restrictions"
if command -v supabase >/dev/null 2>&1; then
  if supabase network-restrictions get \
    --project-ref "${supabase_project_ref}" \
    --experimental \
    >"${evidence_directory}/supabase-network-restrictions.txt" \
    2>"${evidence_directory}/supabase-network-restrictions-error.txt"; then
    append_code_file "${evidence_directory}/supabase-network-restrictions.txt"
  else
    printf '**Unavailable.** Supabase CLI returned an error; authenticate and rerun this command:\n\n' \
      >>"${report_path}"
    printf '```bash\nsupabase network-restrictions get --project-ref %q --experimental\n```\n' \
      "${supabase_project_ref}" >>"${report_path}"
  fi
else
  printf '**Unavailable.** The Supabase CLI is not installed.\n' >>"${report_path}"
fi

append_heading "Latest successful development deployment"
if command -v gh >/dev/null 2>&1; then
  if gh run list \
    --repo "SharmaKunal14/migration-api" \
    --workflow "deploy-development.yml" \
    --status success \
    --limit 1 \
    --json databaseId,headSha,startedAt,updatedAt,url,conclusion \
    >"${evidence_directory}/deployed-git-revision.json" \
    2>"${evidence_directory}/deployed-git-revision-error.txt"; then
    {
      printf '| Git revision | Started | Completed | Workflow |\n'
      printf '| --- | --- | --- | --- |\n'
      jq -r '
        .[0]
        | "| `\(.headSha)` | \(.startedAt) | \(.updatedAt) | [Run \(.databaseId)](\(.url)) |"
      ' "${evidence_directory}/deployed-git-revision.json"
    } >>"${report_path}"
  else
    printf '**Unavailable.** GitHub CLI could not read the deployment workflow.\n' >>"${report_path}"
  fi
else
  printf '**Unavailable.** The GitHub CLI is not installed.\n' >>"${report_path}"
fi

printf '\nRaw AWS responses are stored beside this report.\n' >>"${report_path}"

if [[ "${cidrs_match}" != "true" ]]; then
  printf 'Deployed workload CIDRs do not match the Terraform expectations. See %s.\n' \
    "${report_path}" >&2
  exit 2
fi

printf 'Network baseline captured successfully.\n'
printf 'Report: %s\n' "${report_path}"
