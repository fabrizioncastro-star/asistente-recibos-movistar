"""
Orquestador conversacional: detecta la intencion del mensaje del cliente
(por reglas/keywords, sin LLM) y decide que hacer. Esta es la unica pieza
que "conversa"; internamente solo llama a engine.py (calculo) y nlg.py
(redaccion), nunca inventa datos por su cuenta.
"""
import re
import unicodedata

import engine
import nlg

SALUDOS = {"hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "hey"}
PALABRAS_ASESOR = {"asesor", "humano", "persona", "agente", "hablar con alguien", "representante"}
PALABRAS_PAGAR = {"pagar", "como pago", "donde pago", "quiero pagar"}
PALABRAS_DETALLE = {"detalle", "desglose", "desglosar", "ver detalle", "historial", "comparar"}
PALABRAS_CAMBIAR_LINEA = {"otra linea", "otro servicio", "mis lineas", "mis servicios", "cambiar de linea", "ver mis lineas"}

TERMINOS_GLOSARIO = {
    "prorrateo": ["prorrateo", "prorratear"],
    "mora": ["mora", "recargo", "extemporaneo", "pago tardio"],
    "reconexion": ["reconexion", "reconectar"],
    "roaming": ["roaming", "itinerancia"],
    "fin_descuento": ["descuento", "promocion", "promo"],
    "financiamiento": ["financiamiento", "cuota del equipo", "cuotas del celular"],
    "nota_credito": ["nota de credito", "nota de debito"],
    "cambio_plan": ["cambio de plan"],
}


def _normalizar(texto: str) -> str:
    texto = texto.lower().strip()
    texto = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode("ascii")
    return texto


def _contiene_alguna(texto: str, palabras) -> bool:
    return any(p in texto for p in palabras)


def _detectar_termino_glosario(texto: str) -> str | None:
    for termino, variantes in TERMINOS_GLOSARIO.items():
        if _contiene_alguna(texto, variantes):
            return termino
    return None


class Respuesta:
    def __init__(self, texto: str, acciones: list[str] | None = None, contexto_asesor: str | None = None):
        self.texto = texto
        self.acciones = acciones or []
        self.contexto_asesor = contexto_asesor

    def to_dict(self):
        return {"respuesta": self.texto, "acciones": self.acciones, "contexto_asesor": self.contexto_asesor}


def responder(cuenta: str, mensaje: str, recibo: str | None = None, linea: str | None = None) -> Respuesta:
    texto = _normalizar(mensaje)

    if not cuenta:
        return Respuesta("Primero necesito identificar tu cuenta para poder revisar tu recibo.")

    if _contiene_alguna(texto, PALABRAS_CAMBIAR_LINEA):
        lineas = engine.buscar_cuenta(cuenta)
        if lineas and len(lineas) > 1:
            listado = "\n".join(f"- **{l.etiqueta}** (línea •••{l.anexo[-4:]})" for l in lineas)
            return Respuesta(f"Tu cuenta tiene estos servicios:\n\n{listado}\n\n¿Sobre cuál quieres consultar?")
        return Respuesta("Tu cuenta tiene un solo servicio, así que ya estamos viendo el correcto. 🙂")

    if _contiene_alguna(texto, PALABRAS_ASESOR):
        diag = engine.diagnosticar(cuenta, recibo=recibo, linea=linea)
        contexto = nlg.resumen_para_asesor(diag)
        return Respuesta(
            "Listo, te conecto con un asesor y ya le compartí el contexto de tu consulta "
            "(tu recibo, el anterior, y la causa detectada) para que no tengas que repetir todo.",
            acciones=["derivar_asesor"],
            contexto_asesor=contexto,
        )

    if _contiene_alguna(texto, PALABRAS_PAGAR):
        diag = engine.diagnosticar(cuenta, recibo=recibo, linea=linea)
        if diag.encontrado:
            return Respuesta(
                f"Tu monto a pagar de este ciclo es **S/ {diag.total_actual:,.2f}**. "
                f"Puedes pagarlo desde esta misma App con Yape, Plin o tarjeta.",
                acciones=["ir_a_pagar"],
            )
        return Respuesta(diag.error or "No encontré tu recibo para procesar el pago.")

    termino = _detectar_termino_glosario(texto)
    if termino and not _contiene_alguna(texto, {"mi recibo", "mi caso", "por que"}):
        definicion = nlg.responder_definicion(termino)
        return Respuesta(f"**{termino.replace('_', ' ').capitalize()}**: {definicion}")

    if _contiene_alguna(texto, SALUDOS) and len(texto) < 20:
        return Respuesta(
            "¡Hola! Soy tu asistente de facturación. Puedo explicarte por qué varió tu recibo, "
            "qué significa cada cargo, o ponerte en contacto con un asesor. ¿Qué necesitas?"
        )

    # Por defecto: el caso de uso principal del reto es "explicar el recibo"
    diag = engine.diagnosticar(cuenta, recibo=recibo, linea=linea)
    texto_resp = nlg.explicar_variacion(diag)

    if diag.encontrado and diag.diferencia > 0.5:
        return Respuesta(
            texto_resp,
            acciones=["ver_detalle", "pagar", "hablar_con_asesor"],
        )
    return Respuesta(texto_resp)
