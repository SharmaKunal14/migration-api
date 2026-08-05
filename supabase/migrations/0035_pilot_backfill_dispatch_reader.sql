begin;

create function load_package_release_pilot_backfill_dispatch(
  p_detection_id uuid,
  p_operator_user_id uuid
)
returns table (
  detection_id uuid,
  vendor_release_id uuid,
  source_version text,
  target_version text,
  delivered_at timestamptz,
  workflow_execution_arn text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not is_platform_operator(p_operator_user_id) then
    raise exception using errcode = '42501', message = 'platform operator required';
  end if;
  if p_detection_id is null then
    raise exception using errcode = '22023', message = 'invalid pilot release dispatch';
  end if;

  return query
  select
    detection.id,
    detection.vendor_release_id,
    detection.source_version,
    detection.version,
    outbox.delivered_at,
    outbox.workflow_execution_arn
  from package_release_detections as detection
  inner join release_intelligence_outbox as outbox
    on outbox.aggregate_id = detection.vendor_release_id
  where detection.id = p_detection_id;
end;
$$;

revoke all on function load_package_release_pilot_backfill_dispatch(
  uuid, uuid
) from public, anon, authenticated;
grant execute on function load_package_release_pilot_backfill_dispatch(
  uuid, uuid
) to app_runtime;

commit;
