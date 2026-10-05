// POST { organization_id, plan_id, periodo?: 'mensual' | 'anual' } → { url } de Stripe Checkout.
// Crea (o reutiliza) el customer de Stripe de la organización y abre la
// suscripción:
//   - mensual: stripe_price_id + cupón de promo del plan (stripe_coupon_promo,
//     ej. Mostrador: precio promo los primeros 3 meses) o, si el plan no tiene
//     promo, el cupón general STRIPE_COUPON_PRIMER_MES.
//   - anual:   stripe_price_id_anual (pago del año por adelantado).
// Precios e ids de Stripe por país: pos_planes_precios (país de la org; 'OT'
// para países no soportados, en USD).
// Si la organización todavía está en la prueba gratis, el primer cobro se
// hace cuando termina la prueba (no pierde los días que le quedan).
import { APP_URL, HttpError, json, corsHeaders, requireOrgAdmin, stripe } from "../_shared/billing.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { organization_id: orgId, plan_id: planId, periodo = "mensual" } = await req.json();
    if (!orgId || !planId) throw new HttpError(400, "Faltan organization_id o plan_id");
    if (!["mensual", "anual"].includes(periodo)) throw new HttpError(400, "Período inválido");
    const { user, admin } = await requireOrgAdmin(req, orgId);

    const { data: plan } = await admin.from("pos_planes")
      .select("id, nombre, activo").eq("id", planId).maybeSingle();
    if (!plan?.activo) throw new HttpError(404, "Plan no encontrado");

    const { data: org } = await admin.from("organizations").select("name, email, plan, pais, trial_ends_at").eq("id", orgId).single();
    const pais = ["AR", "MX", "CL", "CO", "PE", "UY"].includes(String(org?.pais ?? "").toUpperCase())
      ? String(org!.pais).toUpperCase() : "OT";
    const { data: precio } = await admin.from("pos_planes_precios")
      .select("stripe_price_id, stripe_price_id_anual, stripe_coupon_promo")
      .eq("plan_id", planId).eq("pais", pais).maybeSingle();
    const priceId = periodo === "anual" ? precio?.stripe_price_id_anual : precio?.stripe_price_id;
    if (!priceId) throw new HttpError(409, periodo === "anual" ? "Este plan no tiene pago anual" : "Este plan todavía no tiene precio en Stripe para tu país");
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

    // Promo de bienvenida (solo si nunca tuvo suscripción y paga mensual).
    const cupon = periodo === "mensual" && !sus?.stripe_subscription_id
      ? (precio?.stripe_coupon_promo || Deno.env.get("STRIPE_COUPON_PRIMER_MES") || null)
      : null;
    const discounts = cupon ? [{ coupon: cupon }] : undefined;

    // Respetar los días de prueba que le quedan. Stripe Checkout exige que el
    // fin de la prueba esté al menos 48 h en el futuro.
    const finPrueba = org?.plan === "trial" && org?.trial_ends_at ? new Date(org.trial_ends_at).getTime() : 0;
    const trialEnd = finPrueba > Date.now() + 49 * 3600 * 1000 ? Math.floor(finPrueba / 1000) : undefined;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: orgId,
      line_items: [{ price: priceId, quantity: 1 }],
      discounts,
      allow_promotion_codes: discounts ? undefined : true,
      subscription_data: { metadata: { organization_id: orgId, plan_id: plan.id, periodo, pais }, trial_end: trialEnd },
      metadata: { organization_id: orgId, plan_id: plan.id, periodo, pais },
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
