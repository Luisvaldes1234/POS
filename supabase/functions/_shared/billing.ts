// Utilidades compartidas por las edge functions de cobro con Stripe.
//
// Secrets necesarios (supabase secrets set …):
//   STRIPE_SECRET_KEY        sk_live_… / sk_test_…
//   STRIPE_WEBHOOK_SECRET    whsec_… (solo pos-billing-webhook)
//   APP_URL                  https://pos.trackmyvend.com (sin barra final)
//   STRIPE_COUPON_PRIMER_MES (opcional) cupón de Stripe para el 50% del primer mes
// SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase.

import Stripe from "npm:stripe@17.7.0";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2025-02-24.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});

export const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Cliente con service role: bypassa RLS. Solo para escribir la suscripción.
export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

// Valida el JWT del usuario y que sea admin de la organización indicada.
export async function requireOrgAdmin(req: Request, orgId: string) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) throw new HttpError(401, "Sesión inválida");

  const admin = adminClient();
  const { data: rol } = await admin.from("user_roles")
    .select("role").eq("user_id", user.id).eq("organization_id", orgId).eq("activo", true)
    .in("role", ["client_admin", "account_manager", "super_admin"]).maybeSingle();
  if (!rol) {
    const { data: sys } = await admin.from("system_roles").select("role").eq("user_id", user.id).maybeSingle();
    if (sys?.role !== "super_admin") throw new HttpError(403, "Solo un administrador puede gestionar el plan");
  }
  return { user, admin };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Estado de Stripe → estado interno de pos_suscripciones.
export function estadoDesdeStripe(status: Stripe.Subscription.Status): string {
  switch (status) {
    case "active":
    case "trialing": return "activa";
    case "past_due":
    case "unpaid":
    case "incomplete": return "pago_pendiente";
    case "canceled": return "cancelada";
    case "incomplete_expired": return "vencida";
    default: return "pago_pendiente";
  }
}
