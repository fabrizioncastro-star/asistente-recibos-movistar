// Maquina de estados de la conversacion, la misma logica que index.html
// usa en el navegador (identificacion por cuenta -> seleccion de linea si
// aplica -> chat normal), pero corriendo del lado del servidor y con una
// sesion por numero de WhatsApp (wa_id), porque aca no hay "una pestana de
// navegador" que guarde el estado -- cada mensaje entrante es una llamada
// de webhook independiente.
const engine = require("./engine");
const llm = require("./llm");
const assistant = require("./assistant");

const ESTADOS = { SIN_IDENTIFICAR: "SIN_IDENTIFICAR", ESPERANDO_LINEA: "ESPERANDO_LINEA", LISTO: "LISTO" };
const HISTORIAL_MAX = 12;

// Minutos de inactividad antes de que el bot se despida solo. Configurable
// por env var para que en la demo en vivo se pueda bajar (ej. a 1 minuto)
// y mostrar el comportamiento sin esperar tanto.
const TIMEOUT_INACTIVIDAD_MS = (parseFloat(process.env.INACTIVITY_TIMEOUT_MIN) || 5) * 60 * 1000;

// Sesiones en memoria: se pierden si el servidor se reinicia (aceptable
// para el prototipo del hackathon).
// wa_id -> { estado, cuenta, linea, lineasPendientes, historial, ultimaActividad, avisoInactividadEnviado }
const sesiones = new Map();

function normalizar(t) {
  return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

function sesionVacia() {
  return {
    estado: ESTADOS.SIN_IDENTIFICAR, cuenta: null, linea: null, lineasPendientes: [], historial: [],
    ultimaActividad: Date.now(), avisoInactividadEnviado: false,
    explicacionDada: false, cerrado: false, beneficioMostrado: false, // para satisfaccion + Efecto Efervescente
  };
}

const MENSAJES_DESPEDIDA = [
  "He estado inactivo un rato, así que voy a cerrar esta sesión por ahora. ¡Muchas gracias por escribirme! Cuando quieras retomar, mándame de nuevo tu número de cuenta. 🙂",
  "Como no he recibido respuesta en un tiempo, voy a cerrar la conversación por aquí. ¡Gracias por tu tiempo! Escríbeme cuando quieras y seguimos ayudándote.",
];

function obtenerSesion(waId) {
  if (!sesiones.has(waId)) sesiones.set(waId, sesionVacia());
  return sesiones.get(waId);
}

function reiniciarSesion(waId) {
  sesiones.set(waId, sesionVacia());
}

const PALABRAS_REINICIAR = [
  "reiniciar", "cerrar sesion", "cerrar la sesion", "salir", "logout", "log out",
  "otra cuenta", "otro numero de cuenta", "otro numero", "cambiar de cuenta", "cambiar cuenta",
  "usar otra cuenta", "consultar otra cuenta", "distinta cuenta", "diferente cuenta",
];

function pareceReinicio(texto) {
  const t = normalizar(texto);
  return PALABRAS_REINICIAR.some((p) => t.includes(p));
}

function registrarTurno(session, mensajeUsuario, respuestaBot) {
  session.historial.push({ role: "user", content: mensajeUsuario });
  session.historial.push({ role: "bot", content: respuestaBot });
  if (session.historial.length > HISTORIAL_MAX) {
    session.historial = session.historial.slice(-HISTORIAL_MAX);
  }
}

const ICONOS_SERVICIO = {
  "Línea Móvil": "📱", "Internet Hogar": "🌐", "Equipo/Router de Internet": "📡",
  "TV": "📺", "Línea Fija (Voz)": "☎️",
};

// Mismas "siguientes acciones" que ofrece la web (ver_recibos_anteriores,
// registrar_consulta, pagar, hablar_con_asesor, +ver_detalle si hubo
// variacion) -- se usan aca para que los botones tambien aparezcan justo
// despues de la primera explicacion al identificarse, no solo despues.
function accionesDeDiagnostico(diag) {
  if (!diag.encontrado) return [];
  const acciones = ["ver_recibos_anteriores", "registrar_consulta", "pagar", "hablar_con_asesor"];
  if (diag.diferencia > 0.5) acciones.unshift("ver_detalle");
  return acciones;
}

async function procesarIdentificacion(session, textoCrudo) {
  const cuenta = textoCrudo.replace(/\D/g, "");
  if (!cuenta) {
    return { respuesta: "Necesito tu número de cuenta (solo números) para poder ayudarte. ¿Me lo compartes?", acciones: [] };
  }
  const lineas = await engine.buscarCuenta(cuenta);
  if (!lineas) {
    return { respuesta: `No te encuentro como cliente Movistar con la cuenta *${cuenta}* 😕. ¿Puedes verificar el número?`, acciones: [] };
  }
  session.cuenta = cuenta;

  if (lineas.length > 1) {
    session.lineasPendientes = lineas;
    session.estado = ESTADOS.ESPERANDO_LINEA;
    const listado = lineas.map((l, i) => `${i + 1}. ${ICONOS_SERVICIO[l.etiqueta] || "📶"} ${l.etiqueta}`).join("\n");
    return {
      respuesta: `¡Perfecto! Tu cuenta tiene ${lineas.length} servicios:\n\n${listado}\n\n¿Sobre cuál quieres consultar? (responde con el número o el nombre)`,
      acciones: [],
    };
  }

  session.linea = lineas[0] ? lineas[0].anexo : null;
  session.estado = ESTADOS.LISTO;
  session.explicacionDada = true;
  const diag = await engine.diagnosticar(session.cuenta, null, session.linea);
  return { respuesta: await llm.explicarVariacionLLM(diag), acciones: accionesDeDiagnostico(diag) };
}

async function procesarSeleccionLinea(session, textoCrudo) {
  const t = normalizar(textoCrudo);
  let elegida = null;

  const num = parseInt(t, 10);
  if (!isNaN(num) && session.lineasPendientes[num - 1]) elegida = session.lineasPendientes[num - 1];

  if (!elegida) {
    elegida = session.lineasPendientes.find((l) => {
      const et = normalizar(l.etiqueta);
      return et.includes(t) || t.split(" ").some((p) => p.length > 3 && et.includes(p));
    });
  }

  if (!elegida) {
    return { respuesta: "No identifiqué cuál elegiste 🤔. Responde con el número de la lista o el nombre del servicio.", acciones: [] };
  }

  session.linea = elegida.anexo;
  session.estado = ESTADOS.LISTO;
  session.explicacionDada = true;
  const diag = await engine.diagnosticar(session.cuenta, null, session.linea);
  return { respuesta: await llm.explicarVariacionLLM(diag), acciones: accionesDeDiagnostico(diag) };
}

// Cuentas de las que se detecto inactividad y ya requieren el aviso de
// cierre por WhatsApp. whatsapp.js corre esto en un intervalo periodico.
function sesionesInactivas() {
  const ahora = Date.now();
  const resultado = [];
  for (const [waId, session] of sesiones.entries()) {
    if (session.estado === ESTADOS.SIN_IDENTIFICAR) continue; // nadie a quien avisarle, no empezo nada
    if (session.avisoInactividadEnviado) continue;
    if (ahora - session.ultimaActividad >= TIMEOUT_INACTIVIDAD_MS) resultado.push(waId);
  }
  return resultado;
}

function marcarAvisoInactividadEnviado(waId) {
  const s = sesiones.get(waId);
  if (s) s.avisoInactividadEnviado = true;
}

// Construye el mensaje de despedida por inactividad (incluyendo el
// "Efecto Efervescente" si aun no se le mostro en esta sesion) y registra
// la "tasa de silencio post-explicacion" que pide la ficha, cuando aplica.
async function cerrarPorInactividad(waId) {
  const session = sesiones.get(waId);
  const despedida = MENSAJES_DESPEDIDA[Math.floor(Math.random() * MENSAJES_DESPEDIDA.length)];
  let promo = null;

  if (session && session.explicacionDada && !session.cerrado) {
    await engine.registrarSatisfaccion(session.cuenta, "whatsapp", "silencio", "sesion cerrada por inactividad sin respuesta");
  }

  if (session && session.cuenta && !session.beneficioMostrado) {
    const beneficio = await engine.buscarBeneficioDestacado(session.cuenta, session.linea);
    if (beneficio) {
      // Mensaje aparte y llamativo, pero el texto deja claro que es algo que
      // YA tiene incluido -- no es una oferta nueva (pedido explicito de la
      // ficha para el "Efecto Efervescente").
      promo = `🎉 *¡PROMOCIÓN!* 🎉\n\n🎁 Antes de irte, recuerda que *ya tienes incluido* ${beneficio.concepto} sin costo extra 😉\n\n¡Aprovéchalo! 🙌`;
    }
  }

  reiniciarSesion(waId);
  return { despedida, promo };
}

async function manejarMensaje(waId, textoUsuario) {
  const texto = (textoUsuario || "").trim();
  const session = obtenerSesion(waId);
  session.ultimaActividad = Date.now();
  session.avisoInactividadEnviado = false;

  if (pareceReinicio(texto)) {
    reiniciarSesion(waId);
    return { respuesta: "¡Listo! Empecemos de nuevo 🙂 ¿Cuál es el número de cuenta que quieres consultar ahora?", acciones: [] };
  }

  let respuesta;
  let acciones = [];

  if (session.estado === ESTADOS.SIN_IDENTIFICAR) {
    // Si el mensaje no parece un numero de cuenta, dejamos que Claude
    // converse de forma natural (saludos, "que eres", "que puedes hacer",
    // etc.) en vez de repetir siempre el mismo texto fijo.
    if (!/\d{5,}/.test(texto)) {
      // Sin cuenta identificada todavia no hay nada real que ofrecer como
      // opcion (ni recibo, ni contexto para un asesor) -- la cinta de
      // opciones aparece recien despues de identificarse.
      respuesta = await llm.responderOnboarding(texto);
    } else {
      const r = await procesarIdentificacion(session, texto);
      respuesta = r.respuesta;
      acciones = r.acciones;
    }
  } else if (session.estado === ESTADOS.ESPERANDO_LINEA) {
    const r = await procesarSeleccionLinea(session, texto);
    respuesta = r.respuesta;
    acciones = r.acciones;
  } else {
    const resp = await assistant.responder(session.cuenta, texto, null, session.linea, session.historial, "whatsapp");
    respuesta = resp.respuesta;
    acciones = resp.acciones || [];
    if (resp.satisfaccion) session.cerrado = true;
    if (resp.beneficioMostrado) session.beneficioMostrado = true;
  }

  registrarTurno(session, texto, respuesta);
  return { respuesta, acciones };
}

module.exports = { manejarMensaje, sesionesInactivas, marcarAvisoInactividadEnviado, reiniciarSesion, cerrarPorInactividad };
