-- Price detail responses are wrapped in results[0] and use minor currency units.
-- Recover successfully fetched prices without calling the Magalu API again.
with decoded as (
  select id,
    case
      when jsonb_typeof(payload #> '{results,0,price}') = 'number'
        and jsonb_typeof(payload #> '{results,0,normalizer}') = 'number'
        and (payload #>> '{results,0,price}')::numeric between 0 and 99999999
        and (payload #>> '{results,0,normalizer}')::numeric > 0
      then (payload #>> '{results,0,price}')::numeric
        / nullif((payload #>> '{results,0,normalizer}')::numeric, 0)
    end as current_price,
    case
      when jsonb_typeof(payload #> '{results,0,list_price}') = 'number'
        and jsonb_typeof(payload #> '{results,0,normalizer}') = 'number'
        and (payload #>> '{results,0,list_price}')::numeric between 0 and 99999999
        and (payload #>> '{results,0,normalizer}')::numeric > 0
      then (payload #>> '{results,0,list_price}')::numeric
        / nullif((payload #>> '{results,0,normalizer}')::numeric, 0)
    end as current_list_price
  from magalu.prices
  where price is null and is_present = true and last_http_status = 200
)
update magalu.prices p
set price = d.current_price,
    list_price = d.current_list_price,
    updated_at = now()
from decoded d
where p.id = d.id and d.current_price is not null;
