-- Aplicado en producción (proyecto Reparto) el 2026-10-05.
-- El stock del mostrador nunca puede quedar negativo: si una venta (o
-- cualquier ajuste) descuenta más de lo que hay, queda en 0.

-- Respaldo de las filas que estaban negativas antes de llevarlas a 0 (169 filas).
CREATE TABLE IF NOT EXISTS public.stock_mostrador_negativos_backup AS
  SELECT s.*, now() AS backup_at FROM public.stock_mostrador s WHERE s.cantidad < 0;
ALTER TABLE public.stock_mostrador_negativos_backup ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_stock_mostrador_no_negativo()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NEW.cantidad < 0 THEN NEW.cantidad := 0; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_stock_mostrador_no_negativo
  BEFORE INSERT OR UPDATE OF cantidad ON public.stock_mostrador
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_mostrador_no_negativo();

UPDATE public.stock_mostrador SET cantidad = 0, updated_at = now() WHERE cantidad < 0;

-- Para revertir:
--   DROP TRIGGER trg_stock_mostrador_no_negativo ON public.stock_mostrador;
--   UPDATE public.stock_mostrador s SET cantidad = b.cantidad
--     FROM public.stock_mostrador_negativos_backup b WHERE b.id = s.id;
