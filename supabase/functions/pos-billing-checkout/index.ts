// POST { organization_id, plan_id } → { url } de Stripe Checkout.
// Crea (o reutiliza) el customer de Stripe de la organización y abre una
// suscripción mensual al precio del plan (pos_planes.stripe_price_id).
import { APP_URL, HttpError, json, corsHeaders, requireOrgAdmin, stripe } from "../_shared/billing.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { organization_id: orgId, plan_id: planId } = await req.json();
    if (!orgId || !planId) throw new HttpError(400, "Faltan organization_id o plan_id");
    const { user, admin } = await requireOrgAdmin(req, orgId);

    const { data: plan } = await admin.from("pos_planes")
      .select("id, nombre, stripe_price_id, activo").eq("id", planId).maybeSingle();
    if (!plan?.activo) throw new HttpError(404, "Plan no encontrado");
    if (!plan.stripe_price_id) throw new HttpError(409, "Este plan todavía no tiene precio en Stripe");

    const { data: org } = await admin.from("organizations").select("name, email").eq("id", orgId).single();
    const { data: sus } = await admin.from("pos_suscripciones")
      .select("stripe_customer_id, stripe_subscription_id, estado").eq("organization_id", orgId).maybeSingle();

    // Si ya tiene una suscripción viva, los cambios de plan van por el portal.
    if (sus?.stripe_subscription_id && ["activa", "pago_pendiente"].includes(sus.estado)) {
      throw new HttpError(409, "Ya tenés una suscripción activa. Cambiá de plan desde “Administrar suscripción”.");
    }

    let customerId = sus?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: org?.name ?? undefined,
        email: org?.email ?? user.email ?? undefined,
        metadata: { organization_id: orgId },
      });
      customerId = customer.id;
      await admin.from("pos_suscripciones").upsert({
        organization_id: orgId, stripe_customer_id: customerId, updated_at: new Date().toISOString(),
      }, { onConflict: "organization_id" });
    }

    // 50% el primer mes: cupón opcional, solo si nunca tuvo suscripción.
    const cupon = Deno.env.get("STRIPE_COUPON_PRIMER_MES");
    const discounts = cupon && !sus?.stripe_subscription_id ? [{ coupon: cupon }] : undefined;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: orgId,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      discounts,
      allow_promotion_codes: discounts ? undefined : true,
      subscription_data: { metadata: { organization_id: orgId, plan_id: plan.id } },
      metadata: { organization_id: orgId, plan_id: plan.id },
      success_url: `${APP_URL}/app.html?billing=ok`,
      cancel_url: `${APP_URL}/app.html?billing=cancel`,
      locale: "es",
    });
    return json({ url: session.url });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error("pos-billing-checkout:", e);
    return json({ error: (e as Error).message }, status);
  }
});
