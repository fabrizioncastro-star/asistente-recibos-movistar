"""
Carga y cachea en memoria los datasets del Desafio 1 (Atencion inteligente
y explicacion de recibos). Todas las llaves de cruce se cargan como texto
(str) para evitar problemas de tipos entre archivos.
"""
from pathlib import Path
from functools import lru_cache
import pandas as pd

DATA_DIR = Path(r"D:\HACKATHON\drive-download-20260813T000916Z-1-001")


def _clean_key_series(s: pd.Series) -> pd.Series:
    """Normaliza columnas llave: quita espacios y sufijo '.0' de floats leidos como texto."""
    s = s.astype(str).str.strip()
    return s.str.replace(r"\.0$", "", regex=True)


@lru_cache(maxsize=1)
def load_facturacion() -> pd.DataFrame:
    df = pd.read_csv(
        DATA_DIR / "FACTURACION-CLIENTES_.csv",
        sep=";",
        dtype=str,
        encoding="utf-8",
    )
    df.columns = [c.strip() for c in df.columns]
    for col in ["FINANCIAL_ACCOUNT_KEY", "CUSTOMER_KEY", "BILLING_ARRANGEMENT_KEY",
                "SUBSCRIBER_KEY", "LEGAL_INVOICE_NUMBER", "CHARGE_CODE_ID"]:
        df[col] = _clean_key_series(df[col])
    df["CHARGE_TOTAL_AMOUNT"] = pd.to_numeric(df["CHARGE_TOTAL_AMOUNT"], errors="coerce").fillna(0.0)
    df["CHARGE_NET_AMOUNT"] = pd.to_numeric(df["CHARGE_NET_AMOUNT"], errors="coerce").fillna(0.0)
    df["ciclo"] = pd.to_numeric(df["ciclo"], errors="coerce").astype("Int64")
    return df


@lru_cache(maxsize=1)
def load_planta() -> pd.DataFrame:
    df = pd.read_csv(DATA_DIR / "PLANTA CLIENTES.csv", sep=";", dtype=str, encoding="utf-8")
    df.columns = [c.strip() for c in df.columns]
    df["FINANCIAL_ACCOUNT"] = _clean_key_series(df["FINANCIAL_ACCOUNT"])
    df["COD_CLIENTE"] = _clean_key_series(df["COD_CLIENTE"])
    return df


@lru_cache(maxsize=1)
def load_catalogo_ofertas() -> pd.DataFrame:
    df = pd.read_csv(DATA_DIR / "CATALOGO-OFERTAS.csv", sep=";", dtype=str, encoding="utf-8")
    df.columns = [c.strip() for c in df.columns]
    df["CHARGE CODE"] = _clean_key_series(df["CHARGE CODE"])
    df["rate_final"] = pd.to_numeric(df["rate_final"], errors="coerce")
    return df


@lru_cache(maxsize=1)
def load_ordenes() -> pd.DataFrame:
    df = pd.read_csv(DATA_DIR / "Ordenes.csv", sep=",", dtype=str, encoding="utf-8")
    df.columns = [c.strip() for c in df.columns]
    df["CUSTOMER_KEY"] = _clean_key_series(df["CUSTOMER_KEY"])
    df["SUBSCRIBER_KEY"] = _clean_key_series(df["SUBSCRIBER_KEY"])
    df["ORDER_ACTION_COMPLETION_DATE"] = pd.to_datetime(df["ORDER_ACTION_COMPLETION_DATE"], errors="coerce")
    return df


@lru_cache(maxsize=1)
def load_notas_credito() -> pd.DataFrame:
    df = pd.read_csv(DATA_DIR / "NOTAS_CREDITO.csv", sep=",", dtype=str, encoding="utf-8")
    df.columns = [c.strip() for c in df.columns]
    df["BA_NO"] = _clean_key_series(df["BA_NO"])
    df["SERVICE_RECEIVER_ID"] = _clean_key_series(df["SERVICE_RECEIVER_ID"])
    df["AMOUNT"] = pd.to_numeric(df["AMOUNT"], errors="coerce").fillna(0.0)
    df["EFFECTIVE_DATE"] = pd.to_datetime(df["EFFECTIVE_DATE"], errors="coerce")
    return df


@lru_cache(maxsize=1)
def load_brainy_prorrateo() -> pd.DataFrame:
    df = pd.read_csv(DATA_DIR / "BRAINY_PRORRATEO_ALTASV3.csv", sep=";", dtype=str, encoding="utf-8")
    df.columns = [c.strip() for c in df.columns]
    df["CuentaFinanciera"] = _clean_key_series(df["CuentaFinanciera"])
    df["NumeroRecibo"] = df["NumeroRecibo"].astype(str).str.strip()
    df["suma_prorrateo"] = pd.to_numeric(df["suma_prorrateo"], errors="coerce").fillna(0.0)
    df["fecha_inicio_minima"] = pd.to_datetime(df["fecha_inicio_minima"], errors="coerce", dayfirst=True)
    df["fecha_fin_maxima"] = pd.to_datetime(df["fecha_fin_maxima"], errors="coerce", dayfirst=True)
    return df


@lru_cache(maxsize=1)
def load_brainy_reconexiones() -> pd.DataFrame:
    df = pd.read_csv(DATA_DIR / "BRAINY_RECONEXIONESV3.csv", sep=";", dtype=str, encoding="utf-8")
    df.columns = [c.strip() for c in df.columns]
    df["CuentaFinanciera"] = _clean_key_series(df["CuentaFinanciera"])
    df["NumeroRecibo"] = df["NumeroRecibo"].astype(str).str.strip()
    df["Monto"] = pd.to_numeric(df["Monto"], errors="coerce").fillna(0.0)
    df["FechaReconexion"] = pd.to_datetime(df["FechaReconexion"], errors="coerce", dayfirst=True)
    df["FechaCorte"] = pd.to_datetime(df["FechaCorte"], errors="coerce", dayfirst=True)
    return df


@lru_cache(maxsize=1)
def load_brainy_descuentos() -> pd.DataFrame:
    df = pd.read_csv(DATA_DIR / "BRAINY_DESCUENTOS_CUOTAS.csv", sep=",", dtype=str, encoding="utf-8")
    df.columns = [c.strip() for c in df.columns]
    df["cuentafinanciera"] = _clean_key_series(df["cuentafinanciera"])
    df["chargecode"] = _clean_key_series(df["chargecode"])
    df["Monto_Descuento"] = pd.to_numeric(df["Monto_Descuento"], errors="coerce").fillna(0.0)
    df["FechaInicio"] = pd.to_datetime(df["FechaInicio"], errors="coerce")
    df["FechaFin"] = pd.to_datetime(df["FechaFin"], errors="coerce")
    df["CuotaActual"] = pd.to_numeric(df["CuotaActual"], errors="coerce")
    df["PromotionDuration"] = pd.to_numeric(df["PromotionDuration"], errors="coerce")
    df["flag_descuento_completo"] = pd.to_numeric(df["flag_descuento_completo"], errors="coerce")
    return df


@lru_cache(maxsize=1)
def planta_by_account() -> dict:
    """Indice: cuenta financiera -> lineas/servicios que tiene esa cuenta.
    Es lo que usamos para saber, al 'identificar' a un cliente por su numero
    de cuenta, cuantos servicios tiene y de que tipo (movil, internet, TV...)."""
    df = load_planta()
    return {k: v for k, v in df.groupby("FINANCIAL_ACCOUNT")}


@lru_cache(maxsize=1)
def facturacion_by_account() -> dict:
    """Indice precalculado: cuenta financiera -> sub-dataframe de sus lineas de cargo.
    Evita escanear las 297k filas en cada consulta del chat."""
    df = load_facturacion()
    return {k: v for k, v in df.groupby("FINANCIAL_ACCOUNT_KEY")}


@lru_cache(maxsize=1)
def ordenes_by_customer() -> dict:
    df = load_ordenes()
    return {k: v for k, v in df.groupby("CUSTOMER_KEY")}


@lru_cache(maxsize=1)
def notas_credito_by_account() -> dict:
    df = load_notas_credito()
    return {k: v for k, v in df.groupby("BA_NO")}


@lru_cache(maxsize=1)
def brainy_prorrateo_by_recibo() -> dict:
    df = load_brainy_prorrateo()
    # nos quedamos con la primera fila si hubiera duplicados por recibo
    return {k: v.iloc[0] for k, v in df.groupby("NumeroRecibo")}


@lru_cache(maxsize=1)
def brainy_reconexiones_by_recibo() -> dict:
    df = load_brainy_reconexiones()
    return {k: v.iloc[0] for k, v in df.groupby("NumeroRecibo")}


@lru_cache(maxsize=1)
def brainy_descuentos_by_account() -> dict:
    df = load_brainy_descuentos()
    return {k: v for k, v in df.groupby("cuentafinanciera")}


def warm_up():
    """Fuerza la carga de todo al iniciar el servidor, asi la primera consulta no es lenta."""
    load_facturacion()
    load_planta()
    load_catalogo_ofertas()
    load_ordenes()
    load_notas_credito()
    load_brainy_prorrateo()
    load_brainy_reconexiones()
    load_brainy_descuentos()
    planta_by_account()
    facturacion_by_account()
    ordenes_by_customer()
    notas_credito_by_account()
    brainy_prorrateo_by_recibo()
    brainy_reconexiones_by_recibo()
    brainy_descuentos_by_account()


if __name__ == "__main__":
    warm_up()
    print("Facturacion:", load_facturacion().shape)
    print("Planta:", load_planta().shape)
    print("Catalogo ofertas:", load_catalogo_ofertas().shape)
    print("Ordenes:", load_ordenes().shape)
    print("Notas credito:", load_notas_credito().shape)
    print("Brainy prorrateo:", load_brainy_prorrateo().shape)
    print("Brainy reconexiones:", load_brainy_reconexiones().shape)
    print("Brainy descuentos:", load_brainy_descuentos().shape)
