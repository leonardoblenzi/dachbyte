update volt_core.company_configurations
set settings = jsonb_set(
      coalesce(settings, '{}'::jsonb),
      '{onboarding}',
      coalesce(settings->'onboarding', '{}'::jsonb) || jsonb_build_object(
        'sectorConfirmed', true,
        'sectorConfirmedAt', coalesce(updated_at, now()),
        'sectorSource', 'existing_configuration'
      ),
      true
    )
where coalesce(settings->'onboarding'->>'sectorConfirmed', '') = '';

