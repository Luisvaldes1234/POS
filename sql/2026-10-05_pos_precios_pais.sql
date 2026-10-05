-- Precios de los planes por país y moneda.
-- Aplicado en producción (proyecto Reparto) el 2026-10-05.
--
-- pos_planes queda con lo común a todos los países (nombre, descripción,
-- features, orden). Los montos y los ids de Stripe van por país en
-- pos_planes_precios. País 'OT' = cualquier otro país (en USD).
--
-- Los montos fuera de Argentina son equivalentes aproximados redondeados:
-- revisarlos y ajustarlos acá directamente (la landing, el registro y la app
-- los leen de esta tabla).

CREATE TABLE IF NOT EXISTS public.pos_planes_precios (
  plan_id               text NOT NULL REFERENCES public.pos_planes(id) ON DELETE CASCADE,
  pais                  text NOT NULL CHECK (pais IN ('AR','MX','CL','CO','PE','UY','OT')),
  moneda                text NOT NULL,
  precio_mensual        numeric NOT NULL,
  precio_primer_mes     numeric,
  precio_promo          numeric,
  meses_promo           integer,
  precio_anual          numeric,
  precio_tienda_extra   numeric,
  stripe_price_id       text,
  stripe_price_id_anual text,
  stripe_coupon_promo   text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, pais)
);

ALTER TABLE public.pos_planes_precios ENABLE ROW LEVEL SECURITY;
CREATE POLICY pos_planes_precios_select ON public.pos_planes_precios FOR SELECT USING (true);
GRANT SELECT ON public.pos_planes_precios TO anon, authenticated;

INSERT INTO public.pos_planes_precios
  (plan_id, pais, moneda, precio_mensual, precio_primer_mes, precio_promo, meses_promo, precio_anual, precio_tienda_extra) VALUES
  -- Argentina (los precios de siempre)
  ('mostrador','AR','ARS', 40000, NULL, 20000, 3, 240000, NULL),
  ('negocio',  'AR','ARS', 60000, 30000, NULL, NULL, NULL, NULL),
  ('cadena',   'AR','ARS', 90000, 45000, NULL, NULL, NULL, 24900),
  -- México
  ('mostrador','MX','MXN',   499, NULL,   249, 3,   2988, NULL),
  ('negocio',  'MX','MXN',   799,  399, NULL, NULL, NULL, NULL),
  ('cadena',   'MX','MXN',  1199,  599, NULL, NULL, NULL, 349),
  -- Chile
  ('mostrador','CL','CLP', 26990, NULL, 13490, 3, 161880, NULL),
  ('negocio',  'CL','CLP', 39990, 19990, NULL, NULL, NULL, NULL),
  ('cadena',   'CL','CLP', 59990, 29990, NULL, NULL, NULL, 16990),
  -- Colombia
  ('mostrador','CO','COP', 119900, NULL, 59900, 3, 718800, NULL),
  ('negocio',  'CO','COP', 179900, 89900, NULL, NULL, NULL, NULL),
  ('cadena',   'CO','COP', 259900, 129900, NULL, NULL, NULL, 69900),
  -- Perú
  ('mostrador','PE','PEN',   109, NULL,    55, 3,    660, NULL),
  ('negocio',  'PE','PEN',   159,   79, NULL, NULL, NULL, NULL),
  ('cadena',   'PE','PEN',   239,  119, NULL, NULL, NULL, 69),
  -- Uruguay
  ('mostrador','UY','UYU',  1190, NULL,   590, 3,   7080, NULL),
  ('negocio',  'UY','UYU',  1790,  890, NULL, NULL, NULL, NULL),
  ('cadena',   'UY','UYU',  2590, 1290, NULL, NULL, NULL, 690),
  -- Otro país (USD)
  ('mostrador','OT','USD',    29, NULL,    15, 3,    180, NULL),
  ('negocio',  'OT','USD',    45,   22, NULL, NULL, NULL, NULL),
  ('cadena',   'OT','USD',    65,   32, NULL, NULL, NULL, 18)
ON CONFLICT (plan_id, pais) DO NOTHING;

-- País de precios de una organización ('OT' si no es uno de los soportados).
CREATE OR REPLACE FUNCTION public._pos_pais_precios(p_pais text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN upper(p_pais) IN ('AR','MX','CL','CO','PE','UY') THEN upper(p_pais) ELSE 'OT' END;
$$;

-- Plan actual con los precios del país de la organización.
CREATE OR REPLACE FUNCTION public.pos_plan_actual(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol text := public._pos_lealtad_rol(p_organization_id);
  v_org record;
  v_sus pos_suscripciones%ROWTYPE;
  v_plan pos_planes%ROWTYPE;
  v_pr pos_planes_precios%ROWTYPE;
  v_pais text;
  v_estado text;
  v_dias int;
BEGIN
  IF v_rol IS NULL THEN RAISE EXCEPTION 'sin permisos'; END IF;
  SELECT plan, pais, moneda, trial_started_at, trial_ends_at INTO v_org FROM organizations WHERE id = p_organization_id;
  v_pais := public._pos_pais_precios(v_org.pais);
  SELECT * INTO v_sus FROM pos_suscripciones WHERE organization_id = p_organization_id;
  IF v_sus.plan_id IS NOT NULL THEN
    SELECT * INTO v_plan FROM pos_planes WHERE id = v_sus.plan_id;
    SELECT * INTO v_pr FROM pos_planes_precios WHERE plan_id = v_sus.plan_id AND pais = v_pais;
  END IF;

  IF v_sus.estado IS NULL OR v_sus.estado = 'trial' THEN
    v_estado := CASE WHEN v_org.plan = 'trial' THEN
                  CASE WHEN v_org.trial_ends_at IS NOT NULL AND v_org.trial_ends_at <= now() THEN 'vencida' ELSE 'trial' END
                ELSE 'activa' END;
  ELSE
    v_estado := v_sus.estado;
  END IF;
  IF v_estado = 'trial' AND v_org.trial_ends_at IS NOT NULL THEN
    v_dias := GREATEST(0, ceil(EXTRACT(EPOCH FROM (v_org.trial_ends_at - now())) / 86400)::int);
  END IF;

  RETURN jsonb_build_object(
    'estado',               v_estado,
    'plan_id',              v_sus.plan_id,
    'plan_nombre',          COALESCE(v_plan.nombre,
                              CASE WHEN v_org.plan = 'trial' THEN 'Prueba gratis' ELSE initcap(COALESCE(v_org.plan, 'Sin plan')) END),
    'plan_legacy',          v_org.plan,
    'pais_precios',         v_pais,
    'moneda',               COALESCE(v_pr.moneda, (SELECT moneda FROM pos_planes_precios WHERE pais = v_pais LIMIT 1)),
    'periodo',              v_sus.periodo,
    'precio_mensual',       v_pr.precio_mensual,
    'precio_promo',         v_pr.precio_promo,
    'meses_promo',          v_pr.meses_promo,
    'precio_anual',         v_pr.precio_anual,
    'trial_ends_at',        v_org.trial_ends_at,
    'dias_restantes',       v_dias,
    'current_period_end',   v_sus.current_period_end,
    'cancel_at_period_end', COALESCE(v_sus.cancel_at_period_end, false),
    'tiene_cliente_stripe', v_sus.stripe_customer_id IS NOT NULL,
    'stripe_habilitado',    EXISTS (SELECT 1 FROM pos_planes_precios pp JOIN pos_planes p ON p.id = pp.plan_id
                                    WHERE p.activo AND pp.pais = v_pais AND pp.stripe_price_id IS NOT NULL),
    'puede_gestionar',      v_rol <> 'client_pos'
  );
END;
$$;

-- Registro: además de dirección y plan, si el país es "Otro" toma la zona
-- horaria del navegador del dueño (metadata.timezone) para que los cierres y
-- reportes usen su hora local.
CREATE OR REPLACE FUNCTION public.pos_registro_completar(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol  text := public._pos_lealtad_rol(p_organization_id);
  v_meta jsonb;
  v_dir  text;
  v_plan text;
  v_tz   text;
  v_dir_ok boolean := false;
  v_plan_ok boolean := false;
  v_tz_ok boolean := false;
BEGIN
  IF v_rol IS NULL OR v_rol = 'client_pos' THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT COALESCE(raw_user_meta_data, '{}'::jsonb) INTO v_meta FROM auth.users WHERE id = auth.uid();
  v_dir  := NULLIF(btrim(v_meta->>'direccion'), '');
  v_plan := NULLIF(btrim(v_meta->>'plan_elegido'), '');
  v_tz   := NULLIF(btrim(v_meta->>'timezone'), '');

  IF v_dir IS NOT NULL THEN
    UPDATE org_config SET direccion = v_dir
    WHERE organization_id = p_organization_id AND COALESCE(btrim(direccion), '') = '';
    UPDATE tiendas SET direccion = v_dir
    WHERE organization_id = p_organization_id AND COALESCE(btrim(direccion), '') = '';
    v_dir_ok := true;
  END IF;

  IF v_plan IS NOT NULL AND EXISTS (SELECT 1 FROM pos_planes WHERE id = v_plan AND activo) THEN
    INSERT INTO pos_suscripciones (organization_id, plan_id, estado)
    VALUES (p_organization_id, v_plan, 'trial')
    ON CONFLICT (organization_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, updated_at = now()
      WHERE pos_suscripciones.plan_id IS NULL;
    v_plan_ok := true;
  END IF;

  IF v_tz IS NOT NULL AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz)
     AND EXISTS (SELECT 1 FROM organizations WHERE id = p_organization_id AND (pais IS NULL OR pais NOT IN ('AR','MX','CL','CO','PE','UY')) AND timezone = 'UTC') THEN
    UPDATE organizations SET timezone = v_tz WHERE id = p_organization_id;
    UPDATE org_config SET timezone = v_tz WHERE organization_id = p_organization_id;
    v_tz_ok := true;
  END IF;

  RETURN jsonb_build_object('ok', true, 'direccion', v_dir_ok, 'plan', v_plan_ok, 'timezone', v_tz_ok);
END;
$$;

GRANT EXECUTE ON FUNCTION public._pos_pais_precios(text) TO anon, authenticated;
