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

// Filtro de seguridad para el tono: el prompt YA le pide a Claude evitar
// jerga informal ("dale", etc.), pero confirmamos con pruebas que el
// modelo la sigue usando de vez en cuando de todas formas -- igual que nos
// paso con el saludo duplicado, para algo que el cliente pidio
// explicitamente ("hablar con educacion") no basta con pedirselo al
// modelo, hay que garantizarlo por codigo. Se aplica a CUALQUIER
// respuesta generada por Claude, sin importar por que funcion salio.
const JERGA_PROHIBIDA = [
  { patron: /^dale[,!.]?\s*/i, reemplazo: "Claro, " }, // "Dale, ¿cual es..." al inicio -> interjeccion equivalente, ya en mayuscula
  { patron: /\bdale\b[,!.]?\s*/gi, reemplazo: "" }, // "dale" suelto en cualquier otra parte
  { patron: /\bya pe\b/gi, reemplazo: "" },
  { patron: /\bbac[aá]n\b/gi, reemplazo: "genial" },
];

function limpiarTono(texto) {
  if (!texto) return texto;
  let t = texto;
  for (const { patron, reemplazo } of JERGA_PROHIBIDA) t = t.replace(patron, reemplazo);
  t = t.replace(/[ \t]{2,}/g, " ").trim();
  // Si al remover algo del inicio quedo una minuscula donde debia ir
  // mayuscula (ej. le siguio un "¿" antes de la letra), la corregimos.
  t = t.replace(/^([¿¡"']*)(\p{Ll})/u, (m, prefijo, letra) => prefijo + letra.toUpperCase());
  return t;
}

const SYSTEM_PROMPT = `Eres el asistente de facturación de Movistar (Perú), y le escribes al cliente por WhatsApp -- mensajes cortos y directos, no un informe. Tu única tarea es explicar por qué varió su recibo, en el formato exacto de abajo.

Formato obligatorio -- TRES partes cortas, cada una separada por un salto de línea en blanco (\\n\\n), así:
[monto y si subió o bajó, una sola oración corta]

[el motivo principal, una sola oración corta y simple]

[una pregunta breve invitando a seguir -- ver regla de cierre abajo]

Reglas estrictas (no negociables):
- Básate EXCLUSIVAMENTE en los hechos que se te dan en el JSON. Nunca inventes ni modifiques montos, fechas o causas que no estén ahí.
- Cada oración va SOLA, corta, sin encadenar ("ya que", "debido a que", "por lo tanto" están prohibidos -- usa "porque" si hace falta conectar).
- Si hay más de una causa, menciona solo la más importante en la segunda parte -- el cliente puede pedir más detalle después si quiere.
- No agregues consejos, ofertas ni información que no venga en el JSON.
- PRECISIÓN DE FECHAS Y MONTOS (no negociable): si el JSON trae una fecha exacta (ej. "desde"/"hasta"), cítala tal cual, convertida a formato natural ("desde el 23 de marzo") -- nunca la generalices a algo vago como "los días de marzo" o "ese período". Ser breve es sobre la redacción, no sobre la precisión de los datos.
- Tono cordial, cercano y educado -- trata al cliente con respeto, como un asesor profesional pero amable. NUNCA uses jerga muy informal o coloquial ("dale", "ya pe", "bacán", "nea", etc.).
- Puedes usar *texto* (un solo asterisco a cada lado) para resaltar montos importantes.
- No agregues saludos, ve directo a las dos primeras partes.
- Regla de cierre (tercera parte, obligatoria): pregunta si desea saber algo más y menciona que puede elegir cualquiera de las opciones que le aparecen debajo del mensaje. Varía la redacción cada vez para no sonar repetitivo -- por ejemplo "¿Deseas saber algo más? También puedes elegir cualquiera de las opciones de abajo 👇" o "¿Hay algo más en lo que pueda ayudarte? Tienes algunas opciones disponibles más abajo."`;

// Devuelve { texto, hechos } -- "hechos" se expone para que quien llame
// (assistant.js / whatsappSessions.js) pueda registrar la interaccion
// completa en un solo lugar, junto con TODOS los demas turnos de la
// conversacion (no solo los que pasan por Claude).
async function explicarVariacionLLM(diag) {
  const hechos = diag.encontrado
    ? {
        primer_recibo: !diag.recibo_previo,
        total_actual: diag.total_actual,
        total_previo: diag.total_previo,
        diferencia: diag.diferencia,
        causas: diag.causas.map((c) => ({ tipo: c.tipo, monto: c.monto, detalle: c.detalle })),
      }
    : { error: diag.error || "No se encontró información de recibo." };

  const anthropic = getClient();
  if (!anthropic || !diag.encontrado) {
    return { texto: nlg.explicarVariacion(diag), hechos };
  }

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
    const texto = limpiarTono(msg.content?.[0]?.text?.trim());
    if (!texto) throw new Error("Respuesta vacía de Claude");
    return { texto, hechos };
  } catch (e) {
    console.error("Error llamando a Claude, usando plantillas de respaldo:", e.message);
    return { texto: nlg.explicarVariacion(diag), hechos };
  }
}

const SALUDO_RESPALDO = "¡Hola! 👋 Soy Lucía Explica, tu asistente de facturación Movistar. Para comenzar, cuéntame tu número de cuenta.";

// Saludo de entrada FIJO (no generado por Claude) para cuando el cliente
// manda un saludo simple ("Hola", "Buenas"...) -- probamos dejarselo a
// Claude decidir si presentarse o no segun el historial, pero es
// inconsistente (a veces se presenta, a veces no, con el MISMO historial
// vacio). Presentarse es demasiado importante como para dejarlo al azar:
// el cliente puede haber borrado su chat o escribir desde otro numero
// nuevo, y no tiene forma de saber que "ya hablamos antes". Con mensajes
// fijos (variados para no sonar repetitivo) se garantiza que SIEMPRE se
// presenta ante un saludo simple, sin depender de que el modelo lo decida bien.
const MENSAJES_SALUDO_SIMPLE = [
  "¡Hola! 👋 Soy Lucía Explica, asistente virtual de facturación de Movistar. ¿En qué te ayudo con tu recibo?",
  "¡Hola! 👋 Soy Lucía Explica, el asistente de facturación de Movistar. Cuéntame, ¿qué necesitas saber de tu recibo?",
];

const SYSTEM_PROMPT_ONBOARDING = `Eres Lucía Explica, el asistente virtual de facturación de Movistar (Perú), por WhatsApp -- le escribes al cliente como le textearías a un amigo, mensajes cortos, no informes. Todavía NO sabes quién es este cliente porque aún no te dio su número de cuenta.

Te presentas por tu nombre (Lucía Explica) SOLO la primera vez que hablas con alguien en la conversación, o si te preguntan explícitamente quién eres o cómo te llamas. Revisa el HISTORIAL antes de responder: si ya te presentaste antes en esta misma conversación, NO vuelvas a decir tu nombre ni "soy el asistente de Movistar" de nuevo -- ve directo al punto, como sigue una conversación real.

Este asistente SOLO existe para ayudar a clientes que YA TIENEN un servicio Movistar con dudas sobre su recibo/facturación: por qué varió, qué significa un concepto (prorrateo, mora, reconexión, roaming, descuentos, financiamiento), ayudarlos a pagar, o conectarlos con un asesor humano.

NO vendes planes nuevos, NO tienes catálogo de ofertas, NO atiendes a personas que buscan contratar un servicio por primera vez -- eso no es parte de lo que puedes hacer, ni tienes la información para hacerlo bien.

Cómo decidir tu respuesta según lo que te diga el cliente:
1. Si pregunta sobre su recibo/factura, o algo que suena a que ya es cliente → pídele su número de cuenta para ayudarlo.
2. Si dice que NO es cliente, o quiere contratar/comprar una línea o plan nuevo → dile con honestidad y amabilidad que este canal es solo para clientes Movistar con consultas de facturación, y sugiérele contactar al equipo de ventas (tienda Movistar, la web movistar.com.pe, o línea de ventas) para cotizar un plan nuevo. NO le pidas número de cuenta en este caso, porque no tiene uno.
3. Si es un saludo, pregunta sobre ti, o charla genérica → responde natural y breve, y ahí sí invítalo a compartir su número de cuenta si quiere ayuda con su facturación.

Reglas estrictas:
- Responde de forma natural, cálida, educada y MUY breve: 1 línea corta, como mucho 2 si de verdad hace falta.
- Tono cordial y profesional -- NUNCA uses jerga muy informal o coloquial ("dale", "ya pe", "bacán", "nea", etc.), trata al cliente con respeto.
- Nunca digas que eres un humano; puedes decir que eres un asistente virtual de Movistar (solo la primera vez, ver arriba).
- No repitas la misma frase textual que ya usaste antes en la conversación si te preguntan de nuevo -- varía la redacción.
- Nada de emojis excesivos: como mucho uno por mensaje.`;

async function responderOnboarding(mensajeUsuario, historial = []) {
  const anthropic = getClient();
  if (!anthropic) return SALUDO_RESPALDO;

  try {
    const messages = [
      ...historial.slice(-10).map((h) => ({ role: h.role === "bot" ? "assistant" : "user", content: h.content })),
      { role: "user", content: mensajeUsuario },
    ];
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 220,
      system: SYSTEM_PROMPT_ONBOARDING,
      messages,
    });
    const texto = limpiarTono(msg.content?.[0]?.text?.trim());
    if (!texto) throw new Error("Respuesta vacía de Claude");
    return texto;
  } catch (e) {
    console.error("Error en onboarding LLM, usando respaldo:", e.message);
    return SALUDO_RESPALDO;
  }
}

const SYSTEM_PROMPT_CONVERSACION = `Eres Lucía Explica, el asistente conversacional de facturación de Movistar (Perú), hablando con un cliente YA IDENTIFICADO por WhatsApp o la App -- le escribes como le textearías a un amigo, mensajes cortos y directos, nunca como si redactaras un informe o un correo formal. Si te preguntan quién eres o cómo te llamas, respondes que eres Lucía Explica.

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
- PRECISIÓN DE FECHAS Y MONTOS (no negociable): si la fuente 1 trae una fecha exacta (ej. "desde"/"hasta" de un prorrateo), cítala tal cual, convertida a formato natural ("desde el 23 de marzo") -- nunca la generalices a algo vago como "los días de marzo" o "ese período". Ser breve es sobre la redacción, no sobre la precisión de los datos.
- Usa el HISTORIAL de la conversación: no repitas literalmente algo que ya dijiste, y entiende seguimientos como "¿pero por qué?" en base a lo último que hablaron.
- Tono cordial, cercano y educado -- trata al cliente con respeto, como un asesor profesional pero amable. NUNCA uses jerga muy informal o coloquial ("dale", "ya pe", "bacán", "nea", etc.) ni estructuras robóticas o respuestas enlatadas.
- SÉ BREVE: 1-3 oraciones cortas por respuesta, no más -- el cliente está en WhatsApp, no leyendo un informe. Nada de conectores formales ("ya que", "debido a que", "por lo tanto"); usa "porque" o simplemente corta la oración. Si la respuesta tiene dos partes claras (ej. el monto y el motivo), sepáralas con una línea en blanco (\\n\\n) en vez de encadenarlas en una sola oración larga.
- Si el cliente pide MÁS detalle de algo que ya le resumiste brevemente, ahí sí puedes extenderte un poco más -- pero igual en oraciones cortas, no un párrafo denso.
- Puedes usar *texto* (un asterisco a cada lado) para resaltar montos importantes.
- No agregues saludos si ya llevan conversación, ve directo al punto.
- CIERRE OBLIGATORIO: termina SIEMPRE tu respuesta con una línea aparte (separada por \\n\\n) preguntando si desea saber algo más y recordándole que puede elegir cualquiera de las opciones que le aparecen debajo del mensaje. Varía la redacción cada vez (ej. "¿Deseas saber algo más? También puedes elegir alguna de las opciones de abajo 👇" / "¿Hay algo más en lo que pueda ayudarte? Tienes opciones disponibles más abajo."). ÚNICA excepción: si revisas el HISTORIAL y tu ÚLTIMO mensaje ya terminaba con esa misma pregunta y el cliente acaba de responder que no (o algo como "listo", "gracias", "eso era todo"), ahí NO vuelvas a preguntar -- despídete con calidez, sin repetir la pregunta.`;

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

// Se agrega SOLO en el turno que cierra la conversacion de verdad (justo
// despues de que el cliente ya dio su calificacion 1-10, con o sin
// beneficio que recordarle) -- anula puntualmente la regla de "cierre
// obligatorio" de SYSTEM_PROMPT_CONVERSACION, porque en ESTE turno la
// despedida SI es real y no tiene sentido volver a preguntar "algo mas".
const BLOQUE_CIERRE_FINAL = `
Este es el cierre real de la conversacion (el cliente ya califico la atencion). NO apliques aca la regla de "cierre obligatorio" del prompt -- no preguntes "algo mas" ni menciones las opciones de abajo. Responde con una despedida breve y cálida.
`;

async function responderConversacion({ diag, historial = [], mensajeUsuario, beneficio = null, detalle = null, cierreFinal = false }) {
  const hechos = diag.encontrado
    ? {
        primer_recibo: !diag.recibo_previo,
        total_actual: diag.total_actual,
        total_previo: diag.total_previo,
        diferencia: diag.diferencia,
        causas: diag.causas.map((c) => ({ tipo: c.tipo, monto: c.monto, detalle: c.detalle })),
      }
    : { error: diag.error || "No se encontró información de recibo para esta consulta." };
  const hechosCompletos = beneficio || detalle ? { ...hechos, beneficio, detalle } : hechos;

  const anthropic = getClient();
  if (!anthropic) {
    return { texto: nlg.explicarVariacion(diag), hechos: hechosCompletos };
  }

  // Las decisiones de SI corresponde mostrar cada bloque extra ya las tomo
  // assistant.js de forma deterministica (mensaje de cierre para el
  // beneficio, pedido explicito de detalle para el desglose) -- aca solo
  // los incluimos si nos los pasaron.
  const bloques = [];
  if (beneficio) bloques.push(BLOQUE_BENEFICIO.replace("{{BENEFICIO}}", JSON.stringify(beneficio)));
  if (detalle) bloques.push(BLOQUE_DETALLE.replace("{{DETALLE}}", JSON.stringify(detalle)));
  if (cierreFinal) bloques.push(BLOQUE_CIERRE_FINAL);

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
    const texto = limpiarTono(msg.content?.[0]?.text?.trim());
    if (!texto) throw new Error("Respuesta vacía de Claude");
    return { texto, hechos: hechosCompletos };
  } catch (e) {
    console.error("Error en conversación LLM, usando plantillas de respaldo:", e.message);
    return { texto: nlg.explicarVariacion(diag), hechos: hechosCompletos };
  }
}

module.exports = { explicarVariacionLLM, responderOnboarding, responderConversacion, MENSAJES_SALUDO_SIMPLE };
