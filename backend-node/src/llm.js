// Capa de redaccion opcional con Claude (Anthropic). SOLO redacta: recibe
// los hechos YA CALCULADOS y verificados por engine.js (nunca los datos
// crudos), asi que no puede inventar montos ni causas que no existan.
// Si no hay API key configurada, o la llamada falla por cualquier motivo,
// cae automaticamente a las plantillas de nlg.js -- el bot nunca se queda
// sin poder responder por un problema de la API externa.
const Anthropic = require("@anthropic-ai/sdk");
const nlg = require("./nlg");
const { DEFINICIONES } = require("./glosario");

const MODEL = "claude-haiku-4-5-20251001";

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const SYSTEM_PROMPT = `Eres el asistente de facturación de Movistar (Perú). Tu única tarea es redactar, en español simple y empático, una explicación breve de por qué varió el recibo de un cliente.

Reglas estrictas (no negociables):
- Básate EXCLUSIVAMENTE en los hechos que se te dan en el JSON. Nunca inventes ni modifiques montos, fechas o causas que no estén ahí.
- No agregues causas, consejos, ofertas ni información que no venga en el JSON.
- Tono cercano y claro, cero jerga técnica sin explicarla.
- Responde en texto plano, máximo 6 líneas. Puedes usar *texto* (un solo asterisco a cada lado) para resaltar montos importantes.
- No agregues saludos ni despedidas, ve directo a la explicación.`;

async function explicarVariacionLLM(diag) {
  const anthropic = getClient();
  if (!anthropic || !diag.encontrado) {
    return nlg.explicarVariacion(diag);
  }

  const hechos = {
    primer_recibo: !diag.recibo_previo,
    total_actual: diag.total_actual,
    total_previo: diag.total_previo,
    diferencia: diag.diferencia,
    causas: diag.causas.map((c) => ({ tipo: c.tipo, monto: c.monto, detalle: c.detalle })),
  };

  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Hechos verificados del recibo:\n${JSON.stringify(hechos, null, 2)}\n\nRedacta la explicación para el cliente.`,
        },
      ],
    });
    const texto = msg.content?.[0]?.text?.trim();
    if (!texto) throw new Error("Respuesta vacía de Claude");
    return texto;
  } catch (e) {
    console.error("Error llamando a Claude, usando plantillas de respaldo:", e.message);
    return nlg.explicarVariacion(diag);
  }
}

const SALUDO_RESPALDO = "¡Hola! 👋 Soy tu asistente de facturación Movistar. Para comenzar, cuéntame tu número de cuenta.";

const SYSTEM_PROMPT_ONBOARDING = `Eres el asistente virtual de facturación de Movistar (Perú), por WhatsApp. Todavía NO sabes quién es este cliente porque aún no te dio su número de cuenta.

Este asistente SOLO existe para ayudar a clientes que YA TIENEN un servicio Movistar con dudas sobre su recibo/facturación: por qué varió, qué significa un concepto (prorrateo, mora, reconexión, roaming, descuentos, financiamiento), ayudarlos a pagar, o conectarlos con un asesor humano.

NO vendes planes nuevos, NO tienes catálogo de ofertas, NO atiendes a personas que buscan contratar un servicio por primera vez -- eso no es parte de lo que puedes hacer, ni tienes la información para hacerlo bien.

Cómo decidir tu respuesta según lo que te diga el cliente:
1. Si pregunta sobre su recibo/factura, o algo que suena a que ya es cliente → pídele su número de cuenta para ayudarlo.
2. Si dice que NO es cliente, o quiere contratar/comprar una línea o plan nuevo → dile con honestidad y amabilidad que este canal es solo para clientes Movistar con consultas de facturación, y sugiérele contactar al equipo de ventas (tienda Movistar, la web movistar.com.pe, o línea de ventas) para cotizar un plan nuevo. NO le pidas número de cuenta en este caso, porque no tiene uno.
3. Si es un saludo, pregunta sobre ti, o charla genérica → responde natural y breve, y ahí sí invítalo a compartir su número de cuenta si quiere ayuda con su facturación.

Reglas estrictas:
- Responde de forma natural, cálida y breve (1-3 líneas).
- Nunca digas que eres un humano; puedes decir que eres un asistente virtual de Movistar.
- No repitas la misma frase textual que ya usaste antes en la conversación si te preguntan de nuevo -- varía la redacción.
- Nada de emojis excesivos: como mucho uno por mensaje.`;

async function responderOnboarding(mensajeUsuario) {
  const anthropic = getClient();
  if (!anthropic) return SALUDO_RESPALDO;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 220,
      system: SYSTEM_PROMPT_ONBOARDING,
      messages: [{ role: "user", content: mensajeUsuario }],
    });
    const texto = msg.content?.[0]?.text?.trim();
    if (!texto) throw new Error("Respuesta vacía de Claude");
    return texto;
  } catch (e) {
    console.error("Error en onboarding LLM, usando respaldo:", e.message);
    return SALUDO_RESPALDO;
  }
}

const SYSTEM_PROMPT_CONVERSACION = `Eres el asistente conversacional de facturación de Movistar (Perú), hablando con un cliente YA IDENTIFICADO por WhatsApp o la App.

Tienes DOS fuentes de verdad, y SOLO puedes usar esas dos -- nunca inventes ni modifiques un dato que no esté ahí:

1) DATOS DE SU RECIBO (ya calculados y verificados por el sistema, no por ti):
{{HECHOS}}

2) GLOSARIO OFICIAL de conceptos de facturación:
{{GLOSARIO}}
{{BLOQUES_EXTRA}}
Qué puedes hacer por el cliente:
- Explicar por qué varió (o no) su recibo, citando montos y causas EXACTOS de la fuente 1.
- Explicar cualquier concepto de facturación citando la fuente 2.
- Decirle cuánto tiene que pagar (fuente 1) y que puede pagar desde la App con Yape, Plin o tarjeta.
- Si pide un asesor humano, o la consulta claramente no es de facturación (ventas, soporte técnico, reclamos ajenos a este recibo, etc.), decirle que lo vas a conectar con un asesor.
- Responder con naturalidad si te pregunta qué eres o qué puedes hacer.

Reglas estrictas (no negociables):
- NUNCA inventes montos, fechas o causas que no estén en la fuente 1. Si te preguntan algo que esas fuentes no cubren, dilo con honestidad en vez de inventar, y ofrece derivar a un asesor.
- Usa el HISTORIAL de la conversación: no repitas literalmente algo que ya dijiste, y entiende seguimientos como "¿pero por qué?" en base a lo último que hablaron.
- Tono cercano, humano, variado -- nunca estructuras robóticas ni respuestas enlatadas.
- Máximo 5-6 líneas por respuesta. Puedes usar *texto* (un asterisco a cada lado) para resaltar montos importantes.
- No agregues saludos si ya llevan conversación, ve directo al punto.
- Si el cliente parece estar cerrando la conversación (agradece, dice "listo", "ok", "gracias", "de acuerdo", etc.) y en tu ÚLTIMO mensaje (revisa el HISTORIAL) no le preguntaste si necesitaba algo más, NO te despidas todavía: responde con calidez a lo que dijo y pregunta explícitamente algo como "¿Hay algo más en lo que te pueda ayudar?". Solo despídete de verdad (sin volver a preguntar) si el cliente ya te dijo que no cuando se lo preguntaste la vez anterior.`;

const BLOQUE_BENEFICIO = `
DATO ADICIONAL -- BENEFICIO QUE EL CLIENTE YA TIENE INCLUIDO (no es una oferta nueva, ya le pertenece):
{{BENEFICIO}}

El cliente se está despidiendo/agradeciendo AHORA MISMO -- es el momento de cerrar. Responde a su mensaje de cierre con calidez, y agrega UNA frase breve recordándole este beneficio ya incluido (ej. "antes de irte, recuerda que ya tienes incluido X sin costo extra 🙂"). No lo presentes como algo nuevo que le estás ofreciendo -- es algo que ya tiene.
`;

const BLOQUE_DETALLE = `
DATO ADICIONAL -- DETALLE ITEMIZADO DEL RECIBO ACTUAL (cada concepto cobrado, con su monto exacto):
{{DETALLE}}

El cliente pidió ver el detalle/desglose de su recibo. Preséntaselo ordenado (puedes usar una lista con "-"), citando EXACTAMENTE los conceptos y montos de esta fuente -- nunca inventes un concepto que no esté aquí ni lo confundas con las causas de variación.
`;

async function responderConversacion({ diag, historial = [], mensajeUsuario, beneficio = null, detalle = null }) {
  const anthropic = getClient();
  if (!anthropic) {
    return nlg.explicarVariacion(diag);
  }

  const hechos = diag.encontrado
    ? {
        primer_recibo: !diag.recibo_previo,
        total_actual: diag.total_actual,
        total_previo: diag.total_previo,
        diferencia: diag.diferencia,
        causas: diag.causas.map((c) => ({ tipo: c.tipo, monto: c.monto, detalle: c.detalle })),
      }
    : { error: diag.error || "No se encontró información de recibo para esta consulta." };

  // Las decisiones de SI corresponde mostrar cada bloque extra ya las tomo
  // assistant.js de forma deterministica (mensaje de cierre para el
  // beneficio, pedido explicito de detalle para el desglose) -- aca solo
  // los incluimos si nos los pasaron.
  const bloques = [];
  if (beneficio) bloques.push(BLOQUE_BENEFICIO.replace("{{BENEFICIO}}", JSON.stringify(beneficio)));
  if (detalle) bloques.push(BLOQUE_DETALLE.replace("{{DETALLE}}", JSON.stringify(detalle)));

  const systemPrompt = SYSTEM_PROMPT_CONVERSACION
    .replace("{{HECHOS}}", JSON.stringify(hechos, null, 2))
    .replace("{{GLOSARIO}}", JSON.stringify(DEFINICIONES, null, 2))
    .replace("{{BLOQUES_EXTRA}}", bloques.join("\n"));

  const messages = [
    ...historial.slice(-10).map((h) => ({ role: h.role === "bot" ? "assistant" : "user", content: h.content })),
    { role: "user", content: mensajeUsuario },
  ];

  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages,
    });
    const texto = msg.content?.[0]?.text?.trim();
    if (!texto) throw new Error("Respuesta vacía de Claude");
    return texto;
  } catch (e) {
    console.error("Error en conversación LLM, usando plantillas de respaldo:", e.message);
    return nlg.explicarVariacion(diag);
  }
}

module.exports = { explicarVariacionLLM, responderOnboarding, responderConversacion };
