"""
Capa de redaccion (Natural Language Generation) por PLANTILLAS.

Regla de oro: esta capa NUNCA inventa un numero. Solo recibe un
Diagnostico ya calculado por engine.py y lo convierte en frases en
espanol simple. Si mas adelante se conecta un LLM real, este modulo es
el que se reemplaza (o se usa como "grounding" del prompt) -- la logica
de calculo de engine.py no cambia.
"""
from engine import Diagnostico, Causa
import glosario

CAUSA_LABELS = {
    "prorrateo": "Prorrateo",
    "reconexion": "Cargo por reconexión",
    "fin_descuento": "Fin de descuento/promoción",
    "financiamiento": "Cuota de equipo financiado",
    "cambio_plan": "Cambio de plan/servicio",
    "nota_credito": "Ajuste (nota de crédito/débito)",
    "otro": "Cargo adicional",
}


def _fmt(monto: float) -> str:
    return f"S/ {monto:,.2f}"


def _frase_causa(c: Causa) -> str:
    if c.tipo == "prorrateo":
        d = c.detalle
        return (
            f"**Prorrateo** de {_fmt(c.monto)}: activaste un servicio nuevo y se te cobró "
            f"la parte proporcional de los días entre el {d.get('desde')} y el {d.get('hasta')}, "
            f"antes de que empezara tu ciclo habitual de facturación."
        )
    if c.tipo == "reconexion":
        d = c.detalle
        return (
            f"**Cargo por reconexión** de {_fmt(c.monto)}: tu servicio se suspendió el "
            f"{d.get('fecha_corte')} por falta de pago y se reactivó el {d.get('fecha_reconexion')}."
        )
    if c.tipo == "fin_descuento":
        d = c.detalle
        return (
            f"**Fin de descuento** ({d.get('concepto')}): esa promoción duró {d.get('duro_meses')} "
            f"meses y venció el {d.get('fecha_fin')}, así que ahora se factura el precio regular "
            f"(dejaste de recibir un descuento de {_fmt(c.monto)})."
        )
    if c.tipo == "financiamiento":
        return f"**Cuota de equipo financiado** de {_fmt(c.monto)}: {c.detalle.get('concepto')}."
    if c.tipo == "cambio_plan":
        d = c.detalle
        return (
            f"**Cambio en tu servicio** el {d.get('fecha')} ({d.get('accion')}, motivo: "
            f"{d.get('motivo')}), lo que también puede explicar cambios en tu monto."
        )
    if c.tipo == "nota_credito":
        d = c.detalle
        return f"Se aplicó una **{d.get('clase')}** de {_fmt(abs(c.monto))} ({d.get('charge_code')})."
    # otro
    return f"**{c.detalle.get('concepto')}**: cargo adicional de {_fmt(c.monto)}."


def explicar_variacion(diag: Diagnostico) -> str:
    if not diag.encontrado:
        return diag.error or "No pudimos procesar tu consulta."

    partes = []

    if diag.recibo_previo is None:
        partes.append(
            f"Este es el **primer recibo** de esta línea (**{_fmt(diag.total_actual)}**), "
            f"por eso no hay uno anterior con qué compararlo. Aun así, te explico los cargos:"
        )
        for c in sorted(diag.causas, key=lambda x: -abs(x.monto))[:4]:
            partes.append(f"- {_frase_causa(c)}")
        return "\n\n".join(partes)

    partes.append(
        f"Tu recibo actual es de **{_fmt(diag.total_actual)}** y el anterior fue de "
        f"**{_fmt(diag.total_previo)}**."
    )

    if abs(diag.diferencia) < 0.5:
        partes.append("Prácticamente no hubo variación entre un mes y otro. 👍")
        return " ".join(partes)

    if diag.diferencia > 0:
        partes.append(f"Eso es **{_fmt(diag.diferencia)} más** que el mes pasado. Aquí el motivo:")
    else:
        partes.append(f"¡Buenas noticias! Pagas **{_fmt(abs(diag.diferencia))} menos** que el mes pasado.")
        if not diag.causas:
            return " ".join(partes)
        partes.append("Aun así, hubo estos movimientos en tu recibo:")

    causas_relevantes = [c for c in diag.causas if c.monto and abs(c.monto) >= 0.5]
    if not causas_relevantes:
        partes.append(
            "No encontramos una causa específica en las reglas automatizadas para este monto. "
            "Te recomendamos hablar con un asesor: ya dejamos cargado el contexto de tu consulta."
        )
        return "\n\n".join(partes)

    mostradas = sorted(causas_relevantes, key=lambda x: -abs(x.monto))[:4]
    for c in mostradas:
        partes.append(f"- {_frase_causa(c)}")

    suma_causas = sum(c.monto for c in mostradas)
    if diag.diferencia > 0 and suma_causas > diag.diferencia * 1.3:
        partes.append(
            "_Nota: estos movimientos suman más que la diferencia total porque hubo otros "
            "cambios en tu cuenta ese mismo mes que compensaron parte del monto (por ejemplo, "
            "un bono o descuento nuevo). Si quieres el desglose línea por línea, pídeme el detalle._"
        )

    return "\n\n".join(partes)


def responder_definicion(termino: str) -> str:
    definicion = glosario.definir(termino)
    if not definicion:
        return "No tengo esa definición en mi base de conceptos de facturación."
    return definicion


def resumen_para_asesor(diag: Diagnostico) -> str:
    """Contexto compacto para el hand-off a un humano (Desafio 1 pide 'derivar con contexto')."""
    if not diag.encontrado:
        return f"Cuenta {diag.cuenta}: {diag.error}"
    causas_txt = "; ".join(f"{c.tipo}({_fmt(c.monto)})" for c in diag.causas) or "sin causa detectada"
    return (
        f"[Contexto auto-generado] Cuenta {diag.cuenta} | Recibo actual {diag.recibo_actual} "
        f"({_fmt(diag.total_actual)}) vs previo {diag.recibo_previo} ({_fmt(diag.total_previo)}) | "
        f"Diferencia {_fmt(diag.diferencia)} | Causas detectadas: {causas_txt}"
    )
