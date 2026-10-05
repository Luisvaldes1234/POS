// POST { organization_id } → { url } del portal de facturación de Stripe
// (cambiar tarjeta, cambiar de plan, ver facturas, cancelar).
import { APP_URL, HttpError, json, corsHeaders, requireOrgAdmin, stripe } from "../_shared/billing.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { organization_id: orgId } = await req.json();
    if (!orgId) throw new HttpError(400, "Falta organization_id");
    const { admin } = await requireOrgAdmin(req, orgId);

    const { data: sus } = await admin.from("pos_suscripciones")
      .select("stripe_customer_id").eq("organization_id", orgId).maybeSingle();
    if (!sus?.stripe_customer_id) throw new HttpError(404, "Todavía no tenés una suscripción con tarjeta");

    const session = await stripe.billingPortal.sessions.create({
      customer: sus.stripe_customer_id,
      return_url: `${APP_URL}/app.html?billing=portal`,
      locale: "es",
    });
    return json({ url: session.url });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error("pos-billing-portal:", e);
    return json({ error: (e as Error).message }, status);
  }
});
