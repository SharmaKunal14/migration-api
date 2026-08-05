begin;

create function request_current_package_release_pilot_backfill(
  p_mapping_id uuid,
  p_operator_user_id uuid,
  p_expected_mapping_version integer,
  p_request_id uuid
)
returns table (
  detection_id uuid,
  vendor_release_id uuid,
  source_version text,
  target_version text,
  created boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_mapping package_source_mappings%rowtype;
  current_source vendor_sources%rowtype;
  current_poll package_source_poll_runs%rowtype;
  current_detection package_release_detections%rowtype;
  observed_versions text[];
  backfill_now timestamptz := clock_timestamp();
  was_created boolean := false;
begin
  if not is_platform_operator(p_operator_user_id) then
    raise exception using errcode = '42501', message = 'platform operator required';
  end if;
  if p_mapping_id is null or p_request_id is null
    or p_expected_mapping_version is null or p_expected_mapping_version < 1
  then
    raise exception using errcode = '22023', message = 'invalid pilot release backfill';
  end if;

  select mapping.* into current_mapping
  from package_source_mappings as mapping
  inner join package_source_mapping_controls as control
    on control.mapping_id = mapping.id
  inner join api_products as product on product.id = mapping.api_product_id
  inner join vendors as vendor on vendor.id = product.vendor_id
  where mapping.id = p_mapping_id
    and mapping.status = 'mapped'
    and mapping.version = p_expected_mapping_version
    and mapping.latest_version is not null
    and mapping.latest_deprecated = false
    and not control.disabled
    and product.ecosystem = 'npm'
    and product.status = 'active'
    and vendor.trust_state = 'trusted'
  for update of mapping;
  if not found then
    raise exception using errcode = '40001', message = 'pilot release mapping is unavailable';
  end if;

  select source.* into current_source
  from vendor_sources as source
  where source.api_product_id = current_mapping.api_product_id
    and source.source_kind = 'package_registry_release'
    and source.canonical_domain = 'registry.npmjs.org'
    and source.trust_state = 'trusted'
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'trusted registry source is unavailable';
  end if;

  with latest_snapshots as (
    select distinct on (snapshot.repository_id)
      snapshot.id,
      snapshot.repository_id
    from repository_snapshots as snapshot
    inner join repositories as repository on repository.id = snapshot.repository_id
    inner join github_installations as installation
      on installation.id = repository.installation_id
    where snapshot.status = 'available'
      and snapshot.expires_at > backfill_now
      and repository.selected
      and repository.enabled
      and not repository.archived
      and installation.status = 'active'
    order by snapshot.repository_id, snapshot.updated_at desc, snapshot.id desc
  )
  select array_agg(distinct observation.resolved_version order by observation.resolved_version)
  into observed_versions
  from dependency_observations as observation
  inner join latest_snapshots as latest
    on latest.id = observation.repository_snapshot_id
  where observation.package_name = current_mapping.package_name
    and observation.dependency_kind = 'dependency'
    and observation.resolved_version is not null;

  if coalesce(cardinality(observed_versions), 0) = 0 then
    raise exception using errcode = 'P0002', message = 'pilot dependency version not found';
  end if;
  if cardinality(observed_versions) <> 1 then
    raise exception using errcode = '23514', message = 'pilot dependency versions are ambiguous';
  end if;
  if observed_versions[1] = current_mapping.latest_version then
    raise exception using errcode = '23514', message = 'pilot dependency is already current';
  end if;

  select run.* into current_poll
  from package_source_poll_runs as run
  where run.source_id = current_source.id
    and run.status = 'succeeded'
    and run.outcome in ('baseline', 'unchanged', 'release_detected')
    and run.observed_version = current_mapping.latest_version
    and run.latest_deprecated = false
    and run.evidence_object_key is not null
    and run.evidence_digest is not null
    and run.metadata_digest is not null
  order by run.completed_at desc, run.id desc
  limit 1;
  if not found then
    raise exception using errcode = 'P0002', message = 'current release poll evidence not found';
  end if;

  select detection.* into current_detection
  from package_release_detections as detection
  where detection.api_product_id = current_mapping.api_product_id
    and detection.version = current_mapping.latest_version
  for update;

  if found then
    if current_detection.source_version is distinct from observed_versions[1]
      or current_detection.vendor_release_id is null
      or current_detection.status <> 'detected'
    then
      raise exception using errcode = '23514', message = 'current release already has different ingestion authority';
    end if;
  else
    insert into package_release_detections (
      api_product_id, source_id, version, source_version, published_at,
      first_detected_at, last_observed_at, latest_deprecated,
      evidence_object_key, evidence_digest, metadata_digest, status
    ) values (
      current_mapping.api_product_id, current_source.id,
      current_mapping.latest_version, observed_versions[1],
      current_poll.observed_published_at, backfill_now, backfill_now, false,
      current_poll.evidence_object_key, current_poll.evidence_digest,
      current_poll.metadata_digest, 'detected'
    )
    returning * into current_detection;
    was_created := true;
  end if;

  insert into platform_audit_events (
    actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at
  ) values (
    p_operator_user_id,
    'package_release.pilot_backfill_requested',
    'package_release_detection',
    current_detection.id,
    p_request_id,
    jsonb_build_object(
      'mapping_id', current_mapping.id,
      'api_product_id', current_mapping.api_product_id,
      'source_id', current_source.id,
      'source_version', observed_versions[1],
      'target_version', current_mapping.latest_version,
      'evidence_digest', current_poll.evidence_digest,
      'created', was_created
    ),
    backfill_now
  );

  detection_id := current_detection.id;
  vendor_release_id := current_detection.vendor_release_id;
  source_version := observed_versions[1];
  target_version := current_mapping.latest_version;
  created := was_created;
  return next;
end;
$$;

revoke all on function request_current_package_release_pilot_backfill(
  uuid, uuid, integer, uuid
) from public, anon, authenticated;
grant execute on function request_current_package_release_pilot_backfill(
  uuid, uuid, integer, uuid
) to app_runtime;

commit;
