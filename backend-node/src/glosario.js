// Base de conocimiento fija (no editable por el modelo) con las definiciones
// oficiales de conceptos de facturacion. El "grounding" es directo porque el
// universo de conceptos es chico y cerrado.

const DEFINICIONES = {
  prorrateo:
    "Es el cobro proporcional por los días que disfrutaste de un servicio nuevo, " +
    "desde la fecha de instalación o activación hasta el primer día de tu ciclo " +
    "habitual de facturación. No es un cobro doble: es el ajuste estricto de los " +
    "días consumidos antes de que empezara tu mes cobrado por adelantado.",
  mora:
    "Es el recargo administrativo que se aplica automáticamente en el recibo " +
    "siguiente cuando un pago se realiza después de la fecha de vencimiento.",
  reconexion:
    "Es el cargo que se aplica cuando tu servicio fue suspendido por falta de pago " +
    "y luego se reactivó. Cubre el costo operativo de restablecer la conexión.",
  roaming:
    "Ocurre cuando usas datos o llamadas fuera del Perú sin haber contratado un " +
    "paquete específico de Roaming. Se cobra la tarifa estándar por MB o por día " +
    "según la zona tarifaria internacional del país donde estuviste.",
  fin_descuento:
    "Es el término de una promoción o descuento temporal (por ejemplo, fidelización " +
    "o un porcentaje de descuento por unos meses). Al vencer, el recibo vuelve a " +
    "reflejar el precio regular del servicio.",
  financiamiento:
    "Es la cuota mensual de un equipo (celular, router, etc.) que compraste a " +
    "plazos junto con tu servicio. Se cobra hasta completar el número de cuotas pactadas.",
  nota_credito:
    "Es un ajuste a tu favor aplicado por la empresa (por un reclamo resuelto, " +
    "un error de facturación corregido u otro motivo) que reduce lo que debes pagar.",
  cambio_plan:
    "Es una modificación de tu plan o servicio contratado (upgrade, downgrade, " +
    "adición de un paquete) que cambia el monto fijo mensual.",
};

function definir(termino) {
  return DEFINICIONES[termino] || null;
}

module.exports = { DEFINICIONES, definir };
