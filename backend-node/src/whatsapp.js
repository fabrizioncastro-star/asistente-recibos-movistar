// Integracion con WhatsApp Cloud API (Meta): verificacion de webhook,
// recepcion de mensajes entrantes y envio de respuestas.
const express = require("express");
const crypto = require("crypto");
const whatsappSessions = require("./whatsappSessions");

const router = express.Router();

// Verifica que el POST realmente venga de Meta, comparando la firma
// X-Hub-Signature-256 (HMAC-SHA256 del body crudo con el App Secret) --
// sin esto, cualquiera podria mandar mensajes falsos a nuestro webhook.
function verificarFirmaMeta(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return { verificado: false, ok: true }; // sin secret configurado: se deja pasar, pero queda advertido en el arranque
  const firma = req.headers["x-hub-signature-256"];
  if (!firma || !req.rawBody) return { verificado: true, ok: false };
  const esperado = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  const a = Buffer.from(firma);
  const b = Buffer.from(esperado);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { verificado: true, ok };
}

const GRAPH_VERSION = "v21.0";

function aFormatoWhatsapp(texto) {
  // Nuestro nlg.js usa **negrita** al estilo markdown; WhatsApp usa *negrita*
  // (un solo asterisco) y no soporta listas con "- ", así que las
  // convertimos a bullets simples.
  return texto
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^- /gm, "• ");
}

// Mismas "siguientes acciones" que ofrece la web como botones -- aca se
// traducen a una lista interactiva nativa de WhatsApp (el boton
// "Opciones" que abre una cinta de alternativas, igual a como lo hace el
// bot real de Movistar). Cada fila, al tocarla, le llega al webhook como
// si el cliente hubiese escrito el "mensaje" asociado.
const OPCIONES_WHATSAPP = {
  ver_detalle: { titulo: "📋 Ver detalle", desc: "Desglose de tu recibo actual", mensaje: "ver el detalle de mi recibo" },
  ver_recibos_anteriores: { titulo: "📜 Recibos anteriores", desc: "Ver tus últimos recibos", mensaje: "quiero ver mis recibos anteriores" },
  registrar_consulta: { titulo: "📝 Registrar consulta", desc: "Deja constancia con un folio", mensaje: "quiero registrar mi consulta" },
  pagar: { titulo: "💳 Pagar", desc: "Ver tu monto y cómo pagar", mensaje: "quiero pagar" },
  hablar_con_asesor: { titulo: "🧑 Hablar con asesor", desc: "Te derivamos con contexto", mensaje: "hablar con un asesor" },
};

function construirPayloadMensaje(to, texto, acciones = []) {
  const cuerpo = aFormatoWhatsapp(texto);
  const filas = (acciones || [])
    .filter((a) => OPCIONES_WHATSAPP[a])
    .map((a) => ({ id: a, title: OPCIONES_WHATSAPP[a].titulo, description: OPCIONES_WHATSAPP[a].desc }));

  if (!filas.length) {
    return {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: cuerpo, preview_url: false },
    };
  }

  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: cuerpo },
      action: { button: "Opciones", sections: [{ title: "¿Qué necesitas?", rows: filas }] },
    },
  };
}

// Manda la respuesta en varios mensajitos seguidos en vez de un solo bloque
// de texto -- se ve mas como una persona texteando (los prompts de llm.js
// separan las ideas con una linea en blanco a proposito para esto) y es
// mas facil de leer en el celular. Tope de 3 mensajes: si Claude se
// explaya de mas, los ultimos parrafos se juntan en el ultimo envio para
// no saturar el chat de burbujas.
const MAX_PARTES_WHATSAPP = 3;
const PAUSA_ENTRE_PARTES_MS = 700;

async function enviarRespuestaWhatsapp(to, texto, acciones = []) {
  let partes = texto.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (partes.length > MAX_PARTES_WHATSAPP) {
    partes = [...partes.slice(0, MAX_PARTES_WHATSAPP - 1), partes.slice(MAX_PARTES_WHATSAPP - 1).join("\n\n")];
  }
  if (!partes.length) partes = [texto];

  for (let i = 0; i < partes.length; i++) {
    const esUltima = i === partes.length - 1;
    await enviarMensajeWhatsapp(to, partes[i], esUltima ? acciones : []);
    if (!esUltima) await new Promise((r) => setTimeout(r, PAUSA_ENTRE_PARTES_MS));
  }
}

async function enviarMensajeWhatsapp(to, texto, acciones = []) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(construirPayloadMensaje(to, texto, acciones)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Error enviando mensaje de WhatsApp:", JSON.stringify(data));
  }
  return data;
}

// Verificacion del webhook (Meta hace un GET una sola vez, al configurar la URL)
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook de WhatsApp verificado correctamente.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Mensajes entrantes
router.post("/webhook", (req, res) => {
  const { verificado, ok } = verificarFirmaMeta(req);
  if (verificado && !ok) {
    console.warn("Webhook de WhatsApp: firma invalida, request rechazado.");
    return res.sendStatus(401);
  }

  // Respondemos 200 de inmediato: Meta espera un ack rapido y reintenta si no lo hay.
  res.sendStatus(200);

  (async () => {
    try {
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const message = value?.messages?.[0];
      if (!message) return; // notificaciones de estado (entregado/leido), no son mensajes

      const waId = message.from;

      // Texto libre, o seleccion de una fila de la lista de opciones (le
      // llega como interactive.list_reply, no como texto).
      let texto = message.text?.body || "";
      if (!texto && message.interactive?.list_reply) {
        const opcion = OPCIONES_WHATSAPP[message.interactive.list_reply.id];
        texto = opcion ? opcion.mensaje : message.interactive.list_reply.title || "";
      }
      if (!texto) return; // por ahora no manejamos audio/imagenes/etc.

      const { respuesta, acciones, saludoAgente } = await whatsappSessions.manejarMensaje(waId, texto);
      await enviarRespuestaWhatsapp(waId, respuesta, acciones);
      // El "agente" manda su saludo un instante despues, como si recien se
      // hubiera unido al chat -- mismo texto que ya quedo registrado en
      // interacciones_log, asi el panel interno y el cliente ven lo mismo.
      if (saludoAgente) {
        setTimeout(() => {
          enviarMensajeWhatsapp(waId, saludoAgente).catch((e) =>
            console.error(`Error enviando saludo de agente a ${waId}:`, e)
          );
        }, 1800);
      }
    } catch (e) {
      console.error("Error procesando mensaje entrante de WhatsApp:", e);
    }
  })();
});

// Revisa cada cierto tiempo si hay sesiones inactivas y, si las hay, el bot
// se despide por su cuenta (mensaje armado por whatsappSessions, que incluye
// el "Efecto Efervescente" si aun no se le mostro) -- asi el cliente no se
// queda "colgado" en un estado a medias si dejo de responder.
function iniciarMonitorInactividad(intervaloMs = 60_000) {
  setInterval(async () => {
    let inactivos = [];
    try {
      inactivos = whatsappSessions.sesionesInactivas();
    } catch (e) {
      console.error("Error revisando sesiones inactivas:", e);
      return;
    }
    for (const waId of inactivos) {
      whatsappSessions.marcarAvisoInactividadEnviado(waId);
      try {
        const { despedida, promo } = await whatsappSessions.cerrarPorInactividad(waId);
        await enviarMensajeWhatsapp(waId, despedida);
        if (promo) await enviarMensajeWhatsapp(waId, promo);
      } catch (e) {
        console.error(`Error avisando inactividad a ${waId}:`, e);
      }
    }
  }, intervaloMs);
}

module.exports = { router, enviarMensajeWhatsapp, iniciarMonitorInactividad };
