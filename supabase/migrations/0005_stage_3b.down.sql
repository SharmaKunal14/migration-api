begin;

delete from vendor_releases
where id = '914e7575-7dc8-40e4-9445-aa61bfdb4ade';

update vendor_sources
set
  canonical_url = 'https://github.com/SharmaKunal14/orbitchat-sdk/releases/tag/v2.0.0',
  updated_at = now()
where api_product_id = '16dca0bb-dd7d-4251-8e51-3c34816d5014'
  and source_key = 'sdk_release';

drop table if exists vendor_evidence_items;
drop table if exists vendor_ingestion_runs;

commit;
