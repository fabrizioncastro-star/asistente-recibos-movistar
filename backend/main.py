"""
API del asistente de explicacion de recibos (Desafio 1).
Ejecutar con: uvicorn main:app --reload --port 8000
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path

import data_loader as dl
import engine
import assistant
import nlg

app = FastAPI(title="Asistente de Explicación de Recibos - Movistar")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


_casos_demo_cache = {}


@app.on_event("startup")
def _startup():
    dl.warm_up()
    global _casos_demo_cache
    _casos_demo_cache = engine.buscar_casos_demo(por_tipo=3)


class ChatRequest(BaseModel):
    cuenta: str
    mensaje: str
    recibo: str | None = None
    linea: str | None = None


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/casos-demo")
def casos_demo():
    return _casos_demo_cache


@app.get("/api/identificar/{cuenta}")
def identificar(cuenta: str):
    """Simula el paso de autenticacion: dado un numero de cuenta (dato NO
    sensible que si existe en el dataset -- a diferencia de DNI/telefono,
    que la ficha del reto explicitamente excluye), devuelve que
    servicios/lineas tiene esa cuenta."""
    lineas = engine.buscar_cuenta(cuenta)
    if lineas is None:
        raise HTTPException(status_code=404, detail="No encontramos esa cuenta. Verifica el número e intenta de nuevo.")
    return {
        "cuenta": cuenta,
        "lineas": [{"anexo": l.anexo, "tipo": l.tipo, "etiqueta": l.etiqueta, "negocio": l.negocio} for l in lineas],
    }


@app.get("/api/recibo/{cuenta}")
def recibo(cuenta: str, numero: str | None = None, linea: str | None = None):
    diag = engine.diagnosticar(cuenta, recibo=numero, linea=linea)
    if not diag.encontrado:
        raise HTTPException(status_code=404, detail=diag.error)
    return {
        "cuenta": diag.cuenta,
        "recibo_actual": diag.recibo_actual,
        "recibo_previo": diag.recibo_previo,
        "total_actual": diag.total_actual,
        "total_previo": diag.total_previo,
        "monto_habitual": diag.monto_habitual,
        "diferencia": diag.diferencia,
        "historial": diag.historial,
        "causas": [{"tipo": c.tipo, "monto": c.monto, "detalle": c.detalle} for c in diag.causas],
        "explicacion": nlg.explicar_variacion(diag),
    }


@app.post("/api/chat")
def chat(req: ChatRequest):
    resp = assistant.responder(req.cuenta, req.mensaje, recibo=req.recibo, linea=req.linea)
    return resp.to_dict()


FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
