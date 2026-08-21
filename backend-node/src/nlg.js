// Capa de redaccion por PLANTILLAS. Nunca inventa un numero: solo recibe un
// diagnostico ya calculado por engine.js y lo convierte en frases en
// espanol simple.
const { definir } = require("./glosario");

function fmt(monto) {
  return `S/ ${Number(monto).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fraseCausa(c) {
  const d = c.detalle;
  switch (c.tipo) {
    case "prorrateo":
      return `**Prorrateo** de ${fmt(c.monto)}: activaste un servicio nuevo y se te cobró la parte proporcional de los días entre el ${d.desde} y el ${d.hasta}, antes de que empezara tu ciclo habitual de facturación.`;
    case "reconexion":
      return `**Cargo por reconexión** de ${fmt(c.monto)}: tu servicio se suspendió el ${d.fecha_corte} por falta de pago y se reactivó el ${d.fecha_reconexion}.`;
    case "fin_descuento":
      return `**Fin de descuento** (${d.concepto}): esa promoción duró ${d.duro_meses} meses y venció el ${d.fecha_fin}, así que ahora se factura el precio regular (dejaste de recibir un descuento de ${fmt(c.monto)}).`;
    case "financiamiento":
      return `**Cuota de equipo financiado** de ${fmt(c.monto)}: ${d.concepto}.`;
    case "cambio_plan":
      return `**Cambio en tu servicio** el ${d.fecha} (${d.accion}, motivo: ${d.motivo}), lo que también puede explicar cambios en tu monto.`;
    case "nota_credito":
      return `Se aplicó una **${d.clase}** de ${fmt(Math.abs(c.monto))} (${d.charge_code}).`;
    default:
      return `**${d.concepto}**: cargo adicional de ${fmt(c.monto)}.`;
  }
}

function explicarVariacion(diag) {
  if (!diag.encontrado) return diag.error || "No pudimos procesar tu consulta.";

  const partes = [];

  if (!diag.recibo_previo) {
    partes.push(
      `Este es el **primer recibo** de esta línea (${fmt(diag.total_actual)}), por eso no hay uno anterior con qué compararlo. Aun así, te explico los cargos:`
    );
    for (const c of [...diag.causas].sort((a, b) => Math.abs(b.monto) - Math.abs(a.monto)).slice(0, 4)) {
      partes.push(`- ${fraseCausa(c)}`);
    }
    return partes.join("\n\n");
  }

  partes.push(`Tu recibo actual es de **${fmt(diag.total_actual)}** y el anterior fue de **${fmt(diag.total_previo)}**.`);

  if (Math.abs(diag.diferencia) < 0.5) {
    partes.push("Prácticamente no hubo variación entre un mes y otro. 👍");
    return partes.join(" ");
  }

  if (diag.diferencia > 0) {
    partes.push(`Eso es **${fmt(diag.diferencia)} más** que el mes pasado. Aquí el motivo:`);
  } else {
    partes.push(`¡Buenas noticias! Pagas **${fmt(Math.abs(diag.diferencia))} menos** que el mes pasado.`);
    if (!diag.causas.length) return partes.join(" ");
    partes.push("Aun así, hubo estos movimientos en tu recibo:");
  }

  const causasRelevantes = diag.causas.filter((c) => c.monto && Math.abs(c.monto) >= 0.5);
  if (!causasRelevantes.length) {
    partes.push(
      "No encontramos una causa específica en las reglas automatizadas para este monto. Te recomendamos hablar con un asesor: ya dejamos cargado el contexto de tu consulta."
    );
    return partes.join("\n\n");
  }

  const mostradas = [...causasRelevantes].sort((a, b) => Math.abs(b.monto) - Math.abs(a.monto)).slice(0, 4);
  for (const c of mostradas) partes.push(`- ${fraseCausa(c)}`);

  const sumaCausas = mostradas.reduce((s, c) => s + c.monto, 0);
  if (diag.diferencia > 0 && sumaCausas > diag.diferencia * 1.3) {
    partes.push(
      "_Nota: estos movimientos suman más que la diferencia total porque hubo otros cambios en tu cuenta ese mismo mes que compensaron parte del monto (por ejemplo, un bono o descuento nuevo). Si quieres el desglose línea por línea, pídeme el detalle._"
    );
  }

  return partes.join("\n\n");
}

function responderDefinicion(termino) {
  const definicion = definir(termino);
  if (!definicion) return "No tengo esa definición en mi base de conceptos de facturación.";
  return definicion;
}

function resumenParaAsesor(diag) {
  if (!diag.encontrado) return `Cuenta ${diag.cuenta}: ${diag.error}`;
  const causasTxt = diag.causas.length
    ? diag.causas.map((c) => `${c.tipo}(${fmt(c.monto)})`).join("; ")
    : "sin causa detectada";
  return (
    `[Contexto auto-generado] Cuenta ${diag.cuenta} | Recibo actual ${diag.recibo_actual} ` +
    `(${fmt(diag.total_actual)}) vs previo ${diag.recibo_previo} (${fmt(diag.total_previo)}) | ` +
    `Diferencia ${fmt(diag.diferencia)} | Causas detectadas: ${causasTxt}`
  );
}

module.exports = { explicarVariacion, responderDefinicion, resumenParaAsesor };
