// Orquestador conversacional. Solo se detectan por palabras clave, de
// forma deterministica, las cosas que son ACCIONES de sistema (disparan
// consultas reales a la BD, no solo texto libre): cambiar de linea,
// derivar a asesor/pago, ver recibos anteriores, ver detalle y registrar
// la consulta -- las 5 "siguientes acciones" que pide la ficha del
// Desafio 1. Todo lo demas -- la conversacion real -- se lo pasamos a
// Claude (llm.responderConversacion) junto con los hechos del recibo, el
// glosario, el historial y, cuando corresponde, un beneficio destacado o
// el detalle itemizado, para que entienda de verdad lo que se le pregunta.
//
// Registro de conversaciones: CADA turno que pasa por aca (haya usado
// Claude o no) queda guardado via engine.registrarInteraccion, para que
// el panel interno pueda mostrar el hilo completo de cada cliente, no
// solo los mensajes donde intervino la IA.
const engine = require("./engine");
const nlg = require("./nlg");
const llm = require("./llm");
const agentes = require("./agentes");

const PALABRAS_ASESOR = ["asesor", "humano", "persona", "agente", "hablar con alguien", "representante"];
const PALABRAS_PAGAR = ["pagar", "como pago", "donde pago", "quiero pagar"];
const PALABRAS_CAMBIAR_LINEA = ["otra linea", "otro servicio", "mis lineas", "mis servicios", "cambiar de linea", "ver mis lineas"];
const PALABRAS_RECIBOS_ANTERIORES = [
  "recibos anteriores", "recibo anterior", "otros recibos", "historial de recibos",
  "recibos pasados", "meses anteriores", "ver mis recibos", "recibo de otro mes", "recibos previos",
];
const PALABRAS_DETALLE = [
  "ver el detalle", "el detalle de mi recibo", "ver detalle", "desglose", "detalle completo",
  "que me estan cobrando", "que conceptos", "detalle de mi recibo", "ver mis cargos",
];
const PALABRAS_REGISTRAR_CONSULTA = [
  "registrar mi consulta", "dejar constancia", "quiero un ticket", "registrar esta consulta",
  "registrar mi reclamo", "quiero que quede registrado", "registrar consulta",
];
// Para el registro de satisfaccion / "tasa de silencio post-explicacion" (pedido de la ficha):
const PALABRAS_CIERRE = ["gracias", "listo", "perfecto", "entendido", "ok gracias", "eso es todo", "nada mas", "de acuerdo", "muy bien"];
// Para el "Efecto Efervescente" (mas estricto que PALABRAS_CIERRE): solo
// cuenta como cierre real si el bot ACABA de preguntar "algo mas?" y el
// cliente responde que no -- no cualquier "gracias" a mitad de conversacion.
const PATRONES_BOT_PREGUNTO_ALGO_MAS = ["algo mas", "algo especifico", "necesitas algo", "puedo ayudarte", "en que mas", "algo en lo que"];
const PALABRAS_NEGACION_CIERRE = ["no gracias", "no, gracias", "no nada mas", "no nada más", "nada mas", "eso es todo", "no por ahora", "no necesito", "no eso seria todo", "no era todo"];
// Marca de texto (busqueda literal, no normalizada) que deja el bot cuando
// lista los recibos anteriores -- asi sabemos si el siguiente mensaje es
// una seleccion por numero/posicion (que solo tiene sentido justo despues).
const MARCA_LISTADO_RECIBOS = "cual quieres que te explique";

// Mismo patron para la calificacion: marca literal y fija (mensaje
// deterministico, no redactado por Claude) para poder detectar con certeza,
// en el turno SIGUIENTE, que lo que sigue es la respuesta a "califica del 1
// al 10" y no un mensaje cualquiera. Si fuera un mensaje de Claude (variable)
// no podriamos anclar la deteccion de forma confiable. Escala 1-10 (no 1-5)
// a proposito, para alinearla con el estilo NPS que usa la ficha.
const MARCA_PEDIR_CALIFICACION = "calificarias esta atencion";
const MENSAJES_PEDIR_CALIFICACION = [
  "¡Genial! Antes de despedirme, ¿del 1 al 10 cómo calificarías esta atención?",
  "¡De nada! Una última cosa: ¿del 1 al 10 cómo calificarías esta atención?",
];

// Si la nota es menor a 10, pedimos una observacion puntual de que se podria
// mejorar -- misma logica de marca fija para detectar la respuesta en el
// turno siguiente sin ambiguedad.
const MARCA_PEDIR_MEJORA = "que podriamos mejorar";
const MENSAJES_PEDIR_MEJORA = [
  "Gracias por la sinceridad. ¿Qué podríamos mejorar para que la próxima vez sea un 10?",
  "Entendido, gracias. ¿Hay algo puntual que podríamos mejorar?",
];

const MESES_LARGO = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

function formatearMes(fechaIso) {
  if (!fechaIso) return "fecha no disponible";
  const [y, m] = fechaIso.split("-");
  return `${MESES_LARGO[Number(m) - 1]} ${y}`;
}

function botPreguntoSiAlgoMas(historial) {
  const ultimoBot = [...historial].reverse().find((h) => h.role === "bot");
  if (!ultimoBot) return false;
  return contieneAlguna(normalizar(ultimoBot.content), PATRONES_BOT_PREGUNTO_ALGO_MAS);
}

function botMostroListaRecibos(historial) {
  const ultimoBot = [...historial].reverse().find((h) => h.role === "bot");
  if (!ultimoBot) return false;
  return normalizar(ultimoBot.content).includes(MARCA_LISTADO_RECIBOS);
}

function botPidioCalificacion(historial) {
  const ultimoBot = [...historial].reverse().find((h) => h.role === "bot");
  if (!ultimoBot) return false;
  return normalizar(ultimoBot.content).includes(MARCA_PEDIR_CALIFICACION);
}

function botPidioMejora(historial) {
  const ultimoBot = [...historial].reverse().find((h) => h.role === "bot");
  if (!ultimoBot) return false;
  return normalizar(ultimoBot.content).includes(MARCA_PEDIR_MEJORA);
}

// Busca, dentro del historial, la nota 1-10 que el cliente dio cuando el
// bot le pregunto "calificarias esta atencion" -- se usa en el turno de
// "que podriamos mejorar" (que llega DESPUES, en un turno separado) para
// saber si esa calificacion fue positiva o no. null si no se encuentra.
function obtenerCalificacionOriginal(historial) {
  for (let i = historial.length - 1; i >= 0; i--) {
    const h = historial[i];
    if (h.role === "bot" && normalizar(h.content).includes(MARCA_PEDIR_CALIFICACION)) {
      const siguiente = historial[i + 1];
      return siguiente && siguiente.role === "user" ? parseCalificacion(siguiente.content) : null;
    }
  }
  return null;
}

// Acepta un digito 1-10 solo, o dentro de una frase corta ("le doy un 8", "9
// de 10"). "10" se busca antes que los digitos sueltos para no matchear
// solo el "1" de "10". No intenta interpretar palabras ("excelente", "mala")
// para mantener el parseo simple y sin ambiguedad.
function parseCalificacion(texto) {
  const m = texto.match(/\b(10|[1-9])\b/);
  return m ? Number(m[1]) : null;
}

function esNegacionCierre(texto) {
  const t = texto.trim();
  if (/^no\.?$/i.test(t)) return true; // el usuario escribio solo "no"
  return contieneAlguna(t, PALABRAS_NEGACION_CIERRE);
}

function normalizar(texto) {
  return texto
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function contieneAlguna(texto, palabras) {
  return palabras.some((p) => texto.includes(p));
}

// Antes de mostrar el beneficio ("Efecto Efervescente") verificamos que el
// ciclo completo "bot pregunta algo mas -> cliente dice que no" no se haya
// completado YA antes en esta conversacion -- asi evitamos mostrarlo de
// nuevo si el cliente vuelve a decir que no mas adelante. OJO: no basta con
// buscar un "gracias" suelto en el historial, porque el propio "gracias"
// que dispara la pregunta "algo mas?" tambien contendria esa palabra --
// hay que verificar el PAR completo (pregunta + negacion), no solo un lado.
function yaHuboCierreEfectivo(historial) {
  for (let i = 0; i < historial.length - 1; i++) {
    const turno = historial[i];
    if (turno.role !== "bot" || !contieneAlguna(normalizar(turno.content), PATRONES_BOT_PREGUNTO_ALGO_MAS)) continue;
    const siguiente = historial[i + 1];
    if (siguiente && siguiente.role === "user" && esNegacionCierre(siguiente.content)) return true;
  }
  return false;
}

// Misma forma de "hechos" que arma llm.js internamente, para las
// respuestas deterministicas (sin Claude) que igual tienen un diagnostico
// detras (asesor, pagar, registrar consulta) -- asi el panel interno puede
// auditarlas tambien, no solo las que redacta la IA.
function hechosDesdeDiagnostico(diag) {
  if (!diag) return null;
  return diag.encontrado
    ? {
        primer_recibo: !diag.recibo_previo,
        total_actual: diag.total_actual,
        total_previo: diag.total_previo,
        diferencia: diag.diferencia,
        causas: diag.causas.map((c) => ({ tipo: c.tipo, monto: c.monto, detalle: c.detalle })),
      }
    : { error: diag.error || "No se encontró información de recibo." };
}

// Punto UNICO de registro de cada turno (haya pasado por Claude o no), para
// que el panel interno muestre el hilo completo de la conversacion.
function registrar(cuenta, canal, telefono, hechos, respuesta, mensajeUsuario) {
  engine.registrarInteraccion(cuenta, canal, hechos, respuesta, mensajeUsuario, telefono).catch(() => {});
}

async function responder(cuenta, mensaje, recibo = null, linea = null, historial = [], canal = "web", telefono = null) {
  const texto = normalizar(mensaje);

  if (!cuenta) {
    return { respuesta: "Primero necesito identificar tu cuenta para poder revisar tu recibo.", acciones: [] };
  }

  if (contieneAlguna(texto, PALABRAS_CAMBIAR_LINEA)) {
    const lineas = await engine.buscarCuenta(cuenta);
    let respuesta;
    if (lineas && lineas.length > 1) {
      const listado = lineas.map((l) => `- **${l.etiqueta}** (línea •••${String(l.anexo).slice(-4)})`).join("\n");
      respuesta = `Tu cuenta tiene estos servicios:\n\n${listado}\n\n¿Sobre cuál quieres consultar?`;
    } else {
      respuesta = "Tu cuenta tiene un solo servicio, así que ya estamos viendo el correcto. 🙂";
    }
    registrar(cuenta, canal, telefono, null, respuesta, mensaje);
    return { respuesta, acciones: [] };
  }

  if (contieneAlguna(texto, PALABRAS_ASESOR)) {
    const diag = await engine.diagnosticar(cuenta, recibo, linea);
    const contexto = nlg.resumenParaAsesor(diag);
    const agente = agentes.elegirAgente();
    engine.registrarSatisfaccion(cuenta, canal, "insatisfecho", "solicito hablar con un asesor").catch(() => {});
    engine.registrarDerivacion(cuenta, canal, telefono, agente.nombre, agente.area, contexto).catch(() => {});
    const respuesta =
      `Listo, te conecto con ${agente.avatar} **${agente.nombre}** (${agente.area}). ` +
      "Ya le compartí el contexto de tu consulta (tu recibo, el anterior, y la causa detectada) " +
      "para que no tengas que repetir todo.";
    registrar(cuenta, canal, telefono, hechosDesdeDiagnostico(diag), respuesta, mensaje);
    // Saludo de entrada del agente "fake" -- se guarda como una interaccion
    // aparte (sin mensaje del cliente ni hechos, es un mensaje automatico
    // de la simulacion) para que quede visible en el hilo completo desde
    // "Ver conversacion" en el panel interno, y el frontend lo muestra como
    // una burbuja separada un instante despues de la tarjeta de derivacion.
    const saludoAgente = `Hola, soy ${agente.nombre}, te voy a ayudar 😊`;
    registrar(cuenta, canal, telefono, null, saludoAgente, null);
    return {
      respuesta,
      acciones: ["derivar_asesor"],
      contexto_asesor: contexto,
      satisfaccion: "insatisfecho",
      agente,
      saludo_agente: saludoAgente,
    };
  }

  if (contieneAlguna(texto, PALABRAS_PAGAR)) {
    const diag = await engine.diagnosticar(cuenta, recibo, linea);
    const respuesta = diag.encontrado
      ? `Tu monto a pagar de este ciclo es **${"S/ " + diag.total_actual.toFixed(2)}**. Puedes pagarlo desde esta misma App con Yape, Plin o tarjeta.`
      : diag.error || "No encontré tu recibo para procesar el pago.";
    registrar(cuenta, canal, telefono, hechosDesdeDiagnostico(diag), respuesta, mensaje);
    return { respuesta, acciones: diag.encontrado ? ["ir_a_pagar"] : [] };
  }

  // "Registrar la consulta": accion explicita de la ficha, junto a
  // pagar/revisar detalle/derivar a asesor. Deja un folio real en BD.
  if (contieneAlguna(texto, PALABRAS_REGISTRAR_CONSULTA)) {
    const diag = await engine.diagnosticar(cuenta, recibo, linea);
    const resumen = nlg.resumenParaAsesor(diag);
    const folio = await engine.registrarConsulta(cuenta, canal, resumen);
    const respuesta = `Listo, dejé registrada tu consulta con el folio **#${folio}**. Si más adelante hablas con un asesor, ya va a tener este contexto disponible sin que tengas que repetirlo.`;
    registrar(cuenta, canal, telefono, hechosDesdeDiagnostico(diag), respuesta, mensaje);
    return { respuesta, acciones: [] };
  }

  // "Revisar el detalle": a diferencia de las causas (solo lo que VARIO),
  // esto trae CADA concepto cobrado en el recibo actual.
  if (contieneAlguna(texto, PALABRAS_DETALLE)) {
    const diag = await engine.diagnosticar(cuenta, recibo, linea);
    if (!diag.encontrado) {
      const respuesta = diag.error || "No encontré tu recibo para mostrarte el detalle.";
      registrar(cuenta, canal, telefono, hechosDesdeDiagnostico(diag), respuesta, mensaje);
      return { respuesta, acciones: [] };
    }
    const detalle = await engine.detalleRecibo(cuenta, diag.recibo_actual, linea);
    const { texto: respuesta, hechos } = await llm.responderConversacion({ diag, historial, mensajeUsuario: mensaje, detalle });
    registrar(cuenta, canal, telefono, hechos, respuesta, mensaje);
    return { respuesta, acciones: ["pagar", "hablar_con_asesor"] };
  }

  // "Analizar el recibo actual y los recibos previos" (BrainyBill expone
  // factura actual + 5 previas, segun la ficha). Primero, si el cliente
  // pide ver la lista en general:
  if (contieneAlguna(texto, PALABRAS_RECIBOS_ANTERIORES)) {
    const historialRec = await engine.historialRecibos(cuenta, linea);
    const anteriores = historialRec.slice(1);
    let respuesta;
    if (!anteriores.length) {
      respuesta = "Este es tu único recibo registrado hasta ahora, todavía no hay anteriores con qué compararlo.";
    } else {
      const listado = anteriores.map((r, i) => `${i + 1}. ${formatearMes(r.fecha)} — S/ ${r.total.toFixed(2)}`).join("\n");
      respuesta = `Estos son tus recibos anteriores:\n\n${listado}\n\n¿${MARCA_LISTADO_RECIBOS}? Dime el mes o el número de la lista.`;
    }
    registrar(cuenta, canal, telefono, null, respuesta, mensaje);
    return { respuesta, acciones: [] };
  }

  // Si el cliente nombra un mes puntual ("el de julio"), o si el bot acaba
  // de mostrar la lista de arriba y el cliente responde con un número u
  // ordinal, resolvemos a que recibo especifico se refiere y lo explicamos.
  const historialRec = await engine.historialRecibos(cuenta, linea);
  let reciboReferido = null;
  if (historialRec.length > 1) {
    reciboReferido = engine.resolverReferenciaPorMes(historialRec, mensaje);
    if (!reciboReferido && botMostroListaRecibos(historial)) {
      reciboReferido = engine.resolverReferenciaPorPosicion(historialRec.slice(1), mensaje);
    }
  }
  if (reciboReferido) {
    const diagHist = await engine.diagnosticar(cuenta, reciboReferido, linea);
    const { texto: respuesta, hechos } = await llm.responderConversacion({ diag: diagHist, historial, mensajeUsuario: mensaje });
    registrar(cuenta, canal, telefono, hechos, respuesta, mensaje);
    return { respuesta, acciones: diagHist.encontrado ? ["hablar_con_asesor"] : [] };
  }

  // Si el bot ACABA de pedir la observacion de mejora (solo pasa cuando la
  // nota fue menor a 10), lo que sea que responda el cliente se toma como
  // esa observacion -- y recien ahi cerramos con el Efecto Efervescente.
  // Va ANTES que el chequeo de calificacion porque en este punto el ultimo
  // mensaje del bot ya no es el de pedir la nota, sino el de pedir mejora.
  if (botPidioMejora(historial)) {
    await engine.registrarObservacionMejora(cuenta, canal, telefono, mensaje);
    // Cross-selling restrictivo (pedido explicito de la ficha): el Efecto
    // Efervescente solo se activa si la consulta se resolvio de forma
    // POSITIVA (calificacion >= 7, no detractor). Si llegamos a este turno
    // es porque la nota fue menor a 10 -- si ademas es un detractor (1-6),
    // no le recordamos nada comercial en el cierre.
    const puntajeOriginal = obtenerCalificacionOriginal(historial);
    const puedeMostrarBeneficio = puntajeOriginal !== null && puntajeOriginal >= 7;
    const [diag, beneficioRaw] = await Promise.all([
      engine.diagnosticar(cuenta, recibo, linea),
      puedeMostrarBeneficio ? engine.buscarBeneficioDestacado(cuenta, linea) : Promise.resolve(null),
    ]);
    const { texto: respuesta, hechos } = await llm.responderConversacion({ diag, historial, mensajeUsuario: mensaje, beneficio: beneficioRaw, cierreFinal: true });
    registrar(cuenta, canal, telefono, hechos, respuesta, mensaje);
    return { respuesta, acciones: [], satisfaccion: "conforme", beneficioMostrado: !!beneficioRaw };
  }

  // Si el bot ACABA de pedir la calificacion 1-10 (mensaje fijo, ver mas
  // abajo) y este turno trae un numero valido, la registramos. Si la nota
  // es menor a 10, pedimos una observacion de mejora antes de cerrar; si es
  // 10, cerramos de una con el Efecto Efervescente. Todo esto antes de
  // cualquier otra logica de cierre para no pisarnos con PALABRAS_CIERRE.
  if (botPidioCalificacion(historial)) {
    const puntaje = parseCalificacion(texto);
    if (puntaje) {
      await engine.registrarCalificacion(cuenta, canal, puntaje, mensaje, telefono);
      engine.registrarSatisfaccion(cuenta, canal, "conforme", `calificacion ${puntaje}/10`).catch(() => {});

      if (puntaje < 10) {
        const respuesta = MENSAJES_PEDIR_MEJORA[Math.floor(Math.random() * MENSAJES_PEDIR_MEJORA.length)];
        registrar(cuenta, canal, telefono, null, respuesta, mensaje);
        return { respuesta, acciones: [], satisfaccion: "conforme", calificacionRecibida: puntaje };
      }

      const [diag, beneficioRaw] = await Promise.all([
        engine.diagnosticar(cuenta, recibo, linea),
        engine.buscarBeneficioDestacado(cuenta, linea),
      ]);
      const { texto: respuesta, hechos } = await llm.responderConversacion({ diag, historial, mensajeUsuario: mensaje, beneficio: beneficioRaw, cierreFinal: true });
      registrar(cuenta, canal, telefono, hechos, respuesta, mensaje);
      return { respuesta, acciones: [], satisfaccion: "conforme", beneficioMostrado: !!beneficioRaw, calificacionRecibida: puntaje };
    }
    // Si no llego un numero 1-10 valido, no insistimos -- seguimos abajo y
    // Claude responde con naturalidad a lo que sea que haya dicho.
  }

  let satisfaccion;
  if (contieneAlguna(texto, PALABRAS_CIERRE)) {
    satisfaccion = "conforme";
    engine.registrarSatisfaccion(cuenta, canal, "conforme", mensaje).catch(() => {});
  }

  // El cierre real (bot pregunto "algo mas?" y el cliente dice que no) ya no
  // muestra el beneficio de inmediato: primero pedimos la calificacion 1-5
  // con un mensaje fijo (deterministico, para poder detectarlo con certeza
  // en el siguiente turno) -- el Efecto Efervescente se muestra recien
  // despues, junto con el agradecimiento por la nota.
  const esCierreReal =
    esNegacionCierre(texto) && botPreguntoSiAlgoMas(historial) && !yaHuboCierreEfectivo(historial);
  if (esCierreReal) {
    const respuesta = MENSAJES_PEDIR_CALIFICACION[Math.floor(Math.random() * MENSAJES_PEDIR_CALIFICACION.length)];
    registrar(cuenta, canal, telefono, null, respuesta, mensaje);
    return { respuesta, acciones: [], satisfaccion };
  }

  // Conversacion real: Claude ve los hechos del recibo + glosario + historial
  // y responde a lo que efectivamente se le pregunto.
  const diag = await engine.diagnosticar(cuenta, recibo, linea);
  const { texto: respuesta, hechos } = await llm.responderConversacion({ diag, historial, mensajeUsuario: mensaje });
  registrar(cuenta, canal, telefono, hechos, respuesta, mensaje);

  // Las "siguientes acciones" que pide la ficha (pagar, revisar detalle,
  // registrar la consulta, derivar a asesor) se ofrecen siempre que hay un
  // recibo identificado -- no solo cuando hubo variacion.
  const acciones = diag.encontrado
    ? ["ver_recibos_anteriores", "registrar_consulta", "pagar", "hablar_con_asesor"]
    : [];
  if (diag.encontrado && diag.diferencia > 0.5) acciones.unshift("ver_detalle");
  // Umbral de incomprension (pedido explicito de la ficha, "Precision del
  // Hand-off"): si el motor no logro identificar una causa exacta para la
  // variacion, no dejamos "hablar con un asesor" al final de la lista como
  // una opcion mas -- la subimos primero, porque en este caso especifico
  // el propio sistema sabe que no pudo resolverlo del todo.
  if (diag.encontrado && diag.diferencia > 0.5 && diag.causas.length === 0) {
    acciones.splice(acciones.indexOf("hablar_con_asesor"), 1);
    acciones.unshift("hablar_con_asesor");
  }

  return { respuesta, acciones, satisfaccion };
}

module.exports = { responder };
