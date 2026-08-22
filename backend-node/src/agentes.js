// Roster de agentes "fake": no son personas reales, son un roster fijo que
// usamos para simular la derivacion a un asesor humano de forma visible
// (nombre, area, avatar) tanto en el chat del cliente como en el panel
// interno -- en vez de un generico "te conecto con un asesor" sin cara.
const AGENTES = [
  { id: "camila", nombre: "Camila Torres", area: "Facturación y Pagos", avatar: "👩🏻‍💼" },
  { id: "renzo", nombre: "Renzo Alvarado", area: "Atención General", avatar: "👨🏽‍💼" },
  { id: "valeria", nombre: "Valeria Ponce", area: "Soporte Técnico", avatar: "👩🏾‍💼" },
  { id: "diego", nombre: "Diego Salazar", area: "Retención de Clientes", avatar: "👨🏻‍💼" },
  { id: "andrea", nombre: "Andrea Ríos", area: "Facturación y Pagos", avatar: "👩🏼‍💼" },
];

// Round-robin simple: alterna entre agentes en cada llamada. No hay estado
// real de "ocupado/disponible" (son fake), pero alternar da la sensacion de
// un equipo real repartiendose los casos en vez de siempre la misma persona.
let contador = 0;
function elegirAgente() {
  const agente = AGENTES[contador % AGENTES.length];
  contador++;
  return agente;
}

module.exports = { AGENTES, elegirAgente };
