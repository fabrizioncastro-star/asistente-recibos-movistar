# Asistente de Explicación de Recibos — Movistar AI Telecom Challenge 2026

Prototipo para el **Desafío 1: Atención inteligente y explicación de recibos** del
Hackathon "AI Telecom Challenge" (Movistar / Universidad de Lima, 2026).

Un asistente conversacional que explica en lenguaje simple por qué varió el recibo
de un cliente, comparando el recibo actual contra el historial y cruzando la
diferencia contra las causas reales del negocio: prorrateos, reconexiones por
corte, fin de descuentos/promociones y cuotas de equipos financiados.

## Cómo funciona (sin LLM, a propósito)

No usa ningún modelo de lenguaje. Es un sistema experto basado en reglas:

1. **`backend/engine.py`** — el "cerebro": calcula la diferencia entre recibos y
   clasifica la causa cruzando contra las tablas de datos reales (100%
   determinístico, sin alucinaciones posibles).
2. **`backend/nlg.py`** — la "boca": convierte esos hechos ya calculados en texto
   simple en español, por plantillas.
3. **`backend/assistant.py`** — detecta la intención del mensaje (pregunta sobre
   el recibo, definición de un término, pagar, hablar con asesor) por
   coincidencia de palabras clave, sin NLP.
4. **`backend/main.py`** — API FastAPI que expone todo lo anterior.
5. **`frontend/index.html`** — chat estilo App Mi Movistar. La identificación del
   cliente (por número de cuenta, no DNI/teléfono — ver nota de datos abajo)
   ocurre dentro de la misma conversación, como un bot real de WhatsApp.

La arquitectura separa a propósito el cálculo (`engine.py`) de la redacción
(`nlg.py`), de modo que más adelante se puede conectar un LLM real solo para la
capa de redacción, sin tocar la lógica de negocio ni arriesgar que invente cifras.

## Datos

Este repositorio **no incluye los datasets** (son datos de facturación reales,
aunque anonimizados, provistos por Movistar para el hackathon). Para correrlo
localmente necesitas los siguientes archivos CSV / XLSX en una carpeta local,
y actualizar `DATA_DIR` en `backend/data_loader.py` para que apunte ahí:

- `PLANTA CLIENTES.csv`
- `FACTURACION-CLIENTES_.csv`
- `CATALOGO-OFERTAS.csv`
- `Ordenes.csv`
- `NOTAS_CREDITO.csv`
- `BRAINY_PRORRATEO_ALTASV3.csv`
- `BRAINY_RECONEXIONESV3.csv`
- `BRAINY_DESCUENTOS_CUOTAS.csv`

## Cómo correrlo

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --port 8000
```

Abre `http://localhost:8000` en el navegador.

## Identificación del cliente

El dataset del reto excluye intencionalmente DNI y teléfono (dato sensible), así
que la identificación dentro del chat se hace con el **número de cuenta**
(`FINANCIAL_ACCOUNT`), que sí es un dato legítimo y no sensible del dataset. Si
la cuenta tiene más de un servicio (móvil, internet, TV...), el bot pregunta
sobre cuál quieres consultar — todo dentro de la misma conversación.
