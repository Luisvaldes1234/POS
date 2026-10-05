-- Bases para cobrar la suscripción del POS Mostrador con Stripe.
-- Aplicado en producción (proyecto Reparto) el 2026-10-05. Solo objetos nuevos:
-- no toca saas_planes/saas_licencias (son de Reparto).
--
-- Flujo previsto (edge functions en supabase/functions/):
--   1. pos-billing-checkout  → crea la sesión de Stripe Checkout del plan elegido.
--   2. pos-billing-webhook   → Stripe avisa pagos/cambios y se actualiza
--                              pos_suscripciones + organizations.plan.
--   3. pos-billing-portal    → portal de Stripe para cambiar tarjeta / cancelar.
-- Mientras los planes no tengan stripe_price_id, la app muestra el plan actual
-- y los planes, pero sin botón de pago.

CREATE TABLE IF NOT EXISTS public.pos_planes (
  id                           text PRIMARY KEY,           -- 'mostrador' | 'negocio' | 'cadena'
  nombre                       text NOT NULL,
  descripcion                  text,
  precio_mensual               numeric NOT NULL,
  precio_primer_mes            numeric,
  moneda                       text NOT NULL DEFAULT 'ARS',
  max_usuarios                 integer,                    -- NULL = ilimitados
  tiendas_incluidas            integer NOT NULL DEFAULT 1,
  precio_tienda_extra          numeric,
  features                     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- textos para mostrar
  stripe_price_id              text,                       -- precio mensual en Stripe
  stripe_price_id_tienda_extra text,
  orden                        integer NOT NULL DEFAULT 0,
  activo                       boolean NOT NULL DEFAULT true,
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.pos_planes (id, nombre, descripcion, precio_mensual, precio_primer_mes, max_usuarios, tiendas_incluidas, precio_tienda_extra, features, orden) VALUES
  ('mostrador', 'Mostrador', 'Para kioscos y negocios que arrancan', 40000, 20000, 8, 1, NULL,
   '["Venta con scanner de código de barras","Efectivo, transferencia, MP QR, débito y crédito","Caja diaria y cortes X / Z / del día","Stock con alertas y reportes","Generador de códigos de barras y etiquetas","Hasta 8 usuarios"]'::jsonb, 1),
  ('negocio', 'Negocio', 'Para almacenes y ferreterías en crecimiento', 60000, 30000, NULL, 1, NULL,
   '["Todo lo de Mostrador","Usuarios ilimitados","Costos, márgenes y Finanzas","Promos y combos","Cuenta corriente (fiado)","Programa de puntos","Devoluciones, reservas y prepagos"]'::jsonb, 2),
  ('cadena', 'Cadena', 'Para varias tiendas o sucursales', 90000, 45000, NULL, 3, 24900,
   '["Todo lo de Negocio","Multi-tienda: 3 tiendas incluidas","Corte global y finanzas consolidadas","Transferencias de stock entre tiendas","Soporte prioritario"]'::jsonb, 3)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.pos_suscripciones (
  organization_id        uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_id                text REFERENCES public.pos_planes(id),
  estado                 text NOT NULL DEFAULT 'trial'
                         CHECK (estado IN ('trial','activa','pago_pendiente','cancelada','vencida')),
  stripe_customer_id     text UNIQUE,
  stripe_subscription_id text UNIQUE,
  stripe_price_id        text,
  tiendas_extra          integer NOT NULL DEFAULT 0,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  ultimo_evento          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Eventos de Stripe ya procesados (idempotencia del webhook).
CREATE TABLE IF NOT EXISTS public.pos_billing_eventos (
  id              text PRIMARY KEY,     -- id del evento de Stripe (evt_…)
  tipo            text NOT NULL,
  organization_id uuid,
  payload         jsonb,
  recibido_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pos_planes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_suscripciones   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_billing_eventos ENABLE ROW LEVEL SECURITY;

-- Los planes son públicos (también los puede leer la landing).
CREATE POLICY pos_planes_select ON public.pos_planes FOR SELECT USING (activo);
CREATE POLICY pos_suscripciones_select ON public.pos_suscripciones FOR SELECT
  USING (is_super_admin() OR organization_id IN (SELECT ur.organization_id FROM user_roles ur WHERE ur.user_id = auth.uid() AND ur.activo = true));
-- pos_billing_eventos: sin políticas → solo el service role (webhook).
-- Escrituras en pos_suscripciones: solo el service role (webhook / checkout).

GRANT SELECT ON public.pos_planes TO anon, authenticated;
GRANT SELECT ON public.pos_suscripciones TO authenticated;

-- Plan y estado de la suscripción de la org, para mostrar en Configuración.
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

  v_estado := COALESCE(v_sus.estado,
    CASE WHEN v_org.plan = 'trial' THEN
           CASE WHEN v_org.trial_ends_at IS NOT NULL AND v_org.trial_ends_at <= now() THEN 'vencida' ELSE 'trial' END
         ELSE 'activa' END);
  IF v_estado = 'trial' AND v_org.trial_ends_at IS NOT NULL THEN
    v_dias := GREATEST(0, ceil(EXTRACT(EPOCH FROM (v_org.trial_ends_at - now())) / 86400)::int);
  END IF;

  RETURN jsonb_build_object(
    'estado',               v_estado,
    'plan_id',              v_sus.plan_id,
    'plan_nombre',          COALESCE(v_plan.nombre,
                              CASE WHEN v_org.plan = 'trial' THEN 'Prueba gratis' ELSE initcap(COALESCE(v_org.plan, 'Sin plan')) END),
    'plan_legacy',          v_org.plan,
    'precio_mensual',       v_plan.precio_mensual,
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

REVOKE ALL ON FUNCTION public.pos_plan_actual(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_plan_actual(uuid) TO authenticated;
