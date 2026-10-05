-- Tokens de un solo uso para correr la edge function pos-billing-setup
-- (crea productos, precios y cupones en Stripe y guarda los ids en
-- pos_planes_precios). Sin políticas: solo la usa el service role.
CREATE TABLE IF NOT EXISTS public.pos_billing_setup_tokens (
  token      text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  usado_at   timestamptz
);
ALTER TABLE public.pos_billing_setup_tokens ENABLE ROW LEVEL SECURITY;

-- Para correrla (prueba o real, según STRIPE_SECRET_KEY):
--   INSERT INTO pos_billing_setup_tokens (token) VALUES ('<token-aleatorio>');
--   SELECT net.http_post(
--     url := 'https://zgdrvptneiwlxlaywfur.supabase.co/functions/v1/pos-billing-setup',
--     headers := '{"Content-Type":"application/json","x-setup-token":"<token-aleatorio>"}'::jsonb,
--     body := '{}'::jsonb, timeout_milliseconds := 120000);
--   SELECT status_code, content FROM net._http_response ORDER BY id DESC LIMIT 1;
