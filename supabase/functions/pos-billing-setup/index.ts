// Configuración inicial de Stripe para POS Mostrador (se corre una vez por
// modo: prueba y real). Crea, sin duplicar, en la cuenta de STRIPE_SECRET_KEY:
//   - un producto por plan pago (pos_mostrador, pos_negocio, pos_cadena)
//   - por país: el precio mensual, el anual (si el plan lo tiene) y el cupón
//     de bienvenida (promo de los primeros meses o descuento del primer mes)
// y guarda los ids en pos_planes_precios. También revisa que existan el
// webhook y el portal de clientes.
//
// Protegida con un token de un solo uso guardado en pos_billing_setup_tokens
// (se crea desde SQL); el cuerpo de la respuesta no incluye ninguna clave.
import Stripe from "npm:stripe@17.7.0";
import { adminClient, json, stripe } from "../_shared/billing.ts";

// Monedas sin decimales en Stripe (el monto va en unidades, no en centavos).
const SIN_DECIMALES = new Set(["CLP", "JPY", "KRW", "VND", "PYG", "XAF", "XOF"]);
const NOMBRES: Record<string, string> = { mostrador: "Mostrador", negocio: "Negocio", cadena: "Cadena" };

const centavos = (monto: number, moneda: string) =>
  Math.round(Number(monto) * (SIN_DECIMALES.has(moneda.toUpperCase()) ? 1 : 100));

async function producto(planId: string, modo: string) {
  const id = `pos_${planId}`;
  try {
    return await stripe.products.retrieve(id);
  } catch {
    return await stripe.products.create({
      id,
      name: `POS Mostrador · ${NOMBRES[planId] ?? planId}`,
      description: "Punto de venta para almacenes, kioscos y ferreterías.",
      metadata: { plan_id: planId, modo },
    });
  }
}

async function precio(productId: string, lookupKey: string, monto: number, moneda: string, intervalo: "month" | "year", meta: Record<string, string>) {
  const existentes = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const unit = centavos(monto, moneda);
  const actual = existentes.data[0];
  if (actual && actual.unit_amount === unit && actual.currency === moneda.toLowerCase() && actual.recurring?.interval === intervalo) {
    return actual.id;
  }
  const nuevo = await stripe.prices.create({
    product: productId,
    currency: moneda.toLowerCase(),
    unit_amount: unit,
    recurring: { interval: intervalo },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    metadata: meta,
  });
  return nuevo.id;
}

async function cupon(id: string, montoOff: number, moneda: string, meses: number | null, nombre: string) {
  try {
    const c = await stripe.coupons.retrieve(id);
    if (c.amount_off === centavos(montoOff, moneda) && c.currency === moneda.toLowerCase()) return c.id;
    // El monto cambió: los cupones no se editan, se crea uno con sufijo.
    id = `${id}_${Date.now()}`;
  } catch { /* no existe */ }
  const c = await stripe.coupons.create({
    id,
    name: nombre,
    amount_off: centavos(montoOff, moneda),
    currency: moneda.toLowerCase(),
    duration: meses && meses > 1 ? "repeating" : "once",
    duration_in_months: meses && meses > 1 ? meses : undefined,
  });
  return c.id;
}

Deno.serve(async (req) => {
  const admin = adminClient();
  const token = req.headers.get("x-setup-token") ?? "";
  if (!token) return json({ error: "Falta el token" }, 401);
  const { data: fila } = await admin.from("pos_billing_setup_tokens")
    .select("token, usado_at").eq("token", token).maybeSingle();
  if (!fila || fila.usado_at) return json({ error: "Token inválido o ya usado" }, 401);
  await admin.from("pos_billing_setup_tokens").update({ usado_at: new Date().toISOString() }).eq("token", token);

  const clave = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!clave) return json({ error: "Falta STRIPE_SECRET_KEY en los secrets de Supabase" }, 500);
  const modo = clave.startsWith("sk_live_") || clave.startsWith("rk_live_") ? "real" : "prueba";

  const informe: Record<string, unknown> = { modo };
  try {
    const cuenta = await stripe.accounts.retrieve();
    informe.cuenta = { pais: cuenta.country, moneda: cuenta.default_currency, cobros_habilitados: cuenta.charges_enabled, nombre: cuenta.settings?.dashboard?.display_name ?? null };

    const { data: filas, error } = await admin.from("pos_planes_precios")
      .select("plan_id, pais, moneda, precio_mensual, precio_primer_mes, precio_promo, meses_promo, precio_anual")
      .gt("precio_mensual", 0);
    if (error) throw error;

    const productos: Record<string, Stripe.Product> = {};
    const resultado: unknown[] = [];
    for (const f of filas ?? []) {
      const plan = f.plan_id as string, pais = f.pais as string, moneda = f.moneda as string;
      productos[plan] ??= await producto(plan, modo);
      const prod = productos[plan];
      const base = `pos_${plan}_${pais.toLowerCase()}`;
      const meta = { plan_id: plan, pais };

      const mensual = await precio(prod.id, `${base}_mensual`, Number(f.precio_mensual), moneda, "month", { ...meta, periodo: "mensual" });
      const anual = f.precio_anual ? await precio(prod.id, `${base}_anual`, Number(f.precio_anual), moneda, "year", { ...meta, periodo: "anual" }) : null;

      let cuponId: string | null = null;
      if (f.precio_promo && f.meses_promo) {
        cuponId = await cupon(`${base}_promo`, Number(f.precio_mensual) - Number(f.precio_promo), moneda, Number(f.meses_promo),
          `Promo ${NOMBRES[plan]}: ${f.meses_promo} meses`);
      } else if (f.precio_primer_mes) {
        cuponId = await cupon(`${base}_primer_mes`, Number(f.precio_mensual) - Number(f.precio_primer_mes), moneda, 1,
          `${NOMBRES[plan]}: primer mes`);
      }

      const { error: e2 } = await admin.from("pos_planes_precios")
        .update({ stripe_price_id: mensual, stripe_price_id_anual: anual, stripe_coupon_promo: cuponId })
        .eq("plan_id", plan).eq("pais", pais);
      if (e2) throw e2;
      resultado.push({ plan, pais, moneda, mensual, anual, cupon: cuponId });
    }
    informe.precios = resultado;

    // El portal y el webhook los configura el dueño en Stripe: solo se revisan.
    const webhooks = await stripe.webhookEndpoints.list({ limit: 100 });
    const wh = webhooks.data.find((w) => w.url.includes("/functions/v1/pos-billing-webhook"));
    informe.webhook = wh ? { estado: wh.status, eventos: wh.enabled_events, version: wh.api_version } : "no encontrado";
    const portales = await stripe.billingPortal.configurations.list({ limit: 10, is_default: true });
    informe.portal = portales.data[0] ? { activo: portales.data[0].active, cancelar: portales.data[0].features.subscription_cancel.enabled, medio_de_pago: portales.data[0].features.payment_method_update.enabled } : "sin configurar";

    return json(informe);
  } catch (e) {
    console.error("pos-billing-setup:", e);
    return json({ ...informe, error: (e as Error).message }, 500);
  }
});
