// Motor de comparacion y diagnostico de recibos (puerto a Node/SQL del
// engine.py original). Esta capa NO redacta texto: solo calcula numeros y
// clasifica causas contra la base de datos real. nlg.js es la unica que
// puede convertir esto en texto para el cliente.
const pool = require("./db");

const UMBRAL_IGNORAR = 0.5;

const LOB_LABELS = {
  WRLS: "Línea Móvil",
  BB: "Internet Hogar",
  ShEq: "Equipo/Router de Internet",
  TV: "TV",
  VOIC: "Línea Fija (Voz)",
};

// Catalogo de tarifas oficiales (charge_code -> precio de catalogo). Se
// cachea en memoria porque es una tabla chica (~7k filas) y de solo lectura.
let catalogoCache = null;
async function cargarCatalogo() {
  if (catalogoCache) return catalogoCache;
  const [rows] = await pool.query("SELECT charge_code, rate_final, tipo_renta FROM catalogo_ofertas");
  catalogoCache = {};
  for (const r of rows) {
    if (r.rate_final !== null) catalogoCache[r.charge_code] = { tarifa: Number(r.rate_final), tipo_renta: r.tipo_renta };
  }
  return catalogoCache;
}

async function buscarCuenta(cuenta) {
  const cuentaLimpia = String(cuenta).trim();
  const [rows] = await pool.query(
    "SELECT num_anexo, lob_type, negocio FROM planta_clientes WHERE financial_account = ?",
    [cuentaLimpia]
  );
  if (rows.length) {
    return rows.map((r) => ({
      anexo: r.num_anexo,
      tipo: r.lob_type,
      etiqueta: LOB_LABELS[r.lob_type] || r.lob_type,
      negocio: r.negocio,
    }));
  }

  // No esta en planta_clientes (el listado de clientes ACTUALES) -- puede
  // ser una cuenta que ya no es cliente activo pero que si tiene historial
  // real de facturacion (ej. se dio de baja). En vez de decir "no
  // encontrada" de una, buscamos directo en facturacion: si tiene recibos,
  // igual la identificamos -- solo que sin el tipo de servicio (Movil,
  // Internet, etc.) porque esa info especificamente vive en planta_clientes
  // y no la tenemos para estos casos.
  const [lineasFacturacion] = await pool.query(
    "SELECT DISTINCT subscriber_key FROM facturacion WHERE financial_account_key = ? AND subscriber_key IS NOT NULL",
    [cuentaLimpia]
  );
  if (!lineasFacturacion.length) return null;
  return lineasFacturacion.map((r, i) => ({
    anexo: r.subscriber_key,
    tipo: null,
    etiqueta: lineasFacturacion.length > 1 ? `Servicio ${i + 1}` : "Servicio",
    negocio: null,
  }));
}

async function recibosDeCuenta(cuenta, linea) {
  const params = [cuenta];
  let sql = `SELECT legal_invoice_number, ciclo, SUM(charge_total_amount) AS total,
                    MIN(customer_key) AS customer_key, MIN(subscriber_key) AS subscriber_key
             FROM facturacion WHERE financial_account_key = ?`;
  if (linea) {
    sql += " AND subscriber_key = ?";
    params.push(linea);
  }
  sql += " GROUP BY legal_invoice_number, ciclo ORDER BY ciclo DESC";
  const [rows] = await pool.query(sql, params);
  return rows.map((r) => ({
    recibo: r.legal_invoice_number,
    ciclo: r.ciclo,
    total: Number(r.total),
    customerKey: r.customer_key,
    subscriberKey: r.subscriber_key,
  }));
}

async function lineasDeRecibo(cuenta, recibo, linea) {
  const params = [cuenta, recibo];
  let sql = "SELECT * FROM facturacion WHERE financial_account_key = ? AND legal_invoice_number = ?";
  if (linea) {
    sql += " AND subscriber_key = ?";
    params.push(linea);
  }
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function detectarProrrateo(reciboActual) {
  const [rows] = await pool.query("SELECT * FROM brainy_prorrateo WHERE numero_recibo = ? LIMIT 1", [reciboActual]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    tipo: "prorrateo",
    monto: Number(r.suma_prorrateo),
    detalle: {
      desde: r.fecha_inicio_minima ? r.fecha_inicio_minima.slice(0, 10) : null,
      hasta: r.fecha_fin_maxima ? r.fecha_fin_maxima.slice(0, 10) : null,
      cargos_involucrados: r.q_cargos,
    },
  };
}

async function detectarReconexion(reciboActual) {
  const [rows] = await pool.query("SELECT * FROM brainy_reconexiones WHERE numero_recibo = ? LIMIT 1", [reciboActual]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    tipo: "reconexion",
    monto: Number(r.monto),
    detalle: {
      descripcion: r.descripcion,
      fecha_corte: r.fecha_corte ? r.fecha_corte.slice(0, 10) : null,
      fecha_reconexion: r.fecha_reconexion ? r.fecha_reconexion.slice(0, 10) : null,
    },
  };
}

async function detectarFinDescuento(cuenta, periodoInicio, periodoFin) {
  if (!periodoInicio || !periodoFin) return [];
  const [rows] = await pool.query(
    `SELECT * FROM brainy_descuentos_cuotas
     WHERE cuentafinanciera = ? AND flag_descuento_completo = 1
       AND fecha_fin BETWEEN ? AND ?`,
    [cuenta, periodoInicio, periodoFin]
  );
  const vistos = new Set();
  const causas = [];
  for (const r of rows) {
    const clave = `${r.descripcion}|${Number(r.monto_descuento).toFixed(2)}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    causas.push({
      tipo: "fin_descuento",
      monto: Number(r.monto_descuento),
      detalle: {
        concepto: r.descripcion,
        duro_meses: r.promotion_duration,
        fecha_fin: r.fecha_fin ? r.fecha_fin.slice(0, 10) : null,
      },
    });
  }
  return causas;
}

async function detectarFinanciamiento(lineasRelevantes) {
  const catalogo = await cargarCatalogo();
  return lineasRelevantes
    .filter((r) => (r.charge_code_classification || "").toLowerCase().includes("financiamiento"))
    .map((r) => ({
      tipo: "financiamiento",
      monto: Number(r.charge_total_amount),
      detalle: {
        concepto: r.charge_code_desc,
        charge_code_id: r.charge_code_id,
        tarifa_oficial: catalogo[r.charge_code_id]?.tarifa ?? null,
      },
    }));
}

async function detectarCambioPlan(customerKey, periodoInicio, periodoFin, subscriberKey) {
  if (!periodoInicio || !periodoFin) return [];
  const params = [customerKey, periodoInicio, periodoFin];
  let sql = "SELECT * FROM ordenes WHERE customer_key = ? AND completion_date BETWEEN ? AND ?";
  if (subscriberKey) {
    sql += " AND subscriber_key = ?";
    params.push(subscriberKey);
  }
  const [rows] = await pool.query(sql, params);
  return rows.map((r) => ({
    tipo: "cambio_plan",
    monto: 0,
    detalle: {
      accion: r.item_type_desc,
      motivo: r.reason_desc,
      fecha: r.completion_date ? r.completion_date.slice(0, 10) : null,
    },
  }));
}

async function detectarNotasCredito(cuenta, subscriberKey, periodoInicio, periodoFin) {
  const params = [cuenta, subscriberKey];
  let sql = "SELECT * FROM notas_credito WHERE ba_no = ? AND service_receiver_id = ?";
  if (periodoInicio && periodoFin) {
    sql += " AND effective_date BETWEEN ? AND ?";
    params.push(periodoInicio, periodoFin);
  }
  const [rows] = await pool.query(sql, params);
  const vistos = new Set();
  const causas = [];
  for (const r of rows) {
    const clave = `${r.charge_code}|${Number(r.amount).toFixed(4)}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    causas.push({
      tipo: "nota_credito",
      monto: Number(r.amount),
      detalle: { clase: r.cancel_charge_type === "CRD" ? "nota de crédito" : "nota de débito", charge_code: r.charge_code },
    });
  }
  return causas;
}

// Convierte un ciclo tipo 20260807 (INT) a '2026-08-07' para poder
// compararlo con fechas reales (fecha_fin de descuentos, effective_date de
// notas de credito, completion_date de ordenes).
function cicloToFecha(ciclo) {
  if (!ciclo) return null;
  const s = String(ciclo);
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

async function diagnosticar(cuentaRaw, recibo = null, linea = null) {
  const cuenta = String(cuentaRaw).trim();
  const recibos = await recibosDeCuenta(cuenta, linea);
  if (!recibos.length) {
    return { encontrado: false, error: "No encontramos esa cuenta (o esa línea) en el sistema.", cuenta };
  }

  let idxActual;
  if (recibo === null || recibo === undefined) {
    idxActual = 0;
  } else {
    idxActual = recibos.findIndex((r) => r.recibo === recibo);
    if (idxActual === -1) {
      return { encontrado: false, error: "Ese recibo no pertenece a esta cuenta.", cuenta };
    }
  }

  if (idxActual + 1 >= recibos.length) {
    const actual = recibos[idxActual];
    const causaProrrateo = await detectarProrrateo(actual.recibo);
    if (causaProrrateo) {
      return {
        encontrado: true,
        cuenta,
        recibo_actual: actual.recibo,
        recibo_previo: null,
        ciclo_actual: actual.ciclo,
        ciclo_previo: null,
        total_actual: round2(actual.total),
        total_previo: 0,
        monto_habitual: 0,
        diferencia: round2(actual.total),
        causas: [causaProrrateo],
        historial: [{ recibo: actual.recibo, ciclo: actual.ciclo, total: round2(actual.total) }],
      };
    }
    return { encontrado: false, error: "No hay un recibo previo con el cual comparar (es el primer recibo de esta línea).", cuenta };
  }

  const actual = recibos[idxActual];
  const previo = recibos[idxActual + 1];
  const historialPrev = recibos.slice(idxActual + 1, idxActual + 6);

  const [lineasActual, lineasPrevio] = await Promise.all([
    lineasDeRecibo(cuenta, actual.recibo, linea),
    lineasDeRecibo(cuenta, previo.recibo, linea),
  ]);

  // OJO: period_start_date/period_end_date vienen vacios en el 100% del
  // dataset real (problema de la data fuente, no nuestro). Como ventana de
  // periodo confiable usamos el propio "ciclo" de facturacion (siempre
  // poblado): desde el ciclo del recibo previo hasta el ciclo del actual.
  const periodoInicio = cicloToFecha(previo.ciclo);
  const periodoFin = cicloToFecha(actual.ciclo);

  const prevPorCodigo = {};
  for (const r of lineasPrevio) {
    prevPorCodigo[r.charge_code_id] = (prevPorCodigo[r.charge_code_id] || 0) + Number(r.charge_total_amount);
  }
  const actPorCodigo = {};
  const descPorCodigo = {};
  for (const r of lineasActual) {
    actPorCodigo[r.charge_code_id] = (actPorCodigo[r.charge_code_id] || 0) + Number(r.charge_total_amount);
    if (!descPorCodigo[r.charge_code_id]) descPorCodigo[r.charge_code_id] = r;
  }
  const deltasPositivos = {};
  for (const code of Object.keys(actPorCodigo)) {
    const delta = actPorCodigo[code] - (prevPorCodigo[code] || 0);
    if (delta > UMBRAL_IGNORAR) deltasPositivos[code] = delta;
  }
  const lineasRelevantes = lineasActual.filter((r) => deltasPositivos[r.charge_code_id] !== undefined);

  const [causaProrrateo, causaReconexion, causasDescuento, causasCambioPlan, causasNotasCredito] = await Promise.all([
    detectarProrrateo(actual.recibo),
    detectarReconexion(actual.recibo),
    detectarFinDescuento(cuenta, periodoInicio, periodoFin),
    detectarCambioPlan(actual.customerKey, periodoInicio, periodoFin, linea),
    detectarNotasCredito(cuenta, actual.subscriberKey, periodoInicio, periodoFin),
  ]);

  const causas = [];
  if (causaProrrateo) causas.push(causaProrrateo);
  if (causaReconexion) causas.push(causaReconexion);
  causas.push(...causasDescuento);
  causas.push(...(await detectarFinanciamiento(lineasRelevantes)));
  causas.push(...causasCambioPlan);
  causas.push(...causasNotasCredito);

  const codigosExplicados = new Set(causas.map((c) => c.detalle.charge_code_id).filter(Boolean));
  const hayReconexion = causas.some((c) => c.tipo === "reconexion");
  const catalogo = await cargarCatalogo();

  const ordenados = Object.entries(deltasPositivos).sort((a, b) => b[1] - a[1]);
  for (const [code, delta] of ordenados) {
    if (codigosExplicados.has(code)) continue;
    const fila = descPorCodigo[code];
    const clasif = (fila?.charge_code_classification || "").toLowerCase();
    const grupo = fila?.grupo || "";
    if (clasif.includes("financiamiento")) continue;
    if (hayReconexion && grupo.toLowerCase().includes("reconexion")) continue;
    causas.push({
      tipo: "otro",
      monto: round2(delta),
      detalle: { concepto: fila?.charge_code_desc || code, grupo: grupo || null, tarifa_oficial: catalogo[code]?.tarifa ?? null },
    });
  }

  const diferencia = actual.total - previo.total;
  const montoHabitual = historialPrev.length
    ? historialPrev.reduce((s, r) => s + r.total, 0) / historialPrev.length
    : previo.total;

  return {
    encontrado: true,
    cuenta,
    recibo_actual: actual.recibo,
    recibo_previo: previo.recibo,
    ciclo_actual: actual.ciclo,
    ciclo_previo: previo.ciclo,
    total_actual: round2(actual.total),
    total_previo: round2(previo.total),
    monto_habitual: round2(montoHabitual),
    diferencia: round2(diferencia),
    causas,
    historial: recibos.slice(idxActual, idxActual + 6).map((r) => ({ recibo: r.recibo, ciclo: r.ciclo, total: round2(r.total) })),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------
// "Analizar el recibo actual y los recibos previos" (BrainyBill expone
// factura actual + 5 previas) y "revisar el detalle" -- ambos pedidos
// textuales de la ficha del Desafio 1, ademas de las causas de variacion.
// ---------------------------------------------------------------------

function _normalizarLocal(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Hasta 6 recibos (el actual + 5 previos, tal como los expone BrainyBill),
// con fecha ya resuelta via ciclo para poder matchear "el de julio", etc.
async function historialRecibos(cuenta, linea) {
  const recibos = await recibosDeCuenta(cuenta, linea);
  return recibos.slice(0, 6).map((r) => ({
    recibo: r.recibo,
    ciclo: r.ciclo,
    fecha: cicloToFecha(r.ciclo),
    total: round2(r.total),
  }));
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// Busca en el historial completo (incluye el actual) una referencia a un
// mes ("el de julio", "en agosto 2026"). Baja probabilidad de falso
// positivo, asi que se intenta siempre, sin necesitar contexto previo.
function resolverReferenciaPorMes(historialRec, texto) {
  const t = _normalizarLocal(texto);
  let mes = null;
  for (let i = 0; i < MESES.length; i++) {
    if (t.includes(MESES[i])) { mes = i + 1; break; }
  }
  if (!mes && t.includes("setiembre")) mes = 9;
  if (!mes) return null;
  const anioMatch = t.match(/20\d{2}/);
  const candidato = historialRec.find((r) => {
    if (!r.fecha) return false;
    const mm = Number(r.fecha.slice(5, 7));
    const yyyy = r.fecha.slice(0, 4);
    return mm === mes && (!anioMatch || yyyy === anioMatch[0]);
  });
  return candidato ? candidato.recibo : null;
}

const ORDINALES = { primero: 0, segundo: 1, tercero: 2, cuarto: 3, quinto: 4, sexto: 5 };

// Busca una referencia por posicion ("el 2", "el segundo", "el mas
// antiguo") dentro de una lista ya acotada (normalmente "los anteriores",
// tal como se le mostraron al cliente). Solo se debe usar justo despues de
// haberle mostrado esa lista -- si no, "el segundo" es ambiguo.
function resolverReferenciaPorPosicion(listaAcotada, texto) {
  const t = _normalizarLocal(texto).trim();
  const numMatch = t.match(/^(\d)\s*$/);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    return listaAcotada[idx] ? listaAcotada[idx].recibo : null;
  }
  for (const [palabra, idx] of Object.entries(ORDINALES)) {
    if (t.includes(palabra) && listaAcotada[idx]) return listaAcotada[idx].recibo;
  }
  if (/mas antigu|el mas viejo/.test(t)) return listaAcotada[listaAcotada.length - 1]?.recibo || null;
  return null;
}

// Detalle itemizado (cada concepto, con su monto) del recibo actual --
// distinto de 'causas', que solo trae lo que VARIO respecto al anterior.
async function detalleRecibo(cuenta, recibo, linea) {
  const lineas = await lineasDeRecibo(cuenta, recibo, linea);
  const porCodigo = {};
  for (const r of lineas) {
    const key = r.charge_code_id || r.charge_code_desc;
    if (!porCodigo[key]) porCodigo[key] = { concepto: r.charge_code_desc, grupo: r.grupo || null, monto: 0 };
    porCodigo[key].monto += Number(r.charge_total_amount);
  }
  return Object.values(porCodigo)
    .map((c) => ({ ...c, monto: round2(c.monto) }))
    .sort((a, b) => Math.abs(b.monto) - Math.abs(a.monto));
}

// "Registrar la consulta" (accion recomendada explicitamente por la
// ficha, junto a pagar/revisar detalle/derivar a asesor): deja constancia
// en la misma tabla que la tasa de silencio, con un folio que se le puede
// dar al cliente.
async function registrarConsulta(cuenta, canal, resumen) {
  const [result] = await pool.query(
    "INSERT INTO satisfaccion_log (cuenta, canal, clasificacion, detalle) VALUES (?, ?, 'consulta_registrada', ?)",
    [cuenta || null, canal, String(resumen).slice(0, 250)]
  );
  return result.insertId;
}

// Casos de demo ya verificados contra el dataset real (ver historial de
// exploracion): se listan directo en vez de re-probar por SQL en cada
// arranque, para que el servidor levante rapido incluso con la DB remota.
// IMPORTANTE: todas estas cuentas fueron verificadas para que la causa
// aparezca en su RECIBO ACTUAL (el mas reciente, recibo=null por defecto).
// Antes teniamos casos donde la causa solo aparecia en un recibo antiguo
// (ej. de hace 2-3 meses) -- funcionaban en la demo dirigida, pero si
// alguien solo escribia el numero de cuenta sin el recibo especifico, veia
// "sin variacion" porque el bot explica el recibo de HOY, no uno viejo.
// Con estos casos, escribir solo el numero de cuenta ya alcanza.
// Cada cuenta fue verificada dos veces: (1) la causa aparece en el recibo
// MAS RECIENTE de la cuenta (no uno viejo), y (2) la cuenta existe tanto en
// `facturacion` como en `planta_clientes` (si falta en planta_clientes, la
// identificacion falla aunque el diagnostico funcione).
//
// La ficha pide poder demostrar cada escenario "en ambas modalidades de
// renta adelantada y vencida" -- por eso, donde el dataset lo permitia, se
// incluye al menos una cuenta de cada modalidad (columna `tipo_renta` en
// `catalogo_ofertas`, unida por charge_code). EXCEPCION CONOCIDA: prorrateo
// solo existe en modalidad ADELANTADA en todo el dataset sintetico -- se
// audito exhaustivamente (join brainy_prorrateo -> facturacion ->
// catalogo_ofertas filtrando tipo_renta = 'VENCIDA') y dio cero resultados
// en TODA la base, no es una cuenta que falte por buscar. Es una limitacion
// real de los datos de prueba entregados, no del motor de reglas.
const CASOS_DEMO_VERIFICADOS = {
  prorrateo: [
    { cuenta: "761826072", recibo: "S9AA-0082929210" }, // ADELANTADA
    { cuenta: "761761362", recibo: "S1AA-0052899594" }, // ADELANTADA
    { cuenta: "761776277", recibo: "S1AA-0052947287" }, // ADELANTADA -- no hay ninguna cuenta VENCIDA con prorrateo en el dataset (ver nota arriba)
  ],
  reconexion: [
    { cuenta: "103976720", recibo: "S9AA-0082590016" }, // VENCIDA
    { cuenta: "104125317", recibo: "S3AA-0080033306" }, // VENCIDA
    { cuenta: "747037881", recibo: "S1AA-0052372745" }, // ADELANTADA
  ],
  fin_descuento: [
    { cuenta: "759739074", recibo: "S8AA-0008372021" }, // ADELANTADA
    { cuenta: "741244173", recibo: "S8AA-0008274774" }, // VENCIDA
    { cuenta: "757749108", recibo: "S8AA-0008377841" }, // VENCIDA
  ],
  financiamiento: [
    { cuenta: "753362001", recibo: "S1AA-0052482465" }, // ADELANTADA
    { cuenta: "101130168", recibo: "S1AA-0052791162" }, // VENCIDA
    { cuenta: "754497535", recibo: "S1AA-0052822881" }, // VENCIDA
  ],
  cambio_plan: [
    { cuenta: "727719775", recibo: "S1AA-0052433081" }, // VENCIDA
    { cuenta: "700880965", recibo: "S1AA-0052432494" }, // VENCIDA
    { cuenta: "374734026", recibo: "S1AA-0052357116" }, // ADELANTADA
  ],
  nota_credito: [
    { cuenta: "102233951", recibo: "S3AA-0080126586" }, // ADELANTADA
    { cuenta: "103692188", recibo: "S1AA-0052607549" }, // ADELANTADA
    { cuenta: "308791919", recibo: "S5AA-0082207824" }, // VENCIDA
  ],
  multiservicio: [
    { cuenta: "300004563" },
    { cuenta: "319242446" },
    { cuenta: "600580567" },
  ],
};

async function buscarCasosDemo() {
  return CASOS_DEMO_VERIFICADOS;
}

// "Efecto Efervescente" (pedido textual de la ficha del reto): busca un
// beneficio que el cliente YA TIENE incluido en su plan actual (una linea
// de tipo BONO en su recibo mas reciente), para que el bot se lo recuerde
// al cerrar la conversacion -- nunca una oferta nueva, solo un valor que
// ya le pertenece.
async function buscarBeneficioDestacado(cuenta, linea) {
  const recibos = await recibosDeCuenta(cuenta, linea);
  if (!recibos.length) return null;
  const lineas = await lineasDeRecibo(cuenta, recibos[0].recibo, linea);
  const bono = lineas.find(
    (r) =>
      (r.grupo || "").toUpperCase().includes("BONO") ||
      (r.charge_code_classification || "").toLowerCase().includes("bono")
  );
  if (!bono) return null;
  return { concepto: bono.charge_code_desc, valor_referencial: Math.abs(Number(bono.charge_total_amount)) };
}

// Registro de satisfaccion / "tasa de silencio post-explicacion" (tambien
// pedido textual de la ficha): clasificacion = 'conforme' | 'insatisfecho' | 'silencio'
async function registrarSatisfaccion(cuenta, canal, clasificacion, detalle = null) {
  try {
    await pool.query(
      "INSERT INTO satisfaccion_log (cuenta, canal, clasificacion, detalle) VALUES (?, ?, ?, ?)",
      [cuenta || null, canal, clasificacion, detalle]
    );
  } catch (e) {
    console.error("No se pudo registrar satisfaccion:", e.message);
  }
}

async function metricasSatisfaccion() {
  const [porClasificacion] = await pool.query(
    "SELECT clasificacion, COUNT(*) AS total FROM satisfaccion_log GROUP BY clasificacion"
  );
  const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM satisfaccion_log");
  return { total, por_clasificacion: porClasificacion };
}

// Calificacion explicita 1-10 que el bot pide al cliente justo cuando cierra
// la conversacion (despues de "algo mas?" -> "no"). Vive en la misma tabla
// que la satisfaccion inferida por palabras clave, como una columna aparte
// (puntaje), para tener ambas senales sin duplicar tablas. Escala 1-10 (no
// 1-5) a proposito: asi se alinea con la metodologia NPS real que la ficha
// menciona (NPS Transaccional FARECO) -- promotor 9-10, pasivo 7-8,
// detractor 1-6.
async function registrarCalificacion(cuenta, canal, puntaje, detalle = null, telefono = null) {
  const [result] = await pool.query(
    "INSERT INTO satisfaccion_log (cuenta, canal, telefono, clasificacion, puntaje, detalle) VALUES (?, ?, ?, 'calificado', ?, ?)",
    [cuenta || null, canal, telefono || null, puntaje, detalle ? String(detalle).slice(0, 250) : null]
  );
  return result.insertId;
}

// Cuando el cliente califica menos de 10, el bot pide una observacion de
// mejora -- se guarda como una fila aparte (mismo mecanismo que el resto de
// clasificaciones), para no tener que rastrear estado entre turnos.
async function registrarObservacionMejora(cuenta, canal, telefono, texto) {
  await pool.query(
    "INSERT INTO satisfaccion_log (cuenta, canal, telefono, clasificacion, detalle) VALUES (?, ?, ?, 'observacion_mejora', ?)",
    [cuenta || null, canal, telefono || null, String(texto).slice(0, 500)]
  );
}

function claseNps(puntaje) {
  if (puntaje >= 9) return "promotor";
  if (puntaje >= 7) return "pasivo";
  return "detractor";
}

async function metricasCalificacion() {
  const [[{ total, promedio }]] = await pool.query(
    "SELECT COUNT(*) AS total, AVG(puntaje) AS promedio FROM satisfaccion_log WHERE puntaje IS NOT NULL"
  );
  const [distribucionRaw] = await pool.query(
    "SELECT puntaje, COUNT(*) AS total FROM satisfaccion_log WHERE puntaje IS NOT NULL GROUP BY puntaje"
  );
  const distribucion = {};
  for (let i = 1; i <= 10; i++) distribucion[i] = 0;
  let promotores = 0, pasivos = 0, detractores = 0;
  for (const r of distribucionRaw) {
    distribucion[r.puntaje] = r.total;
    if (claseNps(r.puntaje) === "promotor") promotores += r.total;
    else if (claseNps(r.puntaje) === "pasivo") pasivos += r.total;
    else detractores += r.total;
  }
  const nps = total ? Math.round(((promotores - detractores) / total) * 100) : null;
  return { total, promedio: promedio ? Number(promedio) : null, distribucion, nps, promotores, pasivos, detractores };
}

// Desglose dia por dia (para el grafico de "satisfaccion por dia" que pide
// el panel), en vez de solo un promedio general.
async function calificacionesPorDia(dias = 30) {
  // creado_en se guarda en UTC (el servidor de MySQL corre en UTC) -- lo
  // convertimos a hora de Lima (UTC-5, fijo, Peru no tiene horario de
  // verano) ANTES de agrupar por dia, para que "el dia" coincida con el
  // dia real del cliente y no se corte a mitad de la noche.
  const [rows] = await pool.query(
    `SELECT DATE(CONVERT_TZ(creado_en, '+00:00', '-05:00')) AS dia, COUNT(*) AS total, AVG(puntaje) AS promedio
     FROM satisfaccion_log
     WHERE puntaje IS NOT NULL AND creado_en >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY DATE(CONVERT_TZ(creado_en, '+00:00', '-05:00')) ORDER BY dia`,
    [dias]
  );
  return rows.map((r) => ({ dia: String(r.dia).slice(0, 10), total: r.total, promedio: Number(r.promedio) }));
}

// Lista detallada: una fila por cliente que calificó, con su nota exacta y
// (si aplica) la observacion de mejora que dio despues -- para que el panel
// pueda mostrar quien dio que nota, no solo el promedio.
async function calificacionesDetalle(limit = 100) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const [filas] = await pool.query(
    `SELECT id, cuenta, telefono, canal, clasificacion, puntaje, detalle, creado_en
     FROM satisfaccion_log
     WHERE puntaje IS NOT NULL OR clasificacion = 'observacion_mejora'
     ORDER BY creado_en DESC LIMIT ${n}`
  );
  const calificaciones = filas.filter((f) => f.puntaje !== null);
  const observaciones = filas.filter((f) => f.clasificacion === "observacion_mejora");
  return calificaciones.map((c) => {
    const obs = observaciones.find((o) =>
      o.cuenta === c.cuenta && o.canal === c.canal &&
      new Date(o.creado_en) >= new Date(c.creado_en) &&
      new Date(o.creado_en) - new Date(c.creado_en) < 5 * 60 * 1000
    );
    return {
      id: c.id,
      cuenta: c.cuenta,
      telefono: c.telefono,
      canal: c.canal,
      puntaje: c.puntaje,
      nps: claseNps(c.puntaje),
      observacion: obs ? obs.detalle : null,
      creado_en: c.creado_en ? String(c.creado_en).replace(" ", "T") + "Z" : null,
    };
  });
}

// Todas las filas de satisfaccion_log tal cual (clasificacion por palabras
// clave Y calificacion numerica juntas), para que el panel pueda filtrar
// por fecha/rango en el navegador y recalcular ahi tanto la tabla de
// calificaciones como las estadisticas por palabras clave con el MISMO
// criterio de fecha, sin tener que pedir dos veces al servidor.
async function satisfaccionDetalle(limit = 300) {
  const n = Math.min(Math.max(Number(limit) || 300, 1), 1000);
  const [rows] = await pool.query(
    `SELECT id, cuenta, telefono, canal, clasificacion, puntaje, detalle, creado_en
     FROM satisfaccion_log ORDER BY creado_en DESC LIMIT ${n}`
  );
  return rows.map((r) => ({
    id: r.id,
    cuenta: r.cuenta,
    telefono: r.telefono,
    canal: r.canal,
    clasificacion: r.clasificacion,
    puntaje: r.puntaje,
    nps: r.puntaje !== null ? claseNps(r.puntaje) : null,
    detalle: r.detalle,
    creado_en: r.creado_en ? String(r.creado_en).replace(" ", "T") + "Z" : null,
  }));
}

// Registro de cada derivacion a un agente "fake" -- lo que hace visible en
// el panel interno (y auditable) que la derivacion realmente ocurrio, con
// que agente y con que contexto se le paso.
async function registrarDerivacion(cuenta, canal, telefono, agenteNombre, agenteArea, contexto) {
  await pool.query(
    "INSERT INTO derivaciones_asesor (cuenta, canal, telefono, agente_nombre, agente_area, contexto) VALUES (?, ?, ?, ?, ?, ?)",
    [cuenta || null, canal, telefono || null, agenteNombre, agenteArea, contexto ? String(contexto).slice(0, 2000) : null]
  );
}

// Recorre TODAS las interacciones que pasaron por Claude (hechos != null,
// las deterministicas no aplican -- no hay nada que alucinar) y repite la
// MISMA verificacion que ya hace el panel por mensaje (todo monto S/X.XX
// citado en la respuesta debe existir en los hechos que se le pasaron a la
// IA), pero agregada en un porcentaje global -- para poder asegurar en todo
// momento que el sistema sigue en 0% alucinaciones financieras.
function _montosDeHechos(obj, acc) {
  acc = acc || new Set();
  if (obj === null || obj === undefined) return acc;
  if (typeof obj === "number") { acc.add(obj.toFixed(2)); return acc; }
  if (Array.isArray(obj)) { obj.forEach((v) => _montosDeHechos(v, acc)); return acc; }
  if (typeof obj === "object") { Object.values(obj).forEach((v) => _montosDeHechos(v, acc)); return acc; }
  return acc;
}
function _montosDeTexto(texto) {
  const matches = (texto || "").match(/\d[\d,]*\.\d{2}/g) || [];
  return [...new Set(matches.map((m) => Number(m.replace(/,/g, "")).toFixed(2)))];
}

async function metricasAlucinaciones() {
  const [rows] = await pool.query("SELECT hechos, respuesta FROM interacciones_log WHERE hechos IS NOT NULL");
  let sinAlucinaciones = 0;
  const flagueadas = [];
  for (const r of rows) {
    const hechos = typeof r.hechos === "string" ? JSON.parse(r.hechos) : r.hechos;
    const montosHechos = _montosDeHechos(hechos);
    const montosResp = _montosDeTexto(r.respuesta);
    const sinRespaldo = montosResp.filter((m) => !montosHechos.has(m));
    if (sinRespaldo.length === 0) {
      sinAlucinaciones++;
    } else {
      flagueadas.push({ montos_sin_respaldo: sinRespaldo, respuesta: r.respuesta });
    }
  }
  const total = rows.length;
  return {
    total_analizadas: total,
    sin_alucinaciones: sinAlucinaciones,
    con_alerta: flagueadas.length,
    porcentaje_confiable: total ? Number(((sinAlucinaciones / total) * 100).toFixed(1)) : 100,
    flagueadas: flagueadas.slice(0, 10),
  };
}

// Cuantos clientes distintos (por telefono si es WhatsApp, por cuenta si es
// web) tuvieron al menos una interaccion cada dia, para el grafico de
// "clientes atendidos por dia".
async function clientesPorDia(dias = 14) {
  const [rows] = await pool.query(
    `SELECT DATE(creado_en) AS dia, COUNT(DISTINCT COALESCE(telefono, cuenta)) AS clientes
     FROM interacciones_log
     WHERE creado_en >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY DATE(creado_en) ORDER BY dia`,
    [dias]
  );
  return rows.map((r) => ({ dia: String(r.dia).slice(0, 10), clientes: r.clientes }));
}

// Un solo recorrido de interacciones_log para dos cosas a la vez: (1) que
// causa de variacion aparece mas seguido (el "problema mas repetido" que
// pide el panel), y (2) cuantas veces se mostro de verdad el beneficio del
// Efecto Efervescente (queda registrado dentro de "hechos.beneficio" cuando
// aplica -- ver llm.js).
async function analiticaCausasYBeneficio() {
  const [rows] = await pool.query("SELECT hechos FROM interacciones_log WHERE hechos IS NOT NULL");
  const conteoCausas = {};
  let beneficioMostrado = 0;
  for (const r of rows) {
    const hechos = typeof r.hechos === "string" ? JSON.parse(r.hechos) : r.hechos;
    if (hechos && hechos.beneficio) beneficioMostrado++;
    const causas = hechos?.causas || [];
    for (const c of causas) {
      if (!c?.tipo) continue;
      conteoCausas[c.tipo] = (conteoCausas[c.tipo] || 0) + 1;
    }
  }
  const problemasFrecuentes = Object.entries(conteoCausas)
    .map(([tipo, total]) => ({ tipo, total }))
    .sort((a, b) => b.total - a.total);
  return { problemasFrecuentes, beneficioMostrado };
}

async function derivacionesTotal() {
  const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM derivaciones_asesor");
  return total;
}

async function derivacionesRecientes(limit = 30) {
  const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const [rows] = await pool.query(
    `SELECT id, cuenta, canal, telefono, agente_nombre, agente_area, contexto, creado_en
     FROM derivaciones_asesor ORDER BY id DESC LIMIT ${n}`
  );
  return rows.map((r) => ({
    ...r,
    creado_en: r.creado_en ? String(r.creado_en).replace(" ", "T") + "Z" : null,
  }));
}

// Log de auditoria "0% alucinaciones" (dashboard interno, no lo ve el
// cliente): guarda los hechos exactos que se le pasaron a Claude junto con
// lo que respondio, para poder demostrar despues que nunca cito un monto
// fuera de esos hechos. No bloqueante -- si falla el log, la respuesta al
// cliente ya se envio de todos modos.
async function registrarInteraccion(cuenta, canal, hechos, respuesta, mensajeCliente = null, telefono = null) {
  try {
    await pool.query(
      "INSERT INTO interacciones_log (cuenta, canal, telefono, mensaje_cliente, hechos, respuesta) VALUES (?, ?, ?, ?, ?, ?)",
      [cuenta || null, canal, telefono, mensajeCliente, JSON.stringify(hechos), respuesta]
    );
  } catch (e) {
    console.error("No se pudo registrar interaccion:", e.message);
  }
}

async function interaccionesRecientes(limit = 30) {
  const n = Math.min(Math.max(Number(limit) || 30, 1), 500);
  const [rows] = await pool.query(
    `SELECT id, cuenta, canal, telefono, mensaje_cliente, hechos, respuesta, creado_en
     FROM interacciones_log ORDER BY id DESC LIMIT ${n}`
  );
  return rows.map((r) => ({
    id: r.id,
    cuenta: r.cuenta,
    canal: r.canal,
    telefono: r.telefono,
    mensaje_cliente: r.mensaje_cliente,
    hechos: typeof r.hechos === "string" ? JSON.parse(r.hechos) : r.hechos,
    respuesta: r.respuesta,
    // creado_en viene del servidor en UTC -- se le agrega la 'Z' para que
    // el navegador lo interprete correctamente y lo pueda convertir a la
    // hora de Lima al mostrarlo (si no, JS lo toma como si ya fuera local).
    creado_en: r.creado_en ? String(r.creado_en).replace(" ", "T") + "Z" : null,
  }));
}

module.exports = {
  buscarCuenta, recibosDeCuenta, diagnosticar, buscarCasosDemo, LOB_LABELS,
  buscarBeneficioDestacado, registrarSatisfaccion, metricasSatisfaccion,
  historialRecibos, resolverReferenciaPorMes, resolverReferenciaPorPosicion,
  detalleRecibo, registrarConsulta, registrarInteraccion, interaccionesRecientes,
  registrarCalificacion, metricasCalificacion, registrarDerivacion, derivacionesRecientes,
  registrarObservacionMejora, calificacionesPorDia, calificacionesDetalle, satisfaccionDetalle,
  metricasAlucinaciones, clientesPorDia, analiticaCausasYBeneficio, derivacionesTotal,
};
