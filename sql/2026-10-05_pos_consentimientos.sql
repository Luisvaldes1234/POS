-- Aceptación de Términos / Aviso de privacidad y preferencia de uso de datos
-- para mejora del servicio e IA, por negocio.
--
-- - terminos_version: versión de los documentos que aceptó el administrador
--   (la fecha de "Última actualización" de terminos.html / privacidad.html).
-- - mejora_ia: si el negocio permite usar sus datos, desidentificados, para
--   mejorar el servicio y entrenar/evaluar modelos de IA (privacidad.html §4).
--   Se puede desactivar al registrarse o en Configuración. Cualquier proceso
--   que use datos para esos fines debe filtrar por mejora_ia = true.
--
-- Al registrarse, signup.html guarda en la metadata del usuario
-- terminos_version y mejora_ia; pos_consentimiento_estado los copia acá la
-- primera vez que el administrador entra a la app.

CREATE TABLE IF NOT EXISTS public.pos_consentimientos (
  organization_id        uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  terminos_version       text,
  terminos_aceptados_at  timestamptz,
  terminos_aceptados_por uuid,
  mejora_ia              boolean NOT NULL DEFAULT true,
  mejora_ia_at           timestamptz,
  mejora_ia_por          uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pos_consentimientos ENABLE ROW LEVEL SECURITY;
-- Sin políticas: solo se accede con las funciones de abajo.

-- Estado del negocio. Si no hay registro y el usuario aceptó al registrarse,
-- lo crea con lo que eligió en el formulario.
CREATE OR REPLACE FUNCTION public.pos_consentimiento_estado(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol  text := public._pos_lealtad_rol(p_organization_id);
  v_meta jsonb;
  v_c    pos_consentimientos%ROWTYPE;
BEGIN
  IF v_rol IS NULL THEN RAISE EXCEPTION 'Sin acceso a este negocio'; END IF;
  SELECT * INTO v_c FROM pos_consentimientos WHERE organization_id = p_organization_id;
  IF NOT FOUND AND v_rol <> 'client_pos' THEN
    SELECT COALESCE(raw_user_meta_data, '{}'::jsonb) INTO v_meta FROM auth.users WHERE id = auth.uid();
    IF NULLIF(btrim(v_meta->>'terminos_version'), '') IS NOT NULL THEN
      INSERT INTO pos_consentimientos (organization_id, terminos_version, terminos_aceptados_at, terminos_aceptados_por,
                                       mejora_ia, mejora_ia_at, mejora_ia_por)
      VALUES (p_organization_id, v_meta->>'terminos_version',
              COALESCE(NULLIF(v_meta->>'terminos_aceptados_at', '')::timestamptz, now()), auth.uid(),
              COALESCE((v_meta->>'mejora_ia')::boolean, true), now(), auth.uid())
      ON CONFLICT (organization_id) DO NOTHING;
      SELECT * INTO v_c FROM pos_consentimientos WHERE organization_id = p_organization_id;
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'terminos_version', v_c.terminos_version,
    'terminos_aceptados_at', v_c.terminos_aceptados_at,
    'mejora_ia', COALESCE(v_c.mejora_ia, true),
    'es_admin', v_rol <> 'client_pos');
END;
$$;

-- Guarda la aceptación de una versión y/o la preferencia de mejora_ia.
-- Parámetros en NULL no cambian el valor guardado.
CREATE OR REPLACE FUNCTION public.pos_consentimiento_guardar(
  p_organization_id uuid, p_terminos_version text DEFAULT NULL, p_mejora_ia boolean DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rol text := public._pos_lealtad_rol(p_organization_id);
BEGIN
  IF v_rol IS NULL OR v_rol = 'client_pos' THEN RAISE EXCEPTION 'Solo un administrador puede cambiar esto'; END IF;
  INSERT INTO pos_consentimientos AS c (organization_id, terminos_version, terminos_aceptados_at, terminos_aceptados_por,
                                        mejora_ia, mejora_ia_at, mejora_ia_por)
  VALUES (p_organization_id, p_terminos_version,
          CASE WHEN p_terminos_version IS NOT NULL THEN now() END,
          CASE WHEN p_terminos_version IS NOT NULL THEN auth.uid() END,
          COALESCE(p_mejora_ia, true), now(), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE SET
    terminos_version       = COALESCE(p_terminos_version, c.terminos_version),
    terminos_aceptados_at  = CASE WHEN p_terminos_version IS NOT NULL THEN now() ELSE c.terminos_aceptados_at END,
    terminos_aceptados_por = CASE WHEN p_terminos_version IS NOT NULL THEN auth.uid() ELSE c.terminos_aceptados_por END,
    mejora_ia              = COALESCE(p_mejora_ia, c.mejora_ia),
    mejora_ia_at           = CASE WHEN p_mejora_ia IS NOT NULL THEN now() ELSE c.mejora_ia_at END,
    mejora_ia_por          = CASE WHEN p_mejora_ia IS NOT NULL THEN auth.uid() ELSE c.mejora_ia_por END,
    updated_at             = now();
  RETURN public.pos_consentimiento_estado(p_organization_id);
END;
$$;

REVOKE ALL ON FUNCTION public.pos_consentimiento_estado(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pos_consentimiento_guardar(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_consentimiento_estado(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pos_consentimiento_guardar(uuid, text, boolean) TO authenticated;
