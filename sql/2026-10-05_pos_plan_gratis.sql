-- Plan Gratis (freemium) para todos los países menos Argentina.
-- Aplicado en producción (proyecto Reparto) el 2026-10-05.
--
-- - pos_planes.limites: límites que la app y la base aplican. NULL = sin límites.
-- - Gratis: precio 0 en MX/CL/CO/PE/UY/OT (no existe en AR).
-- - Una organización en Gratis tiene organizations.plan = 'free' (ya admitido
--   por el CHECK y por el bloqueo de prueba vencida, que solo mira 'trial').
-- - Fuera de Argentina, cuando vence la prueba (o se cancela la suscripción)
--   la organización pasa a Gratis en vez de quedar bloqueada.

ALTER TABLE public.pos_planes ADD COLUMN IF NOT EXISTS limites jsonb;

INSERT INTO public.pos_planes (id, nombre, descripcion, precio_mensual, features, orden, limites) VALUES
  ('gratis', 'Gratis', 'Para empezar a vender sin pagar nada', 0,
   '["Ventas y productos ilimitados","Scanner y generador de códigos de barras","Caja con cortes y vuelto automático","Stock con alertas","Programa de puntos para tus clientes","Cuenta corriente (fiado)","Ticket por WhatsApp","Funciona sin internet","Sin comisiones por venta","2 usuarios · 1 tienda · 90 días de historial"]'::jsonb,
   0, '{"usuarios":2,"tiendas":1,"historial_dias":90,"promos":false,"reservas":false,"finanzas":false}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.pos_planes_precios (plan_id, pais, moneda, precio_mensual) VALUES
  ('gratis','MX','MXN',0), ('gratis','CL','CLP',0), ('gratis','CO','COP',0),
  ('gratis','PE','PEN',0), ('gratis','UY','UYU',0), ('gratis','OT','USD',0)
ON CONFLICT (plan_id, pais) DO NOTHING;

-- Pasa la organización a Gratis (solo fuera de Argentina).
CREATE OR REPLACE FUNCTION public._pos_pasar_a_gratis(p_org uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE organizations SET plan = 'free' WHERE id = p_org;
  INSERT INTO pos_suscripciones (organization_id, plan_id, estado, updated_at)
  VALUES (p_org, 'gratis', 'activa', now())
  ON CONFLICT (organization_id) DO UPDATE SET plan_id = 'gratis', estado = 'activa',
    stripe_subscription_id = NULL, stripe_price_id = NULL, periodo = NULL,
    current_period_end = NULL, cancel_at_period_end = false, updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public._pos_pasar_a_gratis(uuid) FROM PUBLIC, anon, authenticated;

-- Se llama desde la app al entrar: si la prueba venció y el negocio no es de
-- Argentina ni tiene suscripción paga, pasa a Gratis en vez de bloquearse.
CREATE OR REPLACE FUNCTION public.pos_plan_vencido_a_gratis(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol text := public._pos_lealtad_rol(p_organization_id);
  v_org record;
  v_sus pos_suscripciones%ROWTYPE;
BEGIN
  IF v_rol IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT plan, pais, trial_ends_at INTO v_org FROM organizations WHERE id = p_organization_id;
  IF public._pos_pais_precios(v_org.pais) = 'AR' OR v_org.plan <> 'trial'
     OR v_org.trial_ends_at IS NULL OR v_org.trial_ends_at > now() THEN
    RETURN jsonb_build_object('ok', true, 'cambio', false);
  END IF;
  SELECT * INTO v_sus FROM pos_suscripciones WHERE organization_id = p_organization_id;
  IF v_sus.stripe_subscription_id IS NOT NULL AND v_sus.estado IN ('activa','pago_pendiente') THEN
    RETURN jsonb_build_object('ok', true, 'cambio', false);
  END IF;
  PERFORM public._pos_pasar_a_gratis(p_organization_id);
  RETURN jsonb_build_object('ok', true, 'cambio', true);
END;
$$;

-- Elegir plan: Gratis solo fuera de Argentina; desde Gratis a un plan pago
-- solo se pasa pagando (no hay una segunda prueba gratis).
CREATE OR REPLACE FUNCTION public.pos_plan_elegir(p_organization_id uuid, p_plan_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol text := public._pos_lealtad_rol(p_organization_id);
  v_sus pos_suscripciones%ROWTYPE;
  v_org record;
BEGIN
  IF v_rol IS NULL OR v_rol = 'client_pos' THEN RAISE EXCEPTION 'Solo un administrador puede elegir el plan'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pos_planes WHERE id = p_plan_id AND activo) THEN RAISE EXCEPTION 'Plan inválido'; END IF;
  SELECT plan, pais INTO v_org FROM organizations WHERE id = p_organization_id;
  SELECT * INTO v_sus FROM pos_suscripciones WHERE organization_id = p_organization_id;
  IF v_sus.stripe_subscription_id IS NOT NULL AND v_sus.estado IN ('activa','pago_pendiente') THEN
    RAISE EXCEPTION 'Ya tenés una suscripción paga: cambiá de plan desde “Administrar suscripción”';
  END IF;

  IF p_plan_id = 'gratis' THEN
    IF public._pos_pais_precios(v_org.pais) = 'AR' THEN RAISE EXCEPTION 'El plan Gratis no está disponible en Argentina'; END IF;
    PERFORM public._pos_pasar_a_gratis(p_organization_id);
    RETURN jsonb_build_object('ok', true, 'plan_id', 'gratis');
  END IF;

  IF v_org.plan <> 'trial' THEN
    RAISE EXCEPTION 'Para pasar a este plan tenés que suscribirte con el pago online';
  END IF;
  INSERT INTO pos_suscripciones (organization_id, plan_id, estado)
  VALUES (p_organization_id, p_plan_id, COALESCE(NULLIF(v_sus.estado, 'activa'), 'trial'))
  ON CONFLICT (organization_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, updated_at = now();
  RETURN jsonb_build_object('ok', true, 'plan_id', p_plan_id);
END;
$$;

-- Registro: si eligió Gratis (fuera de Argentina) arranca directo en Gratis.
CREATE OR REPLACE FUNCTION public.pos_registro_completar(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol  text := public._pos_lealtad_rol(p_organization_id);
  v_meta jsonb;
  v_dir  text;
  v_plan text;
  v_tz   text;
  v_pais text;
  v_dir_ok boolean := false;
  v_plan_ok boolean := false;
  v_tz_ok boolean := false;
BEGIN
  IF v_rol IS NULL OR v_rol = 'client_pos' THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT COALESCE(raw_user_meta_data, '{}'::jsonb) INTO v_meta FROM auth.users WHERE id = auth.uid();
  SELECT public._pos_pais_precios(pais) INTO v_pais FROM organizations WHERE id = p_organization_id;
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

  IF v_plan = 'gratis' THEN
    IF v_pais <> 'AR' AND NOT EXISTS (SELECT 1 FROM pos_suscripciones WHERE organization_id = p_organization_id AND plan_id IS NOT NULL) THEN
      PERFORM public._pos_pasar_a_gratis(p_organization_id);
      v_plan_ok := true;
    END IF;
  ELSIF v_plan IS NOT NULL AND EXISTS (SELECT 1 FROM pos_planes WHERE id = v_plan AND activo) THEN
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

-- Plan actual: agrega los límites del plan.
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
  ELSIF v_org.plan = 'free' THEN
    SELECT * INTO v_plan FROM pos_planes WHERE id = 'gratis';
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
    'plan_id',              COALESCE(v_sus.plan_id, CASE WHEN v_org.plan = 'free' THEN 'gratis' END),
    'plan_nombre',          COALESCE(v_plan.nombre,
                              CASE WHEN v_org.plan = 'trial' THEN 'Prueba gratis' ELSE initcap(COALESCE(v_org.plan, 'Sin plan')) END),
    'plan_legacy',          v_org.plan,
    'es_gratis',            v_org.plan = 'free',
    'limites',              CASE WHEN v_org.plan = 'free' THEN COALESCE(v_plan.limites, (SELECT limites FROM pos_planes WHERE id = 'gratis')) END,
    'gratis_disponible',    v_pais <> 'AR',
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

-- Límites de Gratis aplicados en la base (no dependen de la app).
CREATE OR REPLACE FUNCTION public.fn_pos_limite_gratis()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_org record;
  v_lim jsonb;
  v_max int;
  v_n int;
BEGIN
  SELECT plan, product INTO v_org FROM organizations WHERE id = NEW.organization_id;
  IF v_org.product IS DISTINCT FROM 'pos' OR v_org.plan IS DISTINCT FROM 'free' THEN RETURN NEW; END IF;
  SELECT limites INTO v_lim FROM pos_planes WHERE id = 'gratis';
  IF TG_TABLE_NAME = 'tiendas' THEN
    v_max := COALESCE((v_lim->>'tiendas')::int, 1);
    SELECT count(*) INTO v_n FROM tiendas WHERE organization_id = NEW.organization_id AND activo;
    IF COALESCE(NEW.activo, true) AND v_n >= v_max THEN
      RAISE EXCEPTION 'El plan Gratis incluye % tienda. Pasate a un plan pago para sumar sucursales.', v_max;
    END IF;
  ELSIF TG_TABLE_NAME = 'user_roles' THEN
    v_max := COALESCE((v_lim->>'usuarios')::int, 2);
    SELECT count(*) INTO v_n FROM user_roles WHERE organization_id = NEW.organization_id AND activo;
    IF COALESCE(NEW.activo, true) AND v_n >= v_max THEN
      RAISE EXCEPTION 'El plan Gratis incluye % usuarios. Pasate a un plan pago para sumar más.', v_max;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pos_limite_gratis_tiendas
  BEFORE INSERT ON public.tiendas FOR EACH ROW EXECUTE FUNCTION public.fn_pos_limite_gratis();
CREATE TRIGGER trg_pos_limite_gratis_usuarios
  BEFORE INSERT ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.fn_pos_limite_gratis();

REVOKE ALL ON FUNCTION public.pos_plan_vencido_a_gratis(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_plan_vencido_a_gratis(uuid) TO authenticated;
