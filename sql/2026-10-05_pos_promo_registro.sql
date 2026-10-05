-- Promo del plan Mostrador + datos obligatorios del registro.
-- Aplicado en producción (proyecto Reparto) el 2026-10-05.
--
-- Promo Mostrador: $20.000/mes los primeros 3 meses (después $40.000), o
-- $240.000 pagando el año por adelantado ($20.000/mes durante 12 meses).
-- En Stripe: precio mensual de $40.000 + cupón "amount_off 20.000 ARS,
-- duration repeating, 3 meses" (stripe_coupon_promo) y un precio anual de
-- $240.000 (stripe_price_id_anual).

ALTER TABLE public.pos_planes
  ADD COLUMN IF NOT EXISTS precio_promo          numeric,
  ADD COLUMN IF NOT EXISTS meses_promo           integer,
  ADD COLUMN IF NOT EXISTS precio_anual          numeric,
  ADD COLUMN IF NOT EXISTS stripe_price_id_anual text,
  ADD COLUMN IF NOT EXISTS stripe_coupon_promo   text,
  ADD COLUMN IF NOT EXISTS promo_texto           text;

ALTER TABLE public.pos_suscripciones
  ADD COLUMN IF NOT EXISTS periodo text CHECK (periodo IN ('mensual','anual'));

UPDATE public.pos_planes SET
  precio_promo = 20000, meses_promo = 3, precio_anual = 240000, precio_primer_mes = NULL,
  promo_texto = '$20.000 por mes los primeros 3 meses'
WHERE id = 'mostrador';

-- Se llama desde la app al entrar: aplica lo que el dueño cargó en el registro
-- (dirección del local y plan elegido, guardados en el metadata del usuario).
-- Idempotente: no pisa datos ya cargados.
CREATE OR REPLACE FUNCTION public.pos_registro_completar(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol  text := public._pos_lealtad_rol(p_organization_id);
  v_meta jsonb;
  v_dir  text;
  v_plan text;
  v_dir_ok boolean := false;
  v_plan_ok boolean := false;
BEGIN
  IF v_rol IS NULL OR v_rol = 'client_pos' THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT COALESCE(raw_user_meta_data, '{}'::jsonb) INTO v_meta FROM auth.users WHERE id = auth.uid();
  v_dir  := NULLIF(btrim(v_meta->>'direccion'), '');
  v_plan := NULLIF(btrim(v_meta->>'plan_elegido'), '');

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

  RETURN jsonb_build_object('ok', true, 'direccion', v_dir_ok, 'plan', v_plan_ok);
END;
$$;

-- Cambiar el plan elegido mientras dura la prueba (sin suscripción paga activa).
CREATE OR REPLACE FUNCTION public.pos_plan_elegir(p_organization_id uuid, p_plan_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol text := public._pos_lealtad_rol(p_organization_id);
  v_sus pos_suscripciones%ROWTYPE;
BEGIN
  IF v_rol IS NULL OR v_rol = 'client_pos' THEN RAISE EXCEPTION 'Solo un administrador puede elegir el plan'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pos_planes WHERE id = p_plan_id AND activo) THEN RAISE EXCEPTION 'Plan inválido'; END IF;
  SELECT * INTO v_sus FROM pos_suscripciones WHERE organization_id = p_organization_id;
  IF v_sus.stripe_subscription_id IS NOT NULL AND v_sus.estado IN ('activa','pago_pendiente') THEN
    RAISE EXCEPTION 'Ya tenés una suscripción paga: cambiá de plan desde “Administrar suscripción”';
  END IF;
  INSERT INTO pos_suscripciones (organization_id, plan_id, estado)
  VALUES (p_organization_id, p_plan_id, COALESCE(v_sus.estado, 'trial'))
  ON CONFLICT (organization_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, updated_at = now();
  RETURN jsonb_build_object('ok', true, 'plan_id', p_plan_id);
END;
$$;

-- Plan actual: ahora distingue el plan elegido durante la prueba e informa la promo.
CREATE OR REPLACE FUNCTION public.pos_plan_actual(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol text := public._pos_lealtad_rol(p_organization_id);
  v_org record;
  v_sus pos_suscripciones%ROWTYPE;
  v_plan pos_planes%ROWTYPE;
  v_estado text;
  v_dias int;
BEGIN
  IF v_rol IS NULL THEN RAISE EXCEPTION 'sin permisos'; END IF;
  SELECT plan, trial_started_at, trial_ends_at INTO v_org FROM organizations WHERE id = p_organization_id;
  SELECT * INTO v_sus FROM pos_suscripciones WHERE organization_id = p_organization_id;
  IF v_sus.plan_id IS NOT NULL THEN
    SELECT * INTO v_plan FROM pos_planes WHERE id = v_sus.plan_id;
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
    'periodo',              v_sus.periodo,
    'precio_mensual',       v_plan.precio_mensual,
    'precio_promo',         v_plan.precio_promo,
    'meses_promo',          v_plan.meses_promo,
    'precio_anual',         v_plan.precio_anual,
    'trial_ends_at',        v_org.trial_ends_at,
    'dias_restantes',       v_dias,
    'current_period_end',   v_sus.current_period_end,
    'cancel_at_period_end', COALESCE(v_sus.cancel_at_period_end, false),
    'tiene_cliente_stripe', v_sus.stripe_customer_id IS NOT NULL,
    'stripe_habilitado',    EXISTS (SELECT 1 FROM pos_planes WHERE activo AND stripe_price_id IS NOT NULL),
    'puede_gestionar',      v_rol <> 'client_pos'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pos_registro_completar(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pos_plan_elegir(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_registro_completar(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pos_plan_elegir(uuid, text) TO authenticated;
