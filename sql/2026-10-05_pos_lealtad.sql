-- Programa de lealtad del POS Mostrador.
-- Aplicado en producción (proyecto Reparto) el 2026-10-05. Solo objetos nuevos.
--
-- Reglas: cada `pesos_por_punto` de compra suma 1 punto. Los puntos se canjean
-- por recompensas configurables (descuento en $, descuento en % o producto
-- gratis). Lectura por RLS para miembros de la org; escrituras solo vía RPC.

CREATE TABLE IF NOT EXISTS public.pos_lealtad_config (
  organization_id   uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  activo            boolean NOT NULL DEFAULT false,
  pesos_por_punto   numeric NOT NULL DEFAULT 1000 CHECK (pesos_por_punto > 0),
  puntos_bienvenida integer NOT NULL DEFAULT 0 CHECK (puntos_bienvenida >= 0),
  -- [{id, nombre, puntos, tipo: 'monto'|'pct'|'producto', valor, producto_id, activo}]
  recompensas       jsonb   NOT NULL DEFAULT '[]'::jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pos_lealtad_miembros (
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cliente_id        uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  puntos            integer NOT NULL DEFAULT 0 CHECK (puntos >= 0),
  puntos_acumulados integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, cliente_id)
);

CREATE TABLE IF NOT EXISTS public.pos_lealtad_movimientos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cliente_id        uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  puntos            integer NOT NULL,
  tipo              text NOT NULL CHECK (tipo IN ('bienvenida','compra','canje','ajuste')),
  pedido_id         uuid,
  monto             numeric,
  detalle           text,
  created_by        uuid,
  created_by_nombre text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_lealtad_mov_cli_idx
  ON public.pos_lealtad_movimientos (organization_id, cliente_id, created_at DESC);
-- Una venta suma puntos una sola vez.
CREATE UNIQUE INDEX IF NOT EXISTS pos_lealtad_mov_compra_uniq
  ON public.pos_lealtad_movimientos (pedido_id) WHERE tipo = 'compra' AND pedido_id IS NOT NULL;

ALTER TABLE public.pos_lealtad_config      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_lealtad_miembros    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_lealtad_movimientos ENABLE ROW LEVEL SECURITY;

CREATE POLICY pos_lealtad_config_select ON public.pos_lealtad_config FOR SELECT
  USING (is_super_admin() OR organization_id IN (SELECT ur.organization_id FROM user_roles ur WHERE ur.user_id = auth.uid() AND ur.activo = true));
CREATE POLICY pos_lealtad_miembros_select ON public.pos_lealtad_miembros FOR SELECT
  USING (is_super_admin() OR organization_id IN (SELECT ur.organization_id FROM user_roles ur WHERE ur.user_id = auth.uid() AND ur.activo = true));
CREATE POLICY pos_lealtad_movimientos_select ON public.pos_lealtad_movimientos FOR SELECT
  USING (is_super_admin() OR organization_id IN (SELECT ur.organization_id FROM user_roles ur WHERE ur.user_id = auth.uid() AND ur.activo = true));

-- Rol POS del usuario en la org (NULL si no tiene acceso).
CREATE OR REPLACE FUNCTION public._pos_lealtad_rol(p_org uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN is_super_admin() THEN 'super_admin' ELSE (
    SELECT role FROM user_roles
    WHERE user_id = auth.uid() AND organization_id = p_org AND activo = true
      AND role IN ('client_pos','client_admin','super_admin','account_manager')
    LIMIT 1) END;
$$;

CREATE OR REPLACE FUNCTION public.pos_lealtad_config_set(
  p_organization_id uuid, p_activo boolean, p_pesos_por_punto numeric,
  p_puntos_bienvenida integer, p_recompensas jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_rol text := public._pos_lealtad_rol(p_organization_id);
BEGIN
  IF v_rol IS NULL OR v_rol = 'client_pos' THEN
    RAISE EXCEPTION 'Solo un administrador puede configurar el programa de lealtad';
  END IF;
  IF p_pesos_por_punto IS NULL OR p_pesos_por_punto <= 0 THEN
    RAISE EXCEPTION 'Los pesos por punto deben ser mayores a cero';
  END IF;
  IF p_recompensas IS NULL OR jsonb_typeof(p_recompensas) <> 'array' THEN
    RAISE EXCEPTION 'Recompensas inválidas';
  END IF;
  INSERT INTO pos_lealtad_config (organization_id, activo, pesos_por_punto, puntos_bienvenida, recompensas, updated_at)
  VALUES (p_organization_id, COALESCE(p_activo, false), p_pesos_por_punto, GREATEST(COALESCE(p_puntos_bienvenida, 0), 0), p_recompensas, now())
  ON CONFLICT (organization_id) DO UPDATE SET
    activo = EXCLUDED.activo, pesos_por_punto = EXCLUDED.pesos_por_punto,
    puntos_bienvenida = EXCLUDED.puntos_bienvenida, recompensas = EXCLUDED.recompensas,
    updated_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Registra un cliente en el programa por teléfono + nombre. Si ya existe un
-- cliente con ese teléfono lo reutiliza; si no, lo crea.
CREATE OR REPLACE FUNCTION public.pos_lealtad_registrar(
  p_organization_id uuid, p_telefono text, p_nombre text, p_cliente_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol text := public._pos_lealtad_rol(p_organization_id);
  v_tel text := regexp_replace(COALESCE(p_telefono, ''), '[^0-9]', '', 'g');
  v_cli uuid := p_cliente_id;
  v_nuevo boolean := false;
  v_ya boolean := false;
  v_bienv int := 0;
  v_user_nombre text;
  v_puntos int;
BEGIN
  IF v_rol IS NULL THEN RAISE EXCEPTION 'sin permisos'; END IF;
  SELECT COALESCE(raw_user_meta_data->>'name', email) INTO v_user_nombre FROM auth.users WHERE id = auth.uid();

  IF v_cli IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM clientes WHERE id = v_cli AND organization_id = p_organization_id) THEN
      RAISE EXCEPTION 'cliente no encontrado';
    END IF;
  ELSE
    IF length(v_tel) < 6 THEN RAISE EXCEPTION 'Ingresá un teléfono válido'; END IF;
    SELECT id INTO v_cli FROM clientes
    WHERE organization_id = p_organization_id AND activo = true
      AND (regexp_replace(COALESCE(telefono,''), '[^0-9]', '', 'g') = v_tel
        OR regexp_replace(COALESCE(whatsapp,''), '[^0-9]', '', 'g') = v_tel)
    ORDER BY created_at LIMIT 1;
    IF v_cli IS NULL THEN
      IF COALESCE(btrim(p_nombre), '') = '' THEN RAISE EXCEPTION 'Ingresá el nombre del cliente'; END IF;
      INSERT INTO clientes (organization_id, nombre, telefono, whatsapp, activo)
      VALUES (p_organization_id, btrim(p_nombre), btrim(p_telefono), btrim(p_telefono), true)
      RETURNING id INTO v_cli;
      v_nuevo := true;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pos_lealtad_miembros WHERE organization_id = p_organization_id AND cliente_id = v_cli) THEN
    v_ya := true;
  ELSE
    SELECT COALESCE(puntos_bienvenida, 0) INTO v_bienv FROM pos_lealtad_config WHERE organization_id = p_organization_id;
    v_bienv := COALESCE(v_bienv, 0);
    INSERT INTO pos_lealtad_miembros (organization_id, cliente_id, puntos, puntos_acumulados)
    VALUES (p_organization_id, v_cli, v_bienv, v_bienv);
    IF v_bienv > 0 THEN
      INSERT INTO pos_lealtad_movimientos (organization_id, cliente_id, puntos, tipo, detalle, created_by, created_by_nombre)
      VALUES (p_organization_id, v_cli, v_bienv, 'bienvenida', 'Puntos de bienvenida', auth.uid(), v_user_nombre);
    END IF;
  END IF;

  SELECT puntos INTO v_puntos FROM pos_lealtad_miembros WHERE organization_id = p_organization_id AND cliente_id = v_cli;
  RETURN jsonb_build_object('ok', true, 'cliente_id', v_cli, 'nuevo_cliente', v_nuevo,
    'ya_era_miembro', v_ya, 'puntos', v_puntos, 'bienvenida', CASE WHEN v_ya THEN 0 ELSE v_bienv END);
END;
$$;

-- Suma los puntos de una venta (idempotente por pedido).
CREATE OR REPLACE FUNCTION public.pos_lealtad_sumar(
  p_organization_id uuid, p_cliente_id uuid, p_monto numeric, p_pedido_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol text := public._pos_lealtad_rol(p_organization_id);
  v_cfg record;
  v_pts int;
  v_user_nombre text;
  v_saldo int;
BEGIN
  IF v_rol IS NULL THEN RAISE EXCEPTION 'sin permisos'; END IF;
  SELECT * INTO v_cfg FROM pos_lealtad_config WHERE organization_id = p_organization_id;
  IF NOT FOUND OR NOT v_cfg.activo THEN RETURN jsonb_build_object('ok', true, 'puntos_ganados', 0, 'motivo', 'inactivo'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pos_lealtad_miembros WHERE organization_id = p_organization_id AND cliente_id = p_cliente_id) THEN
    RETURN jsonb_build_object('ok', true, 'puntos_ganados', 0, 'motivo', 'no_miembro');
  END IF;
  IF p_pedido_id IS NOT NULL AND EXISTS (SELECT 1 FROM pos_lealtad_movimientos WHERE pedido_id = p_pedido_id AND tipo = 'compra') THEN
    SELECT puntos INTO v_saldo FROM pos_lealtad_miembros WHERE organization_id = p_organization_id AND cliente_id = p_cliente_id;
    RETURN jsonb_build_object('ok', true, 'puntos_ganados', 0, 'puntos', v_saldo, 'motivo', 'ya_sumado');
  END IF;

  v_pts := floor(GREATEST(COALESCE(p_monto, 0), 0) / v_cfg.pesos_por_punto)::int;
  IF v_pts > 0 THEN
    SELECT COALESCE(raw_user_meta_data->>'name', email) INTO v_user_nombre FROM auth.users WHERE id = auth.uid();
    INSERT INTO pos_lealtad_movimientos (organization_id, cliente_id, puntos, tipo, pedido_id, monto, detalle, created_by, created_by_nombre)
    VALUES (p_organization_id, p_cliente_id, v_pts, 'compra', p_pedido_id, p_monto, 'Compra', auth.uid(), v_user_nombre);
    UPDATE pos_lealtad_miembros SET puntos = puntos + v_pts, puntos_acumulados = puntos_acumulados + v_pts, updated_at = now()
    WHERE organization_id = p_organization_id AND cliente_id = p_cliente_id;
  END IF;
  SELECT puntos INTO v_saldo FROM pos_lealtad_miembros WHERE organization_id = p_organization_id AND cliente_id = p_cliente_id;
  RETURN jsonb_build_object('ok', true, 'puntos_ganados', v_pts, 'puntos', v_saldo);
END;
$$;

-- Canjea una recompensa configurada: descuenta los puntos y devuelve la recompensa.
CREATE OR REPLACE FUNCTION public.pos_lealtad_canjear(
  p_organization_id uuid, p_cliente_id uuid, p_recompensa_id text, p_pedido_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol text := public._pos_lealtad_rol(p_organization_id);
  v_rec jsonb;
  v_costo int;
  v_saldo int;
  v_user_nombre text;
BEGIN
  IF v_rol IS NULL THEN RAISE EXCEPTION 'sin permisos'; END IF;
  SELECT r INTO v_rec FROM pos_lealtad_config c, jsonb_array_elements(c.recompensas) r
  WHERE c.organization_id = p_organization_id AND r->>'id' = p_recompensa_id
    AND COALESCE((r->>'activo')::boolean, true) LIMIT 1;
  IF v_rec IS NULL THEN RAISE EXCEPTION 'Recompensa no encontrada'; END IF;
  v_costo := GREATEST(COALESCE((v_rec->>'puntos')::int, 0), 0);

  SELECT puntos INTO v_saldo FROM pos_lealtad_miembros
  WHERE organization_id = p_organization_id AND cliente_id = p_cliente_id FOR UPDATE;
  IF v_saldo IS NULL THEN RAISE EXCEPTION 'El cliente no está en el programa de lealtad'; END IF;
  IF v_saldo < v_costo THEN RAISE EXCEPTION 'Puntos insuficientes: tiene %, necesita %', v_saldo, v_costo; END IF;

  SELECT COALESCE(raw_user_meta_data->>'name', email) INTO v_user_nombre FROM auth.users WHERE id = auth.uid();
  UPDATE pos_lealtad_miembros SET puntos = puntos - v_costo, updated_at = now()
  WHERE organization_id = p_organization_id AND cliente_id = p_cliente_id;
  INSERT INTO pos_lealtad_movimientos (organization_id, cliente_id, puntos, tipo, pedido_id, detalle, created_by, created_by_nombre)
  VALUES (p_organization_id, p_cliente_id, -v_costo, 'canje', p_pedido_id, 'Canje: ' || COALESCE(v_rec->>'nombre', ''), auth.uid(), v_user_nombre);
  RETURN jsonb_build_object('ok', true, 'recompensa', v_rec, 'puntos', v_saldo - v_costo);
END;
$$;

-- Ajuste manual de puntos (solo admins).
CREATE OR REPLACE FUNCTION public.pos_lealtad_ajustar(
  p_organization_id uuid, p_cliente_id uuid, p_puntos integer, p_detalle text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol text := public._pos_lealtad_rol(p_organization_id);
  v_saldo int;
  v_user_nombre text;
BEGIN
  IF v_rol IS NULL OR v_rol = 'client_pos' THEN RAISE EXCEPTION 'Solo un administrador puede ajustar puntos'; END IF;
  SELECT puntos INTO v_saldo FROM pos_lealtad_miembros
  WHERE organization_id = p_organization_id AND cliente_id = p_cliente_id FOR UPDATE;
  IF v_saldo IS NULL THEN RAISE EXCEPTION 'El cliente no está en el programa de lealtad'; END IF;
  IF v_saldo + p_puntos < 0 THEN RAISE EXCEPTION 'El saldo de puntos no puede quedar negativo'; END IF;
  SELECT COALESCE(raw_user_meta_data->>'name', email) INTO v_user_nombre FROM auth.users WHERE id = auth.uid();
  UPDATE pos_lealtad_miembros SET puntos = puntos + p_puntos,
    puntos_acumulados = puntos_acumulados + GREATEST(p_puntos, 0), updated_at = now()
  WHERE organization_id = p_organization_id AND cliente_id = p_cliente_id;
  INSERT INTO pos_lealtad_movimientos (organization_id, cliente_id, puntos, tipo, detalle, created_by, created_by_nombre)
  VALUES (p_organization_id, p_cliente_id, p_puntos, 'ajuste', COALESCE(p_detalle, 'Ajuste manual'), auth.uid(), v_user_nombre);
  RETURN jsonb_build_object('ok', true, 'puntos', v_saldo + p_puntos);
END;
$$;

REVOKE ALL ON FUNCTION public._pos_lealtad_rol(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pos_lealtad_config_set(uuid, boolean, numeric, integer, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pos_lealtad_registrar(uuid, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pos_lealtad_sumar(uuid, uuid, numeric, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pos_lealtad_canjear(uuid, uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pos_lealtad_ajustar(uuid, uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pos_lealtad_rol(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pos_lealtad_config_set(uuid, boolean, numeric, integer, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pos_lealtad_registrar(uuid, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pos_lealtad_sumar(uuid, uuid, numeric, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pos_lealtad_canjear(uuid, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pos_lealtad_ajustar(uuid, uuid, integer, text) TO authenticated;
GRANT SELECT ON public.pos_lealtad_config, public.pos_lealtad_miembros, public.pos_lealtad_movimientos TO authenticated;
