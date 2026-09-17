/* ==========================================================================
   Inventario Cava - version en la nube (Supabase)
   Misma app que la version local, pero los datos viven en Supabase en vez de
   en un servidor propio, para que se pueda entrar desde cualquier lugar.
   ========================================================================== */

const MOTIVOS = ["Merma / daño", "Consumo interno", "Error de conteo", "Robo / pérdida", "Ajuste", "Otro"];
const TOLERANCIA = 0.01;

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let productos = [];
let productosPorId = {};
let estado = [];
let filtroInvChip = "todos";
let filtroDespChip = "todos";
let editandoProductoId = null;

/* ---------- utilidades ---------- */

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function horaActual() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function fechaTrabajo() {
  return document.getElementById("fechaTrabajo").value || todayISO();
}

function fmt(n, unidad) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  const texto = unidad === "UND" ? num.toLocaleString("es-CO", { maximumFractionDigits: 0 })
                                  : num.toLocaleString("es-CO", { maximumFractionDigits: 2 });
  return texto + " " + (unidad || "");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, isError) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle("error", !!isError);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function throwIfError(error) {
  if (error) throw new Error(error.message || "Error de Supabase");
}

/* ---------- puerta de acceso (clave simple, no es seguridad real) ---------- */

function abrirCompuerta() {
  const ok = sessionStorage.getItem("inv_ok") === "1";
  document.getElementById("gateOverlay").hidden = ok;
}
document.getElementById("gateEntrar").addEventListener("click", intentarEntrar);
document.getElementById("gatePassword").addEventListener("keydown", (e) => { if (e.key === "Enter") intentarEntrar(); });
function intentarEntrar() {
  const val = document.getElementById("gatePassword").value;
  if (val === window.APP_PASSWORD) {
    sessionStorage.setItem("inv_ok", "1");
    document.getElementById("gateOverlay").hidden = true;
  } else {
    document.getElementById("gateError").hidden = false;
  }
}
abrirCompuerta();

/* ---------- modal generico ---------- */

function abrirModal(titulo, bodyHtml, { textoConfirmar = "Guardar", onConfirm = null, textoCancelar = "Cancelar", ocultarCancelar = false } = {}) {
  document.getElementById("modalTitulo").textContent = titulo;
  document.getElementById("modalBody").innerHTML = bodyHtml;
  document.getElementById("modalConfirmar").textContent = textoConfirmar;
  document.getElementById("modalCancelar").textContent = textoCancelar;
  document.getElementById("modalCancelar").hidden = ocultarCancelar;
  document.getElementById("modalOverlay").hidden = false;
  document.getElementById("modalConfirmar").onclick = () => { if (onConfirm) onConfirm(); };
}
function cerrarModal() { document.getElementById("modalOverlay").hidden = true; }
document.getElementById("modalCancelar").addEventListener("click", cerrarModal);
document.getElementById("modalOverlay").addEventListener("click", (e) => { if (e.target.id === "modalOverlay") cerrarModal(); });

/* ==========================================================================
   TABS
   ========================================================================== */

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  refrescarTodo();
});
document.getElementById("fechaTrabajo").addEventListener("change", refrescarTodo);

/* ==========================================================================
   CAPA DE DATOS (Supabase)
   ========================================================================== */

function mapProducto(row) {
  return { id: row.id, codigo: row.codigo, nombre: row.nombre, unidad: row.unidad };
}
function mapInventario(row) {
  return {
    tipo: "inventario", id: row.id, productoId: row.producto_id, fecha: row.fecha, hora: row.hora,
    modo: row.modo, valor: Number(row.valor), notas: row.notas, creadoEn: row.creado_en,
  };
}
function mapDespacho(row) {
  return {
    tipo: "despacho", id: row.id, productoId: row.producto_id, fecha: row.fecha, hora: row.hora,
    disponibleAntes: Number(row.disponible_antes), belloColores: Number(row.bello_colores),
    puntosExpres: Number(row.puntos_expres), totalDespachado: Number(row.total_despachado),
    queda: Number(row.queda), notas: row.notas, creadoEn: row.creado_en,
  };
}
function mapDiferencia(row) {
  return {
    id: row.id, productoId: row.producto_id, fecha: row.fecha,
    valorEsperado: Number(row.valor_esperado), valorReal: Number(row.valor_real),
    diferencia: Number(row.diferencia), motivo: row.motivo, nota: row.nota, creadoEn: row.creado_en,
  };
}

async function fetchStockRow(productoId) {
  const { data, error } = await sb.from("stock").select("*").eq("producto_id", productoId).maybeSingle();
  throwIfError(error);
  return data;
}

async function upsertStock(productoId, valor, fecha, origen) {
  const { error } = await sb.from("stock").upsert({
    producto_id: productoId, valor, fecha, origen, actualizado_en: new Date().toISOString(),
  });
  throwIfError(error);
}

async function movimientosDeProducto(productoId) {
  const [{ data: invs, error: e1 }, { data: desps, error: e2 }] = await Promise.all([
    sb.from("inventarios").select("*").eq("producto_id", productoId),
    sb.from("despachos").select("*").eq("producto_id", productoId),
  ]);
  throwIfError(e1); throwIfError(e2);
  const items = [
    ...(invs || []).map(r => ({ id: r.id, tipo: "inventario", valor: Number(r.valor), fecha: r.fecha, creadoEn: r.creado_en })),
    ...(desps || []).map(r => ({ id: r.id, tipo: "despacho", valor: Number(r.queda), fecha: r.fecha, creadoEn: r.creado_en })),
  ];
  items.sort((a, b) => a.creadoEn.localeCompare(b.creadoEn));
  return items;
}

async function ultimoMovimientoDeProducto(productoId) {
  const items = await movimientosDeProducto(productoId);
  return items.length ? items[items.length - 1] : null;
}

/* ==========================================================================
   CARGA DE DATOS
   ========================================================================== */

async function cargarProductos() {
  const { data, error } = await sb.from("productos").select("*").order("nombre");
  throwIfError(error);
  productos = (data || []).map(mapProducto);
  productosPorId = {};
  productos.forEach(p => { productosPorId[p.id] = p; });
}

async function cargarEstado() {
  const fecha = fechaTrabajo();
  const [{ data: stockRows, error: e1 }, { data: invHoy, error: e2 }, { data: despHoy, error: e3 }] = await Promise.all([
    sb.from("stock").select("*"),
    sb.from("inventarios").select("*").eq("fecha", fecha),
    sb.from("despachos").select("*").eq("fecha", fecha),
  ]);
  throwIfError(e1); throwIfError(e2); throwIfError(e3);

  const stockPorProd = {};
  (stockRows || []).forEach(r => { stockPorProd[r.producto_id] = r; });
  const invHoyPorProd = {};
  (invHoy || []).map(mapInventario).forEach(r => { invHoyPorProd[r.productoId] = r; }); // se queda el ultimo por orden natural
  const despPorProd = {};
  (despHoy || []).map(mapDespacho).forEach(r => {
    if (!despPorProd[r.productoId]) despPorProd[r.productoId] = { total: 0, bello: 0, expres: 0 };
    despPorProd[r.productoId].total += r.totalDespachado;
    despPorProd[r.productoId].bello += r.belloColores;
    despPorProd[r.productoId].expres += r.puntosExpres;
  });

  estado = productos.map(p => {
    const s = stockPorProd[p.id];
    const inv = invHoyPorProd[p.id];
    const d = despPorProd[p.id] || { total: 0, bello: 0, expres: 0 };
    return {
      id: p.id, codigo: p.codigo, nombre: p.nombre, unidad: p.unidad,
      stockActual: s ? Number(s.valor) : null, stockFecha: s ? s.fecha : null, stockOrigen: s ? s.origen : null,
      inventariadoHoy: !!inv, inventarioHoyValor: inv ? inv.valor : null,
      despachadoHoyTotal: d.total, despachadoHoyBello: d.bello, despachadoHoyExpres: d.expres,
    };
  });
}

async function refrescarTodo() {
  try {
    await cargarProductos();
    await cargarEstado();
    renderTablaInventario();
    renderTablaDespacho();
    renderTablaProductos();
    await renderHistorial();
    await renderDiferencias();
    await renderResumen();
  } catch (err) {
    toast(err.message || "Error cargando datos", true);
  }
}

/* ==========================================================================
   INVENTARIO
   ========================================================================== */

function coincideBusqueda(item, texto) {
  if (!texto) return true;
  texto = texto.toLowerCase();
  return item.codigo.toLowerCase().includes(texto) || item.nombre.toLowerCase().includes(texto);
}

document.getElementById("buscarInventario").addEventListener("input", renderTablaInventario);
document.querySelectorAll('#tab-inventario .chip').forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll('#tab-inventario .chip').forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    filtroInvChip = chip.dataset.filtro;
    renderTablaInventario();
  });
});

function renderTablaInventario() {
  const texto = document.getElementById("buscarInventario").value.trim();
  const tbody = document.getElementById("tablaInventario");
  let filas = estado.filter(it => coincideBusqueda(it, texto));
  if (filtroInvChip === "pendientes") filas = filas.filter(it => !it.inventariadoHoy);
  if (filtroInvChip === "hechos") filas = filas.filter(it => it.inventariadoHoy);
  filas = filas.slice(0, 400);

  tbody.innerHTML = filas.map(it => `
    <tr>
      <td>${escapeHtml(it.codigo)}</td>
      <td>${escapeHtml(it.nombre)}</td>
      <td>${it.unidad}</td>
      <td>${fmt(it.stockActual, it.unidad)}${it.stockFecha ? ` <small style="color:var(--muted)">(${it.stockFecha})</small>` : ""}</td>
      <td>${it.inventariadoHoy ? `<span class="badge badge-ok">${fmt(it.inventarioHoyValor, it.unidad)}</span>` : `<span class="badge badge-off">Pendiente</span>`}</td>
      <td><button class="btn-icon primary" data-inv="${it.id}">${it.inventariadoHoy ? "Editar conteo" : "Registrar conteo"}</button></td>
    </tr>
  `).join("") || `<tr class="empty-row"><td colspan="6">Sin productos que coincidan con la búsqueda.</td></tr>`;

  tbody.querySelectorAll("[data-inv]").forEach(b => b.addEventListener("click", () => abrirModalInventario(b.dataset.inv)));
}

function abrirModalInventario(productoId) {
  const p = productosPorId[productoId];
  const it = estado.find(e => e.id === productoId);
  if (!p) return;

  let bodyHtml = "";
  if (p.unidad === "KG") {
    bodyHtml = `
      <div class="modal-body-grid">
        <div class="hint">Stock actual: <strong>${fmt(it.stockActual, "KG")}</strong></div>
        <div class="modo-toggle" id="modoToggle">
          <button type="button" data-modo="bruto" class="active">Peso bruto (con canastas)</button>
          <button type="button" data-modo="neto">Ya es peso neto</button>
        </div>
        <div id="camposBruto">
          <label>Peso bruto (kg)
            <input type="number" id="invPesoBruto" min="0" step="0.01" inputmode="decimal">
          </label>
          <div class="split-row" style="margin-top:10px">
            <label>N° de canastas
              <input type="number" id="invNumCanastas" min="0" step="1" value="1">
            </label>
            <label>Peso por canasta (kg)
              <input type="number" id="invPesoCanasta" min="0" step="0.01" value="2.2">
            </label>
          </div>
        </div>
        <div id="camposNeto" hidden>
          <label>Peso neto (kg)
            <input type="number" id="invPesoNeto" min="0" step="0.01" inputmode="decimal">
          </label>
        </div>
        <div class="calc-line" id="calcLinea">Peso neto: <strong>0 kg</strong></div>
        <label>Notas (opcional)
          <input type="text" id="invNotas" placeholder="Opcional">
        </label>
      </div>
    `;
  } else {
    bodyHtml = `
      <div class="modal-body-grid">
        <div class="hint">Stock actual: <strong>${fmt(it.stockActual, "UND")}</strong></div>
        <label>Cantidad (unidades)
          <input type="number" id="invCantidadUnd" min="0" step="1" inputmode="numeric">
        </label>
        <label>Notas (opcional)
          <input type="text" id="invNotas" placeholder="Opcional">
        </label>
      </div>
    `;
  }

  abrirModal(`Inventario — ${p.codigo} · ${p.nombre}`, bodyHtml, {
    textoConfirmar: "Guardar conteo",
    onConfirm: () => confirmarInventario(p),
  });

  if (p.unidad === "KG") {
    const recalcular = () => {
      const modo = document.querySelector('#modoToggle button.active').dataset.modo;
      let neto = 0;
      if (modo === "bruto") {
        const bruto = Number(document.getElementById("invPesoBruto").value) || 0;
        const n = Number(document.getElementById("invNumCanastas").value) || 0;
        const tara = Number(document.getElementById("invPesoCanasta").value) || 0;
        neto = bruto - (n * tara);
      } else {
        neto = Number(document.getElementById("invPesoNeto").value) || 0;
      }
      const el = document.getElementById("calcLinea");
      el.innerHTML = `Peso neto: <strong>${neto.toLocaleString("es-CO", { maximumFractionDigits: 2 })} kg</strong>`;
      el.classList.toggle("negativo", neto < 0);
    };
    document.querySelectorAll("#modoToggle button").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#modoToggle button").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("camposBruto").hidden = btn.dataset.modo !== "bruto";
        document.getElementById("camposNeto").hidden = btn.dataset.modo !== "neto";
        recalcular();
      });
    });
    ["invPesoBruto", "invNumCanastas", "invPesoCanasta", "invPesoNeto"].forEach(id => {
      document.getElementById(id).addEventListener("input", recalcular);
    });
  }
}

function leerCuerpoInventario(p) {
  const fecha = fechaTrabajo();
  const notas = document.getElementById("invNotas").value.trim();
  if (p.unidad === "UND") {
    return { productoId: p.id, fecha, modo: "unidad", valor: Number(document.getElementById("invCantidadUnd").value) || 0, notas };
  }
  const modo = document.querySelector('#modoToggle button.active').dataset.modo;
  if (modo === "bruto") {
    return {
      productoId: p.id, fecha, modo: "bruto", notas,
      pesoBruto: Number(document.getElementById("invPesoBruto").value) || 0,
      numCanastas: Number(document.getElementById("invNumCanastas").value) || 0,
      pesoCanasta: Number(document.getElementById("invPesoCanasta").value) || 2.2,
    };
  }
  return { productoId: p.id, fecha, modo: "neto", notas, valor: Number(document.getElementById("invPesoNeto").value) || 0 };
}

function calcularValorInventario(p, cuerpo) {
  if (p.unidad === "UND") return Number(cuerpo.valor) || 0;
  if (cuerpo.modo === "bruto") return (Number(cuerpo.pesoBruto) || 0) - (Number(cuerpo.numCanastas) || 0) * (Number(cuerpo.pesoCanasta) || 2.2);
  return Number(cuerpo.valor) || 0;
}

// Guarda el conteo. Si no coincide con el stock actual y no trae motivo, devuelve
// { requiereMotivo: true, ... } en vez de guardar, para que la UI pida el motivo.
async function guardarInventario(p, cuerpo) {
  const valor = calcularValorInventario(p, cuerpo);
  if (valor < 0) throw new Error("El valor calculado es negativo, revisa canastas/peso");

  const stockRow = await fetchStockRow(p.id);
  const anterior = stockRow ? Number(stockRow.valor) : null;

  if (anterior !== null && Math.abs(valor - anterior) > TOLERANCIA && !cuerpo.motivo) {
    return { requiereMotivo: true, valorEsperado: anterior, valorNuevo: valor, unidad: p.unidad };
  }

  const { data: invRow, error } = await sb.from("inventarios").insert({
    producto_id: p.id, fecha: cuerpo.fecha, hora: horaActual(),
    modo: p.unidad === "UND" ? "unidad" : cuerpo.modo,
    peso_bruto: cuerpo.modo === "bruto" ? cuerpo.pesoBruto : null,
    num_canastas: cuerpo.modo === "bruto" ? cuerpo.numCanastas : null,
    peso_canasta: cuerpo.modo === "bruto" ? cuerpo.pesoCanasta : null,
    valor, notas: cuerpo.notas || null,
  }).select().single();
  throwIfError(error);

  let diferencia = null;
  if (anterior !== null && Math.abs(valor - anterior) > TOLERANCIA) {
    const { data: difRow, error: e2 } = await sb.from("diferencias").insert({
      producto_id: p.id, fecha: cuerpo.fecha, valor_esperado: anterior, valor_real: valor,
      diferencia: valor - anterior, motivo: cuerpo.motivo || null, nota: cuerpo.motivoNota || null,
      inventario_id: invRow.id,
    }).select().single();
    throwIfError(e2);
    diferencia = mapDiferencia(difRow);
  }

  await upsertStock(p.id, valor, cuerpo.fecha, "inventario");
  return { inventario: mapInventario(invRow), diferencia };
}

async function confirmarInventario(p) {
  let cuerpo;
  try {
    cuerpo = leerCuerpoInventario(p);
  } catch (e) {
    toast("Revisa los datos ingresados", true);
    return;
  }
  try {
    const resultado = await guardarInventario(p, cuerpo);
    if (resultado.requiereMotivo) {
      abrirModalMotivoInventario(p, cuerpo, resultado);
      return;
    }
    cerrarModal();
    toast("Conteo guardado");
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo guardar el conteo", true);
  }
}

function abrirModalMotivoInventario(p, cuerpoOriginal, info) {
  const bodyHtml = `
    <div class="modal-body-grid">
      <div class="alerta-box">
        El conteo no coincide con lo esperado.<br>
        Se esperaba: <strong>${fmt(info.valorEsperado, info.unidad)}</strong> ·
        Contaste: <strong>${fmt(info.valorNuevo, info.unidad)}</strong>
      </div>
      <label>Motivo de la diferencia
        <select id="motivoSelect">${MOTIVOS.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("")}</select>
      </label>
      <label>Nota (opcional)
        <input type="text" id="motivoNota" placeholder="Detalle adicional...">
      </label>
    </div>
  `;
  abrirModal("Explica la diferencia", bodyHtml, {
    textoConfirmar: "Guardar con motivo",
    onConfirm: async () => {
      const motivo = document.getElementById("motivoSelect").value;
      const motivoNota = document.getElementById("motivoNota").value.trim();
      try {
        await guardarInventario(p, Object.assign({}, cuerpoOriginal, { motivo, motivoNota }));
        cerrarModal();
        toast("Conteo guardado con motivo registrado");
        await refrescarTodo();
      } catch (err) {
        toast(err.message || "No se pudo guardar", true);
      }
    },
  });
}

/* ==========================================================================
   DESPACHO
   ========================================================================== */

document.getElementById("buscarDespacho").addEventListener("input", renderTablaDespacho);
document.querySelectorAll('#tab-despacho .chip').forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll('#tab-despacho .chip').forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    filtroDespChip = chip.dataset.filtro;
    renderTablaDespacho();
  });
});

function renderTablaDespacho() {
  const texto = document.getElementById("buscarDespacho").value.trim();
  const tbody = document.getElementById("tablaDespacho");
  let filas = estado.filter(it => coincideBusqueda(it, texto));
  if (filtroDespChip === "disponibles") filas = filas.filter(it => Number(it.stockActual) > 0);
  if (filtroDespChip === "despachados") filas = filas.filter(it => Number(it.despachadoHoyTotal) > 0);
  filas = filas.slice(0, 400);

  tbody.innerHTML = filas.map(it => `
    <tr>
      <td>${escapeHtml(it.codigo)}</td>
      <td>${escapeHtml(it.nombre)}</td>
      <td>${it.unidad}</td>
      <td>${fmt(it.stockActual, it.unidad)}</td>
      <td>${it.despachadoHoyTotal > 0 ? `<span class="badge badge-ok">B: ${fmt(it.despachadoHoyBello, it.unidad)} · E: ${fmt(it.despachadoHoyExpres, it.unidad)}</span>` : `<span class="badge badge-off">—</span>`}</td>
      <td><button class="btn-icon primary" data-desp="${it.id}" ${it.stockActual === null ? "disabled title='Primero registra inventario'" : ""}>Despachar</button></td>
    </tr>
  `).join("") || `<tr class="empty-row"><td colspan="6">Sin productos que coincidan con la búsqueda.</td></tr>`;

  tbody.querySelectorAll("[data-desp]").forEach(b => b.addEventListener("click", () => abrirModalDespacho(b.dataset.desp)));
}

function abrirModalDespacho(productoId) {
  const p = productosPorId[productoId];
  const it = estado.find(e => e.id === productoId);
  if (!p || it.stockActual === null) { toast("Este producto no tiene inventario registrado todavía", true); return; }

  const step = p.unidad === "UND" ? "1" : "0.01";
  const bodyHtml = `
    <div class="modal-body-grid">
      <div class="hint">Inventariado (disponible): <strong>${fmt(it.stockActual, p.unidad)}</strong></div>
      <div class="split-row">
        <label>Bello Colores
          <input type="number" id="despBello" min="0" step="${step}" value="0">
        </label>
        <label>Puntos Expres
          <input type="number" id="despExpres" min="0" step="${step}" value="0">
        </label>
      </div>
      <div class="calc-line" id="calcDespacho">Despachando: <strong>0</strong> · Queda: <strong>${fmt(it.stockActual, p.unidad)}</strong></div>
      <label>Notas (opcional)
        <input type="text" id="despNotas" placeholder="Opcional">
      </label>
    </div>
  `;
  abrirModal(`Despacho — ${p.codigo} · ${p.nombre}`, bodyHtml, {
    textoConfirmar: "Registrar despacho",
    onConfirm: () => confirmarDespacho(p, it),
  });

  const recalcular = () => {
    const bello = Number(document.getElementById("despBello").value) || 0;
    const expres = Number(document.getElementById("despExpres").value) || 0;
    const total = bello + expres;
    const queda = Number(it.stockActual) - total;
    const el = document.getElementById("calcDespacho");
    el.innerHTML = `Despachando: <strong>${fmt(total, p.unidad)}</strong> · Queda: <strong>${fmt(queda, p.unidad)}</strong>`;
    el.classList.toggle("negativo", queda < 0);
  };
  document.getElementById("despBello").addEventListener("input", recalcular);
  document.getElementById("despExpres").addEventListener("input", recalcular);
}

async function guardarDespacho(p, cuerpo) {
  const stockRow = await fetchStockRow(p.id);
  if (!stockRow) throw new Error("Este producto no tiene inventario registrado todavia");
  const disponible = Number(stockRow.valor);
  const total = (Number(cuerpo.belloColores) || 0) + (Number(cuerpo.puntosExpres) || 0);
  if (total <= 0) throw new Error("Debes despachar una cantidad mayor a 0");

  if (total > disponible && !cuerpo.forzar) {
    return { excedeDisponible: true, disponible, total, unidad: p.unidad };
  }

  const queda = disponible - total;
  const { data: despRow, error } = await sb.from("despachos").insert({
    producto_id: p.id, fecha: cuerpo.fecha, hora: horaActual(), disponible_antes: disponible,
    bello_colores: Number(cuerpo.belloColores) || 0, puntos_expres: Number(cuerpo.puntosExpres) || 0,
    total_despachado: total, queda, notas: cuerpo.notas || null, excede_inventario: total > disponible,
  }).select().single();
  throwIfError(error);

  await upsertStock(p.id, queda, cuerpo.fecha, "despacho");
  return { despacho: mapDespacho(despRow) };
}

async function confirmarDespacho(p) {
  const cuerpo = {
    productoId: p.id, fecha: fechaTrabajo(),
    belloColores: Number(document.getElementById("despBello").value) || 0,
    puntosExpres: Number(document.getElementById("despExpres").value) || 0,
    notas: document.getElementById("despNotas").value.trim(),
  };
  try {
    const resultado = await guardarDespacho(p, cuerpo);
    if (resultado.excedeDisponible) {
      abrirModal("Estás despachando de más", `
        <div class="alerta-box">
          Disponible: <strong>${fmt(resultado.disponible, resultado.unidad)}</strong> ·
          Vas a despachar: <strong>${fmt(resultado.total, resultado.unidad)}</strong><br>
          ¿Continuar de todas formas? Quedará registrado con saldo negativo.
        </div>
      `, {
        textoConfirmar: "Sí, despachar igual",
        onConfirm: () => confirmarDespachoForzado(p, cuerpo),
      });
      return;
    }
    cerrarModal();
    toast("Despacho registrado");
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo registrar el despacho", true);
  }
}

async function confirmarDespachoForzado(p, cuerpo) {
  try {
    await guardarDespacho(p, Object.assign({}, cuerpo, { forzar: true }));
    cerrarModal();
    toast("Despacho registrado (excede lo inventariado)");
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo registrar el despacho", true);
  }
}

/* ==========================================================================
   HISTORIAL
   ========================================================================== */

["btnFiltrarHistorial"].forEach(id => document.getElementById(id).addEventListener("click", renderHistorial));
["filtroTipo", "filtroDesde", "filtroHasta"].forEach(id => document.getElementById(id).addEventListener("change", renderHistorial));
document.getElementById("filtroProductoTexto").addEventListener("input", renderHistorial);

function detalleHistorial(m) {
  const p = productosPorId[m.productoId];
  const unidad = p ? p.unidad : "";
  if (m.tipo === "inventario") {
    return `Conteo: <strong>${fmt(m.valor, unidad)}</strong> <small style="color:var(--muted)">(${m.modo})</small>`;
  }
  return `Bello: ${fmt(m.belloColores, unidad)} · Expres: ${fmt(m.puntosExpres, unidad)} · Total: <strong>${fmt(m.totalDespachado, unidad)}</strong> · Queda: ${fmt(m.queda, unidad)}`;
}

async function obtenerHistorialCompleto({ desde, hasta, tipo } = {}) {
  let invQuery = sb.from("inventarios").select("*");
  let despQuery = sb.from("despachos").select("*");
  if (desde) { invQuery = invQuery.gte("fecha", desde); despQuery = despQuery.gte("fecha", desde); }
  if (hasta) { invQuery = invQuery.lte("fecha", hasta); despQuery = despQuery.lte("fecha", hasta); }

  const tareas = [];
  tareas.push(tipo === "despacho" ? Promise.resolve({ data: [] }) : invQuery);
  tareas.push(tipo === "inventario" ? Promise.resolve({ data: [] }) : despQuery);
  const [{ data: invs, error: e1 }, { data: desps, error: e2 }] = await Promise.all(tareas);
  throwIfError(e1); throwIfError(e2);

  const items = [...(invs || []).map(mapInventario), ...(desps || []).map(mapDespacho)];
  items.sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));
  return items;
}

async function renderHistorial() {
  const tipo = document.getElementById("filtroTipo").value;
  const desde = document.getElementById("filtroDesde").value;
  const hasta = document.getElementById("filtroHasta").value;
  const texto = document.getElementById("filtroProductoTexto").value.trim().toLowerCase();

  let items;
  try {
    items = await obtenerHistorialCompleto({ desde, hasta, tipo: tipo || null });
  } catch (err) {
    toast(err.message || "No se pudo cargar el historial", true);
    return;
  }
  if (texto) {
    items = items.filter(m => {
      const p = productosPorId[m.productoId];
      return p && (p.codigo.toLowerCase().includes(texto) || p.nombre.toLowerCase().includes(texto));
    });
  }
  items = items.slice(0, 300);

  const tbody = document.getElementById("tablaHistorial");
  tbody.innerHTML = items.map(m => {
    const p = productosPorId[m.productoId];
    return `
      <tr>
        <td>${m.fecha}</td>
        <td>${m.hora || ""}</td>
        <td>${m.tipo === "inventario" ? "Inventario" : "Despacho"}</td>
        <td>${p ? escapeHtml(p.codigo + " · " + p.nombre) : "(eliminado)"}</td>
        <td>${detalleHistorial(m)}</td>
        <td>${escapeHtml(m.notas || "-")}</td>
        <td><button class="btn-icon danger" data-del-hist="${m.tipo}|${m.id}">✕</button></td>
      </tr>
    `;
  }).join("") || `<tr class="empty-row"><td colspan="7">Sin movimientos con estos filtros.</td></tr>`;

  tbody.querySelectorAll("[data-del-hist]").forEach(b => b.addEventListener("click", async () => {
    const [tipoMov, id] = b.dataset.delHist.split("|");
    if (!confirm("¿Eliminar este movimiento? Solo se puede si es el último registrado para ese producto.")) return;
    try {
      if (tipoMov === "inventario") await eliminarInventario(id);
      else await eliminarDespacho(id);
      toast("Movimiento eliminado");
      await refrescarTodo();
    } catch (err) {
      toast(err.message || "No se pudo eliminar", true);
    }
  }));
}

async function eliminarInventario(id) {
  const { data: inv, error } = await sb.from("inventarios").select("*").eq("id", id).single();
  throwIfError(error);
  const ultimo = await ultimoMovimientoDeProducto(inv.producto_id);
  if (!ultimo || ultimo.id !== id) throw new Error("Solo se puede eliminar el ultimo movimiento registrado de este producto");

  const historial = await movimientosDeProducto(inv.producto_id);
  const idx = historial.findIndex(h => h.id === id);

  await sb.from("diferencias").delete().eq("inventario_id", id);
  await sb.from("inventarios").delete().eq("id", id);

  if (idx > 0) {
    const prev = historial[idx - 1];
    await upsertStock(inv.producto_id, prev.valor, prev.fecha, prev.tipo);
  } else {
    await sb.from("stock").delete().eq("producto_id", inv.producto_id);
  }
}

async function eliminarDespacho(id) {
  const { data: desp, error } = await sb.from("despachos").select("*").eq("id", id).single();
  throwIfError(error);
  const ultimo = await ultimoMovimientoDeProducto(desp.producto_id);
  if (!ultimo || ultimo.id !== id) throw new Error("Solo se puede eliminar el ultimo movimiento registrado de este producto");

  await sb.from("despachos").delete().eq("id", id);
  await upsertStock(desp.producto_id, Number(desp.disponible_antes), desp.fecha, "inventario");
}

async function renderDiferencias() {
  const { data, error } = await sb.from("diferencias").select("*").order("creado_en", { ascending: false }).limit(200);
  if (error) { toast(error.message, true); return; }
  const items = (data || []).map(mapDiferencia);
  const tbody = document.getElementById("tablaDiferencias");
  tbody.innerHTML = items.map(d => {
    const p = productosPorId[d.productoId];
    const unidad = p ? p.unidad : "";
    return `
      <tr class="${Math.abs(d.diferencia) > 0 ? 'row-warn' : ''}">
        <td>${d.fecha}</td>
        <td>${p ? escapeHtml(p.codigo + " · " + p.nombre) : "(eliminado)"}</td>
        <td>${fmt(d.valorEsperado, unidad)}</td>
        <td>${fmt(d.valorReal, unidad)}</td>
        <td>${d.diferencia > 0 ? "+" : ""}${fmt(d.diferencia, unidad)}</td>
        <td>${escapeHtml(d.motivo || "-")}</td>
        <td>${escapeHtml(d.nota || "-")}</td>
      </tr>
    `;
  }).join("") || `<tr class="empty-row"><td colspan="7">Sin diferencias registradas.</td></tr>`;
}

/* ==========================================================================
   PRODUCTOS
   ========================================================================== */

document.getElementById("buscarProducto").addEventListener("input", renderTablaProductos);

function renderTablaProductos() {
  const texto = document.getElementById("buscarProducto").value.trim().toLowerCase();
  const tbody = document.getElementById("tablaProductos");
  let filas = productos.filter(p => !texto || p.codigo.toLowerCase().includes(texto) || p.nombre.toLowerCase().includes(texto));
  filas = filas.slice(0, 400);
  tbody.innerHTML = filas.map(p => `
    <tr>
      <td>${escapeHtml(p.codigo)}</td>
      <td>${escapeHtml(p.nombre)}</td>
      <td>${p.unidad}</td>
      <td>
        <button class="btn-icon" data-edit="${p.id}">Editar</button>
        <button class="btn-icon danger" data-del="${p.id}">Eliminar</button>
      </td>
    </tr>
  `).join("") || `<tr class="empty-row"><td colspan="4">Sin productos.</td></tr>`;

  tbody.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => editarProducto(b.dataset.edit)));
  tbody.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => eliminarProducto(b.dataset.del)));
}

function editarProducto(id) {
  const p = productosPorId[id];
  if (!p) return;
  editandoProductoId = id;
  document.getElementById("prodId").value = id;
  document.getElementById("prodCodigo").value = p.codigo;
  document.getElementById("prodNombre").value = p.nombre;
  document.getElementById("prodUnidad").value = p.unidad;
  document.getElementById("formProductoTitulo").textContent = "Editar producto";
  document.getElementById("btnGuardarProducto").textContent = "Guardar cambios";
  document.getElementById("btnCancelarProducto").hidden = false;
  document.getElementById("tab-productos").scrollIntoView({ behavior: "smooth" });
}
document.getElementById("btnCancelarProducto").addEventListener("click", resetFormProducto);
function resetFormProducto() {
  editandoProductoId = null;
  document.getElementById("formProducto").reset();
  document.getElementById("prodId").value = "";
  document.getElementById("formProductoTitulo").textContent = "Nuevo producto";
  document.getElementById("btnGuardarProducto").textContent = "Guardar producto";
  document.getElementById("btnCancelarProducto").hidden = true;
}

document.getElementById("formProducto").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cuerpo = {
    codigo: document.getElementById("prodCodigo").value.trim(),
    nombre: document.getElementById("prodNombre").value.trim(),
    unidad: document.getElementById("prodUnidad").value,
  };
  if (!cuerpo.codigo || !cuerpo.nombre) { toast("Completa código y nombre", true); return; }
  try {
    if (editandoProductoId) {
      const { error } = await sb.from("productos").update(cuerpo).eq("id", editandoProductoId);
      throwIfError(error);
      toast("Producto actualizado");
    } else {
      const { data: existentes, error: e0 } = await sb.from("productos").select("id").eq("codigo", cuerpo.codigo);
      throwIfError(e0);
      if (existentes && existentes.length > 0) { toast("Ya existe un producto con ese código", true); return; }
      const { error } = await sb.from("productos").insert(cuerpo);
      throwIfError(error);
      toast("Producto creado");
    }
    resetFormProducto();
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo guardar el producto", true);
  }
});

async function eliminarProducto(id) {
  const p = productosPorId[id];
  if (!p) return;
  if (!confirm(`¿Eliminar "${p.nombre}"? También se borrará su historial de inventario y despachos.`)) return;
  try {
    const { error } = await sb.from("productos").delete().eq("id", id);
    throwIfError(error);
    toast("Producto eliminado");
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo eliminar", true);
  }
}

/* ==========================================================================
   RESUMEN
   ========================================================================== */

async function renderResumen() {
  document.getElementById("kpiTotalProductos").textContent = productos.length;
  document.getElementById("kpiInventariadosHoy").textContent = estado.filter(e => e.inventariadoHoy).length;
  document.getElementById("kpiDespachadosHoy").textContent = estado.filter(e => e.despachadoHoyTotal > 0).length;

  try {
    const { data: difs, error } = await sb.from("diferencias").select("id").eq("fecha", fechaTrabajo());
    throwIfError(error);
    document.getElementById("kpiDiferenciasHoy").textContent = (difs || []).length;
  } catch (e) { /* no bloquea el resto del resumen */ }

  try {
    const items = await obtenerHistorialCompleto({});
    const top = items.slice(0, 10);
    const tbody = document.getElementById("resumenUltimos");
    tbody.innerHTML = top.map(m => {
      const p = productosPorId[m.productoId];
      return `
        <tr>
          <td>${m.fecha}</td>
          <td>${m.hora || ""}</td>
          <td>${m.tipo === "inventario" ? "Inventario" : "Despacho"}</td>
          <td>${p ? escapeHtml(p.codigo + " · " + p.nombre) : "(eliminado)"}</td>
          <td>${detalleHistorial(m)}</td>
        </tr>
      `;
    }).join("") || `<tr class="empty-row"><td colspan="5">Sin movimientos todavía.</td></tr>`;
  } catch (e) { /* no bloquea el resto del resumen */ }
}

/* ==========================================================================
   RESPALDO (descarga todo como JSON)
   ========================================================================== */

document.getElementById("btnBackup").addEventListener("click", async () => {
  try {
    const [prods, stock, invs, desps, difs] = await Promise.all([
      sb.from("productos").select("*"),
      sb.from("stock").select("*"),
      sb.from("inventarios").select("*"),
      sb.from("despachos").select("*"),
      sb.from("diferencias").select("*"),
    ]);
    const payload = {
      productos: prods.data, stock: stock.data, inventarios: invs.data,
      despachos: desps.data, diferencias: difs.data,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "inventario_respaldo_" + todayISO() + ".json";
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast("No se pudo generar el respaldo", true);
  }
});

/* ==========================================================================
   INICIO
   ========================================================================== */

document.getElementById("fechaTrabajo").value = todayISO();
refrescarTodo();
