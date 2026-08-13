"""
Motor de comparacion y diagnostico de recibos.

Este modulo NO redacta texto para el cliente: solo calcula numeros y
clasifica causas verificadas contra las tablas de datos. La capa de
lenguaje (templates.py) solo puede hablar sobre lo que este modulo
devuelve, nunca inventa cifras.
"""
from dataclasses import dataclass, field
from functools import lru_cache
import pandas as pd

import data_loader as dl

UMBRAL_IGNORAR = 0.5  # diferencias menores a S/0.5 no se explican, son redondeos

LOB_LABELS = {
    "WRLS": "Línea Móvil",
    "BB": "Internet Hogar",
    "ShEq": "Equipo/Router de Internet",
    "TV": "TV",
    "VOIC": "Línea Fija (Voz)",
}


@dataclass
class Linea:
    anexo: str    # = SUBSCRIBER_KEY en FACTURACION-CLIENTES
    tipo: str
    etiqueta: str
    negocio: str


@dataclass
class Causa:
    tipo: str            # "prorrateo" | "reconexion" | "fin_descuento" | "financiamiento" | "cambio_plan" | "nota_credito" | "otro"
    monto: float
    detalle: dict = field(default_factory=dict)


@dataclass
class Diagnostico:
    cuenta: str
    encontrado: bool
    error: str | None = None
    recibo_actual: str | None = None
    recibo_previo: str | None = None
    ciclo_actual: int | None = None
    ciclo_previo: int | None = None
    total_actual: float = 0.0
    total_previo: float = 0.0
    monto_habitual: float = 0.0   # promedio de los recibos previos disponibles (hasta 5)
    diferencia: float = 0.0
    causas: list = field(default_factory=list)
    historial: list = field(default_factory=list)  # totales de hasta 6 recibos, mas reciente primero


def buscar_cuenta(cuenta: str) -> list[Linea] | None:
    """'Identifica' al cliente por su numero de cuenta (el equivalente a que
    el bot real ya sepa quien eres una vez autenticado). Devuelve la lista
    de servicios/lineas que tiene esa cuenta, o None si no existe."""
    idx = dl.planta_by_account()
    sub = idx.get(str(cuenta).strip())
    if sub is None or sub.empty:
        return None
    lineas = []
    for _, row in sub.iterrows():
        tipo = row["lob_type"]
        lineas.append(Linea(
            anexo=row["NUM_ANEXO"],
            tipo=tipo,
            etiqueta=LOB_LABELS.get(tipo, tipo),
            negocio=row["negocio"],
        ))
    return lineas


def _lineas_de_cuenta(cuenta: str, linea: str | None = None) -> pd.DataFrame:
    idx = dl.facturacion_by_account()
    sub = idx.get(cuenta, dl.load_facturacion().iloc[0:0])
    if linea:
        sub = sub[sub["SUBSCRIBER_KEY"] == linea]
    return sub


@lru_cache(maxsize=8192)
def recibos_de_cuenta(cuenta: str, linea: str | None = None) -> pd.DataFrame:
    sub = _lineas_de_cuenta(cuenta, linea)
    if sub.empty:
        return sub
    agg = sub.groupby(["LEGAL_INVOICE_NUMBER", "ciclo"], as_index=False).agg(
        total=("CHARGE_TOTAL_AMOUNT", "sum"),
        customer_key=("CUSTOMER_KEY", "first"),
        subscriber_key=("SUBSCRIBER_KEY", "first"),
    )
    agg = agg.sort_values("ciclo", ascending=False).reset_index(drop=True)
    return agg


def _lineas_de_recibo(cuenta: str, recibo: str, linea: str | None = None) -> pd.DataFrame:
    sub = _lineas_de_cuenta(cuenta, linea)
    return sub[sub["LEGAL_INVOICE_NUMBER"] == recibo]


def _detectar_prorrateo(recibo_actual: str) -> Causa | None:
    idx = dl.brainy_prorrateo_by_recibo()
    row = idx.get(recibo_actual)
    if row is None:
        return None
    return Causa(
        tipo="prorrateo",
        monto=float(row["suma_prorrateo"]),
        detalle={
            "desde": str(row["fecha_inicio_minima"].date()) if pd.notna(row["fecha_inicio_minima"]) else None,
            "hasta": str(row["fecha_fin_maxima"].date()) if pd.notna(row["fecha_fin_maxima"]) else None,
            "cargos_involucrados": int(row["Q_cargos"]) if pd.notna(row["Q_cargos"]) else None,
        },
    )


def _detectar_reconexion(recibo_actual: str) -> Causa | None:
    idx = dl.brainy_reconexiones_by_recibo()
    row = idx.get(recibo_actual)
    if row is None:
        return None
    return Causa(
        tipo="reconexion",
        monto=float(row["Monto"]),
        detalle={
            "descripcion": row["Descripcion"],
            "fecha_corte": str(row["FechaCorte"].date()) if pd.notna(row["FechaCorte"]) else None,
            "fecha_reconexion": str(row["FechaReconexion"].date()) if pd.notna(row["FechaReconexion"]) else None,
        },
    )


def _detectar_fin_descuento(cuenta: str, periodo_inicio, periodo_fin) -> list[Causa]:
    idx = dl.brainy_descuentos_by_account()
    sub = idx.get(cuenta)
    if sub is None or sub.empty or periodo_inicio is None or periodo_fin is None:
        return []
    causas = []
    vistos = set()
    for _, row in sub.iterrows():
        fecha_fin = row["FechaFin"]
        if pd.isna(fecha_fin):
            continue
        completo = row["flag_descuento_completo"] == 1
        # el descuento vencio justo dentro del periodo facturado del recibo actual
        if completo and periodo_inicio <= fecha_fin <= periodo_fin:
            clave = (row["Descripcion"], round(float(row["Monto_Descuento"]), 2))
            if clave in vistos:
                continue
            vistos.add(clave)
            causas.append(Causa(
                tipo="fin_descuento",
                monto=float(row["Monto_Descuento"]),
                detalle={
                    "concepto": row["Descripcion"],
                    "duro_meses": int(row["PromotionDuration"]) if pd.notna(row["PromotionDuration"]) else None,
                    "fecha_fin": str(fecha_fin.date()),
                },
            ))
    return causas


def _detectar_financiamiento(lineas_nuevas: pd.DataFrame) -> list[Causa]:
    causas = []
    fin = lineas_nuevas[lineas_nuevas["CHARGE_CODE_CLASSIFICATION"].str.contains("financiamiento", case=False, na=False)]
    for _, row in fin.iterrows():
        causas.append(Causa(
            tipo="financiamiento",
            monto=float(row["CHARGE_TOTAL_AMOUNT"]),
            detalle={"concepto": row["CHARGE_CODE_DESC"], "charge_code_id": row["CHARGE_CODE_ID"]},
        ))
    return causas


def _detectar_cambio_plan(customer_key: str, periodo_inicio, periodo_fin, subscriber_key: str | None = None) -> list[Causa]:
    if periodo_inicio is None or periodo_fin is None:
        return []
    idx = dl.ordenes_by_customer()
    sub = idx.get(customer_key)
    if sub is None or sub.empty:
        return []
    if subscriber_key:
        sub = sub[sub["SUBSCRIBER_KEY"] == subscriber_key]
    if sub.empty:
        return []
    mask = (sub["ORDER_ACTION_COMPLETION_DATE"] >= periodo_inicio) & (sub["ORDER_ACTION_COMPLETION_DATE"] <= periodo_fin)
    sub = sub[mask]
    causas = []
    for _, row in sub.iterrows():
        causas.append(Causa(
            tipo="cambio_plan",
            monto=0.0,  # el monto ya esta reflejado en las lineas de cargo, esto es contexto
            detalle={
                "accion": row["ORDER_ITEM_TYPE_DESC"],
                "motivo": row["ORDER_ACTION_REASON_DESC"],
                "fecha": str(row["ORDER_ACTION_COMPLETION_DATE"].date()) if pd.notna(row["ORDER_ACTION_COMPLETION_DATE"]) else None,
            },
        ))
    return causas


def _detectar_notas_credito(cuenta: str, subscriber_key: str, periodo_inicio, periodo_fin) -> list[Causa]:
    idx = dl.notas_credito_by_account()
    sub = idx.get(cuenta)
    if sub is None or sub.empty:
        return []
    sub = sub[sub["SERVICE_RECEIVER_ID"] == subscriber_key]
    if periodo_inicio is not None and periodo_fin is not None:
        sub = sub[(sub["EFFECTIVE_DATE"] >= periodo_inicio) & (sub["EFFECTIVE_DATE"] <= periodo_fin)]
    causas = []
    for _, row in sub.iterrows():
        tipo_texto = "nota de credito" if row["CANCEL_CHARGE_TYPE"] == "CRD" else "nota de debito"
        causas.append(Causa(
            tipo="nota_credito",
            monto=float(row["AMOUNT"]),
            detalle={"clase": tipo_texto, "charge_code": row["CHARGE_CODE"]},
        ))
    return causas


def diagnosticar(cuenta: str, recibo: str | None = None, linea: str | None = None) -> Diagnostico:
    """Diagnostica un recibo de una cuenta comparandolo con el inmediatamente
    anterior. Si `recibo` es None, usa el mas reciente (caso de uso normal:
    'por que subio mi ULTIMO recibo'). Si se pasa un numero de recibo
    puntual, permite revisar cualquier recibo del historial (el cliente
    puede tocar cualquiera de los 6 que muestra la App). Si `linea` (=
    SUBSCRIBER_KEY / NUM_ANEXO) se especifica, el diagnostico se acota a
    los cargos de ESA linea dentro del recibo consolidado de la cuenta
    (una cuenta Movistar Total puede tener movil + internet + TV en un
    solo recibo)."""
    cuenta = str(cuenta).strip()
    recibos = recibos_de_cuenta(cuenta, linea)
    if recibos.empty:
        return Diagnostico(cuenta=cuenta, encontrado=False, error="No encontramos esa cuenta (o esa línea) en el sistema.")

    if recibo is None:
        idx_actual = 0
    else:
        coincidencias = recibos.index[recibos["LEGAL_INVOICE_NUMBER"] == recibo].tolist()
        if not coincidencias:
            return Diagnostico(cuenta=cuenta, encontrado=False, error="Ese recibo no pertenece a esta cuenta.")
        idx_actual = coincidencias[0]

    if idx_actual + 1 >= len(recibos):
        # No hay recibo previo -- tipicamente porque es el PRIMER recibo de la
        # linea (activacion nueva). Un prorrateo puede explicarse igual sin
        # necesidad de comparar contra un recibo anterior que no existe.
        actual = recibos.iloc[idx_actual]
        causa_prorrateo = _detectar_prorrateo(actual["LEGAL_INVOICE_NUMBER"])
        if causa_prorrateo:
            return Diagnostico(
                cuenta=cuenta,
                encontrado=True,
                recibo_actual=actual["LEGAL_INVOICE_NUMBER"],
                recibo_previo=None,
                ciclo_actual=int(actual["ciclo"]),
                ciclo_previo=None,
                total_actual=round(float(actual["total"]), 2),
                total_previo=0.0,
                monto_habitual=0.0,
                diferencia=round(float(actual["total"]), 2),
                causas=[causa_prorrateo],
                historial=[{"recibo": actual["LEGAL_INVOICE_NUMBER"], "ciclo": int(actual["ciclo"]), "total": round(float(actual["total"]), 2)}],
            )
        return Diagnostico(cuenta=cuenta, encontrado=False, error="No hay un recibo previo con el cual comparar (es el primer recibo de esta línea).")

    actual = recibos.iloc[idx_actual]
    previo = recibos.iloc[idx_actual + 1]
    historial_prev = recibos.iloc[idx_actual + 1: idx_actual + 6]  # hasta 5 previos

    df_actual = _lineas_de_recibo(cuenta, actual["LEGAL_INVOICE_NUMBER"], linea)
    df_previo = _lineas_de_recibo(cuenta, previo["LEGAL_INVOICE_NUMBER"], linea)

    periodo_inicio = pd.to_datetime(df_actual["PERIOD_START_DATE"], errors="coerce", format="mixed").min()
    periodo_fin = pd.to_datetime(df_actual["PERIOD_END_DATE"], errors="coerce", format="mixed").max()
    if pd.isna(periodo_inicio):
        periodo_inicio = None
    if pd.isna(periodo_fin):
        periodo_fin = None

    # delta neto por codigo de cargo entre el recibo actual y el previo
    prev_por_codigo = df_previo.groupby("CHARGE_CODE_ID")["CHARGE_TOTAL_AMOUNT"].sum()
    act_por_codigo = df_actual.groupby("CHARGE_CODE_ID")["CHARGE_TOTAL_AMOUNT"].sum()
    desc_por_codigo = df_actual.drop_duplicates("CHARGE_CODE_ID").set_index("CHARGE_CODE_ID")
    deltas_positivos = {
        code: float(act_por_codigo[code] - prev_por_codigo.get(code, 0.0))
        for code in act_por_codigo.index
        if act_por_codigo[code] - prev_por_codigo.get(code, 0.0) > UMBRAL_IGNORAR
    }
    lineas_relevantes = df_actual[df_actual["CHARGE_CODE_ID"].isin(deltas_positivos.keys())]

    causas: list[Causa] = []

    c = _detectar_prorrateo(actual["LEGAL_INVOICE_NUMBER"])
    if c:
        causas.append(c)

    c = _detectar_reconexion(actual["LEGAL_INVOICE_NUMBER"])
    if c:
        causas.append(c)

    causas += _detectar_fin_descuento(cuenta, periodo_inicio, periodo_fin)
    causas += _detectar_financiamiento(lineas_relevantes)
    causas += _detectar_cambio_plan(actual["customer_key"], periodo_inicio, periodo_fin, subscriber_key=linea)
    causas += _detectar_notas_credito(cuenta, actual["subscriber_key"], periodo_inicio, periodo_fin)

    # codigos ya explicados por una causa especifica no se repiten como "otro"
    codigos_explicados = set()
    for causa in causas:
        cod = causa.detalle.get("charge_code_id")
        if cod:
            codigos_explicados.add(cod)
    hay_reconexion = any(c.tipo == "reconexion" for c in causas)

    for code, delta in sorted(deltas_positivos.items(), key=lambda kv: -kv[1]):
        if code in codigos_explicados:
            continue
        fila = desc_por_codigo.loc[code] if code in desc_por_codigo.index else None
        clasif = str(fila["CHARGE_CODE_CLASSIFICATION"]) if fila is not None else ""
        grupo = str(fila["GRUPO"]) if fila is not None else ""
        if "financiamiento" in clasif.lower():
            continue  # ya cubierto por _detectar_financiamiento
        if hay_reconexion and "reconexion" in grupo.lower():
            continue  # ya cubierto por _detectar_reconexion
        causas.append(Causa(
            tipo="otro",
            monto=round(delta, 2),
            detalle={
                "concepto": str(fila["CHARGE_CODE_DESC"]) if fila is not None else code,
                "grupo": grupo or None,
            },
        ))

    diferencia = float(actual["total"]) - float(previo["total"])
    monto_habitual = float(historial_prev["total"].mean()) if not historial_prev.empty else float(previo["total"])

    historial = [
        {"recibo": r["LEGAL_INVOICE_NUMBER"], "ciclo": int(r["ciclo"]), "total": round(float(r["total"]), 2)}
        for _, r in recibos.iloc[idx_actual: idx_actual + 6].iterrows()
    ]

    return Diagnostico(
        cuenta=cuenta,
        encontrado=True,
        recibo_actual=actual["LEGAL_INVOICE_NUMBER"],
        recibo_previo=previo["LEGAL_INVOICE_NUMBER"],
        ciclo_actual=int(actual["ciclo"]),
        ciclo_previo=int(previo["ciclo"]),
        total_actual=round(float(actual["total"]), 2),
        total_previo=round(float(previo["total"]), 2),
        monto_habitual=round(monto_habitual, 2),
        diferencia=round(diferencia, 2),
        causas=causas,
        historial=historial,
    )


def _cuentas_con_historial() -> set:
    fact = dl.load_facturacion()
    return set(
        fact.groupby("FINANCIAL_ACCOUNT_KEY")["LEGAL_INVOICE_NUMBER"].nunique().loc[lambda s: s >= 2].index
    )


def _validar_por_recibo(pares_cuenta_recibo, tipo: str, por_tipo: int, cuentas_ok: set) -> list[dict]:
    """Para prorrateo/reconexion ya sabemos el recibo exacto donde ocurrio el
    evento (viene de la tabla BRAINY), asi que probamos ESE recibo puntual
    en vez de adivinar cual es 'el actual'. Rapido y 100% preciso."""
    validados, vistas = [], set()
    for cuenta, recibo in pares_cuenta_recibo:
        if cuenta in vistas or cuenta not in cuentas_ok:
            continue
        vistas.add(cuenta)
        diag = diagnosticar(cuenta, recibo=recibo)
        if diag.encontrado and any(c.tipo == tipo for c in diag.causas):
            validados.append({"cuenta": cuenta, "recibo": recibo, "diferencia": diag.diferencia, "total_actual": diag.total_actual})
        if len(validados) >= por_tipo:
            break
    return validados


def _validar_probando_historial(cuentas_candidatas, tipo: str, por_tipo: int, cuentas_ok: set) -> list[dict]:
    """Para fin_descuento/financiamiento no tenemos un recibo puntual desde
    el origen, asi que probamos los recibos disponibles de la cuenta (hasta
    6, el mismo universo que ve el cliente en la App) hasta encontrar el
    que muestra esa causa."""
    validados = []
    for cuenta in cuentas_candidatas:
        if cuenta not in cuentas_ok:
            continue
        recibos = recibos_de_cuenta(cuenta)
        for _, r in recibos.head(6).iterrows():
            diag = diagnosticar(cuenta, recibo=r["LEGAL_INVOICE_NUMBER"])
            if diag.encontrado and any(c.tipo == tipo for c in diag.causas):
                validados.append({"cuenta": cuenta, "recibo": r["LEGAL_INVOICE_NUMBER"], "diferencia": diag.diferencia, "total_actual": diag.total_actual})
                break
        if len(validados) >= por_tipo:
            break
    return validados


def _cuentas_multiservicio(cuentas_ok: set, cantidad: int) -> list[dict]:
    """Cuentas reales con mas de una linea/servicio (ej. movil + internet),
    para demostrar el flujo de 'esta cuenta tiene varios servicios, cual
    quieres revisar'."""
    idx = dl.planta_by_account()
    validados = []
    for cuenta, sub in idx.items():
        if cuenta not in cuentas_ok:
            continue
        anexos = sub["NUM_ANEXO"].unique()
        if len(anexos) > 1:
            validados.append({"cuenta": cuenta, "num_lineas": len(anexos)})
        if len(validados) >= cantidad:
            break
    return validados


def buscar_casos_demo(por_tipo: int = 3) -> dict:
    """Devuelve cuentas + numero de recibo reales que estan garantizados de
    mostrar cada uno de los 5 escenarios pedidos por la ficha del reto,
    para usarlos tal cual en la demo en vivo."""
    cuentas_ok = _cuentas_con_historial()
    fact = dl.load_facturacion()

    resultado = {}

    pr = dl.load_brainy_prorrateo()
    resultado["prorrateo"] = _validar_por_recibo(
        zip(pr["CuentaFinanciera"], pr["NumeroRecibo"]), "prorrateo", por_tipo, cuentas_ok
    )

    rc = dl.load_brainy_reconexiones()
    resultado["reconexion"] = _validar_por_recibo(
        zip(rc["CuentaFinanciera"], rc["NumeroRecibo"]), "reconexion", por_tipo, cuentas_ok
    )

    dc_cuentas = dl.load_brainy_descuentos()
    dc_cuentas = dc_cuentas[dc_cuentas["flag_descuento_completo"] == 1]["cuentafinanciera"].unique()
    resultado["fin_descuento"] = _validar_probando_historial(dc_cuentas, "fin_descuento", por_tipo, cuentas_ok)

    fin_cuentas = fact[fact["CHARGE_CODE_CLASSIFICATION"].str.contains("financiamiento", case=False, na=False)]["FINANCIAL_ACCOUNT_KEY"].unique()
    resultado["financiamiento"] = _validar_probando_historial(fin_cuentas, "financiamiento", por_tipo, cuentas_ok)

    resultado["multiservicio"] = _cuentas_multiservicio(cuentas_ok, por_tipo)

    return resultado


if __name__ == "__main__":
    import time
    t0 = time.time()
    dl.warm_up()
    print(f"warm_up: {time.time() - t0:.2f}s")

    t0 = time.time()
    demo = buscar_casos_demo()
    print(f"buscar_casos_demo: {time.time() - t0:.2f}s")

    for tipo, items in demo.items():
        print(f"\n=== {tipo} ({len(items)} encontrados) ===")
        if tipo == "multiservicio":
            for item in items:
                lineas = buscar_cuenta(item["cuenta"])
                print(f"Cuenta {item['cuenta']}: {[l.etiqueta for l in lineas]}")
            continue
        for item in items:
            diag = diagnosticar(item["cuenta"], recibo=item["recibo"])
            print(f"Cuenta {item['cuenta']} recibo {item['recibo']}: actual={diag.total_actual} previo={diag.total_previo} diff={diag.diferencia}")
            for causa in diag.causas:
                print(f"   -> {causa.tipo}: S/{causa.monto} {causa.detalle}")
