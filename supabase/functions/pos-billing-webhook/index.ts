// Webhook de Stripe. Desplegar con --no-verify-jwt (Stripe no manda JWT) y
// registrar en Stripe la URL …/functions/v1/pos-billing-webhook con los eventos:
//   checkout.session.completed
//   customer.subscription.created / updated / deleted
//   invoice.paid / invoice.payment_failed
//
// Mantiene pos_suscripciones y organizations.plan:
//   - suscripción activa  → organizations.plan = 'pro' (marca de cuenta paga; la
//     columna tiene un CHECK compartido con Reparto, así que el plan real del
//     POS vive en pos_suscripciones.plan_id)
//   - cancelada / vencida → organizations.plan = 'trial' con trial_ends_at = fin
//     del período pagado, así el bloqueo existente (_assert_trial_active) corta
//     el acceso cuando termina lo que ya pagó.
import Stripe from "npm:stripe@17.7.0";
import { adminClient, estadoDesdeStripe, json, stripe } from "../_shared/billing.ts";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  const firma = req.headers.get("Stripe-Signature");
  const cuerpo = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      cuerpo, firma ?? "", Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "", undefined, cryptoProvider,
    );
  } catch (e) {
    console.error("firma inválida:", (e as Error).message);
    return json({ error: "firma inválida" }, 400);
  }

  const admin = adminClient();

  // Idempotencia: si el evento ya se procesó, no se repite.
  const { error: dup } = await admin.from("pos_billing_eventos").insert({
    id: event.id, tipo: event.type, payload: event.data.object as unknown as Record<string, unknown>,
  });
  if (dup) {
    if (dup.code === "23505") return json({ ok: true, duplicado: true });
    console.error("registrar evento:", dup);
    return json({ error: "no se pudo registrar el evento" }, 500);
  }

  try {
    let sub: Stripe.Subscription | null = null;
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.subscription) sub = await stripe.subscriptions.retrieve(String(s.subscription));
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        sub = event.data.object as Stripe.Subscription;
        break;
      case "invoice.paid":
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        if (inv.subscription) sub = await stripe.subscriptions.retrieve(String(inv.subscription));
        break;
      }
    }
    if (sub) await sincronizarSuscripcion(admin, sub, event.type);
    return json({ ok: true });
  } catch (e) {
    console.error("pos-billing-webhook:", e);
    // Borrar el registro para que el reintento de Stripe lo vuelva a procesar.
    await admin.from("pos_billing_eventos").delete().eq("id", event.id);
    return json({ error: (e as Error).message }, 500);
  }
});

async function sincronizarSuscripcion(
  admin: ReturnType<typeof adminClient>, sub: Stripe.Subscription, tipoEvento: string,
) {
  const orgId = sub.metadata?.organization_id;
  if (!orgId) { console.warn("suscripción sin organization_id en metadata:", sub.id); return; }

  const priceId = sub.items.data[0]?.price?.id ?? null;
  const { data: plan } = priceId
    ? await admin.from("pos_planes").select("id").eq("stripe_price_id", priceId).maybeSingle()
    : { data: null };
  const estado = estadoDesdeStripe(sub.status);
  const finPeriodo = new Date(sub.current_period_end * 1000).toISOString();

  await admin.from("pos_suscripciones").upsert({
    organization_id: orgId,
    plan_id: plan?.id ?? sub.metadata?.plan_id ?? null,
    estado,
    stripe_customer_id: String(sub.customer),
    stripe_subscription_id: sub.id,
    stripe_price_id: priceId,
    current_period_end: finPeriodo,
    cancel_at_period_end: sub.cancel_at_period_end,
    ultimo_evento: tipoEvento,
    updated_at: new Date().toISOString(),
  }, { onConflict: "organization_id" });

  if (estado === "activa" || estado === "pago_pendiente") {
    await admin.from("organizations").update({ plan: "pro" }).eq("id", orgId);
  } else {
    await admin.from("organizations").update({ plan: "trial", trial_ends_at: finPeriodo }).eq("id", orgId);
  }
}
