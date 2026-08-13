"""
Base de conocimiento fija (no editable por el modelo) con las definiciones
oficiales de conceptos de facturacion. Esto es lo que un LLM real
consultaria via RAG; aqui la "recuperacion" es directa porque el universo
de conceptos es chico y cerrado -- sigue siendo grounding estricto: el
texto de las definiciones nunca lo inventa el sistema.
"""

DEFINICIONES = {
    "prorrateo": (
        "Es el cobro proporcional por los dias que disfrutaste de un servicio nuevo, "
        "desde la fecha de instalacion o activacion hasta el primer dia de tu ciclo "
        "habitual de facturacion. No es un cobro doble: es el ajuste estricto de los "
        "dias consumidos antes de que empezara tu mes cobrado por adelantado."
    ),
    "mora": (
        "Es el recargo administrativo que se aplica automaticamente en el recibo "
        "siguiente cuando un pago se realiza despues de la fecha de vencimiento."
    ),
    "reconexion": (
        "Es el cargo que se aplica cuando tu servicio fue suspendido por falta de pago "
        "y luego se reactivo. Cubre el costo operativo de restablecer la conexion."
    ),
    "roaming": (
        "Ocurre cuando usas datos o llamadas fuera del Peru sin haber contratado un "
        "paquete especifico de Roaming. Se cobra la tarifa estandar por MB o por dia "
        "segun la zona tarifaria internacional del pais donde estuviste."
    ),
    "fin_descuento": (
        "Es el termino de una promocion o descuento temporal (por ejemplo, fidelizacion "
        "o un porcentaje de descuento por unos meses). Al vencer, el recibo vuelve a "
        "reflejar el precio regular del servicio."
    ),
    "financiamiento": (
        "Es la cuota mensual de un equipo (celular, router, etc.) que compraste a "
        "plazos junto con tu servicio. Se cobra hasta completar el numero de cuotas pactadas."
    ),
    "nota_credito": (
        "Es un ajuste a tu favor aplicado por la empresa (por un reclamo resuelto, "
        "un error de facturacion corregido u otro motivo) que reduce lo que debes pagar."
    ),
    "cambio_plan": (
        "Es una modificacion de tu plan o servicio contratado (upgrade, downgrade, "
        "adicion de un paquete) que cambia el monto fijo mensual."
    ),
}


def definir(termino: str) -> str | None:
    return DEFINICIONES.get(termino)
