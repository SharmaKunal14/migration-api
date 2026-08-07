begin;

create or replace function requeue_current_package_release_pilot_backfill(
  p_detection_id uuid,
  p_operator_user_id uuid,
  p_expected_workflow_execution_arn text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_detection package_release_detections%rowtype;
  current_release vendor_releases%rowtype;
  current_outbox release_intelligence_outbox%rowtype;
  retry_correlation_id uuid := gen_random_uuid();
  retry_now timestamptz := clock_timestamp();
begin
  if not is_platform_operator(p_operator_user_id) then
    raise exception using errcode = '42501', message = 'platform operator required';
  end if;
  if p_detection_id is null or p_request_id is null
    or p_expected_workflow_execution_arn is null
    or length(p_expected_workflow_execution_arn) not between 20 and 2048
  then
    raise exception using errcode = '22023', message = 'invalid pilot release retry';
  end if;

  select detection.* into current_detection
  from package_release_detections as detection
  where detection.id = p_detection_id
    and detection.status = 'detected'
    and detection.vendor_release_id is not null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'pilot release detection not found';
  end if;

  select release.* into current_release
  from vendor_releases as release
  where release.id = current_detection.vendor_release_id
    and release.processing_state in ('registered', 'fetched')
    and release.trust_state = 'draft'
  for update;
  if not found or exists (
    select 1
    from migration_specifications as specification
    where specification.vendor_release_id = current_detection.vendor_release_id
  ) then
    raise exception using errcode = '23514', message = 'pilot release retry is no longer eligible';
  end if;

  select outbox.* into current_outbox
  from release_intelligence_outbox as outbox
  where outbox.aggregate_id = current_detection.vendor_release_id
  for update;
  if not found
    or current_outbox.delivered_at is null
    or current_outbox.lease_owner is not null
    or current_outbox.workflow_execution_arn is distinct from
      p_expected_workflow_execution_arn
  then
    raise exception using errcode = '40001', message = 'pilot release retry state changed';
  end if;

  update release_intelligence_outbox
  set payload = jsonb_build_object(
        'schemaVersion', '1.0',
        'vendorReleaseId', current_detection.vendor_release_id,
        'correlationId', retry_correlation_id
      ),
      available_at = retry_now,
      lease_owner = null,
      lease_expires_at = null,
      attempts = 0,
      delivered_at = null,
      workflow_execution_arn = null,
      safe_error_code = null
  where id = current_outbox.id;

  insert into platform_audit_events (
    actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at
  ) values (
    p_operator_user_id,
    'package_release.pilot_backfill_requeued',
    'package_release_detection',
    current_detection.id,
    p_request_id,
    jsonb_build_object(
      'vendor_release_id', current_detection.vendor_release_id,
      'previous_workflow_execution_arn', p_expected_workflow_execution_arn,
      'correlation_id', retry_correlation_id
    ),
    retry_now
  );

  return retry_correlation_id;
end;
$$;

revoke all on function requeue_current_package_release_pilot_backfill(
  uuid, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function requeue_current_package_release_pilot_backfill(
  uuid, uuid, text, uuid
) to app_runtime;

commit;
