/* ==========================================================================
   Inventario Cava - version en la nube (Supabase)
   Misma app que la version local, pero los datos viven en Supabase en vez de
   en un servidor propio, para que se pueda entrar desde cualquier lugar.
   ========================================================================== */

const MOTIVOS = ["Merma / daño", "Consumo interno", "Error de conteo", "Robo / pérdida", "Ajuste", "Otro"];
const MOTIVOS_CORRECCION = ["Error de edición", "Código incorrecto", "Peso/kilaje incorrecto", "Otro"];
const TOLERANCIA = 0.01;

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let productos = [];
let productosPorId = {};
let estado = [];
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

/* ---------- puerta de acceso (clave simple, no es seguridad real) ----------
   Tres claves: "editar" (todo, incluye marcar el pedido), "platano" (edita solo
   la pestana Platano y el resto solo lo ve) y "ver" (solo consulta). El rol se
   guarda en sessionStorage y se usa para ocultar los controles de
   guardar/editar/eliminar y para bloquear esas acciones a nivel de datos. */

function rolActual() {
  return sessionStorage.getItem("inv_rol") || "";
}
// Solo lectura para todo lo que NO es Platano (ver y platano)
function esSoloLectura() {
  const rol = rolActual();
  return rol === "ver" || rol === "platano";
}
// Solo lectura dentro de Platano (solo el rol "ver"; "platano" y "editar" pueden editar)
function esSoloLecturaPlatano() {
  return rolActual() === "ver";
}
function puedeMarcarPedido() {
  return rolActual() === "editar";
}
// Con la clave de plantano solo se ven estas pestanas (la ultima es la de entrada).
const TABS_PERMITIDAS = { platano: ["pedido", "platano"] };
function aplicarRolEnPantalla() {
  const rol = rolActual();
  document.body.classList.toggle("rol-ver", rol === "ver");
  document.body.classList.toggle("rol-platano", rol === "platano");
  const badge = document.getElementById("badgeSoloLectura");
  if (badge) {
    badge.hidden = !(rol === "ver" || rol === "platano");
    badge.textContent = rol === "platano" ? "Solo plátano" : "Solo lectura";
  }
  const permitidas = TABS_PERMITIDAS[rol];
  document.querySelectorAll(".tab-btn").forEach(b => { b.hidden = !!permitidas && !permitidas.includes(b.dataset.tab); });
  const btnRespaldo = document.getElementById("btnBackup");
  if (btnRespaldo) btnRespaldo.hidden = rol === "platano";
  if (permitidas) {
    const activa = document.querySelector(".tab-btn.active");
    if (!activa || activa.hidden) {
      const destino = document.querySelector(`.tab-btn[data-tab="${permitidas[permitidas.length - 1]}"]`);
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      destino.classList.add("active");
      document.getElementById("tab-" + destino.dataset.tab).classList.add("active");
      actualizarTabActualLabel(destino);
    }
  }
}
function abrirCompuerta() {
  const ok = !!rolActual();
  document.getElementById("gateOverlay").hidden = ok;
  aplicarRolEnPantalla();
}
document.getElementById("gateEntrar").addEventListener("click", intentarEntrar);
document.getElementById("gatePassword").addEventListener("keydown", (e) => { if (e.key === "Enter") intentarEntrar(); });
function intentarEntrar() {
  const val = document.getElementById("gatePassword").value;
  if (val === window.APP_PASSWORD) {
    sessionStorage.setItem("inv_rol", "editar");
  } else if (window.APP_PASSWORD_PLATANO && val === window.APP_PASSWORD_PLATANO) {
    sessionStorage.setItem("inv_rol", "platano");
  } else if (val === window.APP_PASSWORD_VIEW) {
    sessionStorage.setItem("inv_rol", "ver");
  } else {
    document.getElementById("gateError").hidden = false;
    return;
  }
  document.getElementById("gateError").hidden = true;
  document.getElementById("gateOverlay").hidden = true;
  aplicarRolEnPantalla();
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

function actualizarTabActualLabel(btn) {
  document.getElementById("tabActualLabel").textContent = btn.textContent.trim();
}
document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  actualizarTabActualLabel(btn);
  cerrarMenu();
  if (btn.dataset.tab === "pedido") cargarPedido().then(renderPedido).catch(() => {});
  refrescarTodo();
  actualizarBarraScroll();
});
actualizarTabActualLabel(document.querySelector(".tab-btn.active"));
document.getElementById("fechaTrabajo").addEventListener("change", refrescarTodo);

/* Al desplazar: oculta el header para ganar espacio, y en la pestaña de
   Plátano muestra una barrita fija arriba con el saldo actual (verde/maduro)
   para no perderlo de vista mientras se navega el formulario. */
let ultimoScrollY = window.scrollY;
function actualizarBarraScroll() {
  const y = window.scrollY;
  const header = document.querySelector(".topbar");
  const bajando = y > ultimoScrollY && y > 60;
  header.classList.toggle("header-oculto", bajando);
  ultimoScrollY = y;

  const enPlatano = document.getElementById("tab-platano").classList.contains("active");
  document.getElementById("platanoMiniBar").hidden = !(enPlatano && y > 160);
}
window.addEventListener("scroll", actualizarBarraScroll, { passive: true });

/* Menu hamburguesa (solo se ve en pantallas chicas, ver css) */
function cerrarMenu() {
  document.getElementById("tabs").classList.remove("open");
  document.getElementById("menuToggle").setAttribute("aria-expanded", "false");
}
document.getElementById("menuToggle").addEventListener("click", () => {
  const abierto = document.getElementById("tabs").classList.toggle("open");
  document.getElementById("menuToggle").setAttribute("aria-expanded", abierto ? "true" : "false");
});

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
    pesoBruto: row.peso_bruto === null || row.peso_bruto === undefined ? null : Number(row.peso_bruto),
    numCanastas: row.num_canastas === null || row.num_canastas === undefined ? null : Number(row.num_canastas),
  };
}
function mapDespacho(row) {
  return {
    tipo: "despacho", id: row.id, productoId: row.producto_id, fecha: row.fecha, hora: row.hora,
    disponibleAntes: Number(row.disponible_antes), bello: Number(row.bello), colores: Number(row.colores),
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
function mapCorreccion(row) {
  return {
    id: row.id, tipo: row.tipo, productoId: row.producto_id, fecha: row.fecha,
    valorAnterior: row.valor_anterior === null ? null : Number(row.valor_anterior),
    valorNuevo: row.valor_nuevo === null ? null : Number(row.valor_nuevo),
    motivo: row.motivo, nota: row.nota, creadoEn: row.creado_en,
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

async function registrarCorreccion({ tipo, productoId, fecha, valorAnterior, valorNuevo, motivo, nota, inventarioId }) {
  const { error } = await sb.from("correcciones").insert({
    tipo, producto_id: productoId, fecha, valor_anterior: valorAnterior, valor_nuevo: valorNuevo,
    motivo: motivo || null, nota: nota || null, inventario_id: inventarioId || null,
  });
  throwIfError(error);
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
  const [{ data: stockRows, error: e1 }, { data: invHoy, error: e2 }, { data: despHoy, error: e3 }, { data: sugHoy, error: e4 }] = await Promise.all([
    sb.from("stock").select("*"),
    sb.from("inventarios").select("*").eq("fecha", fecha),
    sb.from("despachos").select("*").eq("fecha", fecha),
    sb.from("sugeridos").select("*").eq("fecha", fecha),
  ]);
  throwIfError(e1); throwIfError(e2); throwIfError(e3); throwIfError(e4);

  const stockPorProd = {};
  (stockRows || []).forEach(r => { stockPorProd[r.producto_id] = r; });

  const invPorProd = {};
  (invHoy || []).map(mapInventario).forEach(r => { invPorProd[r.productoId] = r; }); // un solo registro por producto y fecha

  const despPorProd = {};
  (despHoy || []).map(mapDespacho).forEach(r => {
    if (!despPorProd[r.productoId]) despPorProd[r.productoId] = { total: 0, bello: 0, colores: 0, expres: 0 };
    despPorProd[r.productoId].total += r.totalDespachado;
    despPorProd[r.productoId].bello += r.bello;
    despPorProd[r.productoId].colores += r.colores;
    despPorProd[r.productoId].expres += r.puntosExpres;
  });

  const sugPorProd = {};
  (sugHoy || []).forEach(r => { sugPorProd[r.producto_id] = r; });

  estado = productos.map(p => {
    const s = stockPorProd[p.id];
    const inv = invPorProd[p.id];
    const d = despPorProd[p.id] || { total: 0, bello: 0, colores: 0, expres: 0 };
    const sug = sugPorProd[p.id];
    return {
      id: p.id, codigo: p.codigo, nombre: p.nombre, unidad: p.unidad,
      stockActual: s ? Number(s.valor) : null, stockFecha: s ? s.fecha : null, stockOrigen: s ? s.origen : null,
      inventarioId: inv ? inv.id : null, inventariadoHoy: !!inv,
      inventarioHoyValor: inv ? inv.valor : null, inventarioHoyNotas: inv ? inv.notas : null,
      inventarioHoyHora: inv ? inv.hora : null,
      inventarioHoyPesoBruto: inv ? inv.pesoBruto : null,
      inventarioHoyNumCanastas: inv ? inv.numCanastas : null,
      despachadoHoyTotal: d.total, despachadoHoyBello: d.bello, despachadoHoyColores: d.colores, despachadoHoyExpres: d.expres,
      sugeridoBello: sug ? Number(sug.bello) : 0, sugeridoColores: sug ? Number(sug.colores) : 0, sugeridoExpres: sug ? Number(sug.puntos_expres) : 0,
      tieneSugerido: !!sug,
    };
  });
}

async function refrescarTodo() {
  try {
    await cargarProductos();
    await cargarEstado();
    renderInventarioHoy();
    await renderDespachoHoy();
    renderTablaProductos();
    try {
      await cargarPlatano();
      renderPlatano();
    } catch (errPlatano) {
      // No bloquea el resto de la app si todavia no existen las tablas de platano
      // (por ejemplo, antes de correr migration_v4.sql en Supabase).
    }
    if (document.getElementById("tab-pedido").classList.contains("active")) {
      await cargarPedido();
      if (!pedidoError && pedidoFilas.length === 0 && puedeMarcarPedido() && await sembrarPedidoDesdeSugerido()) {
        await cargarPedido();
      }
      renderPedido();
    }
    await renderHistorial();
    await renderDiferencias();
    await renderCorrecciones();
    await renderResumen();
  } catch (err) {
    toast(err.message || "Error cargando datos", true);
  }
}

/* ==========================================================================
   BUSCADOR CON SUGERENCIAS (compartido por Inventario y Despacho)
   ========================================================================== */

function buscarProductosPorTexto(texto, limite = 8) {
  if (!texto) return [];
  texto = texto.toLowerCase();
  return productos
    .filter(p => p.codigo.toLowerCase().includes(texto) || p.nombre.toLowerCase().includes(texto))
    .slice(0, limite);
}

function wireAutocomplete(inputId, dropdownId, onSelect) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  input.addEventListener("input", () => {
    const texto = input.value.trim();
    if (!texto) { dropdown.hidden = true; return; }
    const resultados = buscarProductosPorTexto(texto);
    dropdown.innerHTML = resultados.map(p => `
      <div class="dropdown-item" data-id="${p.id}">
        <span>${escapeHtml(p.nombre)}</span>
        <span class="codigo">${escapeHtml(p.codigo)} · ${p.unidad}</span>
      </div>
    `).join("") || `<div class="dropdown-empty">Sin resultados</div>`;
    dropdown.hidden = false;
    dropdown.querySelectorAll("[data-id]").forEach(el => {
      el.addEventListener("click", () => {
        dropdown.hidden = true;
        input.value = "";
        onSelect(el.dataset.id);
      });
    });
  });
  document.addEventListener("click", (e) => {
    if (e.target !== input && !dropdown.contains(e.target)) dropdown.hidden = true;
  });
}

/* ==========================================================================
   INVENTARIO
   ========================================================================== */

function renderInventarioHoy() {
  const tbody = document.getElementById("tablaInventarioHoy");
  const filas = estado.filter(it => it.inventariadoHoy);
  tbody.innerHTML = filas.map(it => `
    <tr>
      <td>${escapeHtml(it.codigo)}</td>
      <td>${escapeHtml(it.nombre)}</td>
      <td>${fmt(it.inventarioHoyValor, it.unidad)}</td>
      <td>${escapeHtml(it.inventarioHoyNotas || "-")}</td>
      <td>
        <button class="btn-icon" data-editar-inv="${it.id}">Editar</button>
        <button class="btn-icon danger" data-quitar-inv="${it.inventarioId}">Quitar</button>
      </td>
    </tr>
  `).join("") || `<tr class="empty-row"><td colspan="5">Todavía no has agregado productos al inventario de hoy.</td></tr>`;

  tbody.querySelectorAll("[data-editar-inv]").forEach(b => b.addEventListener("click", () => seleccionarProductoInventario(b.dataset.editarInv, true)));
  tbody.querySelectorAll("[data-quitar-inv]").forEach(b => b.addEventListener("click", () => quitarInventario(b.dataset.quitarInv)));
}

/* Copiar el inventario de hoy al portapapeles en columnas separadas por tabulador,
   en el mismo orden de Libro1.xlsx: Peso bruto, Canastas 2.2, (C,D,E vacías),
   Codigo, producto, Peso neto, Destino, Salida, Fecha, Hora. Al pegarlo con Ctrl+V
   en Excel cada valor cae en su propia columna. */
function numExcel(n) {
  if (n === null || n === undefined) return "";
  return String(Math.round(Number(n) * 100) / 100);
}
function fechaExcel(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
async function copiarInventarioParaExcel() {
  const filas = estado.filter(it => it.inventariadoHoy);
  if (filas.length === 0) { toast("No hay productos en el inventario de hoy todavía", true); return; }
  const fechaTexto = fechaExcel(fechaTrabajo());
  const lineas = filas.map(it => {
    const esKg = it.unidad === "KG";
    const bruto = esKg ? numExcel(it.inventarioHoyPesoBruto !== null ? it.inventarioHoyPesoBruto : it.inventarioHoyValor) : "";
    const canastas = esKg ? numExcel(it.inventarioHoyNumCanastas !== null ? it.inventarioHoyNumCanastas : 0) : "";
    const columnas = [
      bruto, canastas, "", "", "",
      it.codigo, it.nombre, numExcel(it.inventarioHoyValor),
      "INVENTARIO", "1", fechaTexto, it.inventarioHoyHora || "",
    ];
    return columnas.join("\t");
  });
  const texto = lineas.join("\n");
  try {
    await navigator.clipboard.writeText(texto);
    toast(`Copiado: ${filas.length} producto(s). Pégalo con Ctrl+V en tu Excel.`);
  } catch (err) {
    toast("No se pudo copiar automáticamente (revisa permisos del navegador)", true);
  }
}
document.getElementById("btnCopiarExcel").addEventListener("click", copiarInventarioParaExcel);

/* Modal generico para pedir un motivo al editar o eliminar un conteo de un dia anterior. */
function abrirModalMotivoCorreccion(titulo, mensajeExtra, onConfirmar) {
  const bodyHtml = `
    <div class="modal-body-grid">
      <div class="alerta-box">${mensajeExtra}</div>
      <label>Motivo
        <select id="motivoCorreccionSelect">${MOTIVOS_CORRECCION.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("")}</select>
      </label>
      <label>Nota (opcional)
        <input type="text" id="motivoCorreccionNota" placeholder="Detalle adicional...">
      </label>
    </div>
  `;
  abrirModal(titulo, bodyHtml, {
    textoConfirmar: "Confirmar",
    onConfirm: () => {
      const motivo = document.getElementById("motivoCorreccionSelect").value;
      const nota = document.getElementById("motivoCorreccionNota").value.trim();
      onConfirmar(motivo, nota);
    },
  });
}

// Guarda el conteo de inventario. Devuelve { requiereMotivo } si el conteo no
// coincide con el stock esperado, o { requiereMotivoEdicion } si el registro
// que se esta tocando es de un dia anterior al de hoy (real), en vez de guardar
// directamente -- asi la UI pide el motivo antes de continuar.
async function guardarInventario(p, cuerpo) {
  if (esSoloLectura()) throw new Error("Estás en modo solo lectura, no puedes guardar cambios.");
  const numCanastas = Number(cuerpo.numCanastas) || 0;
  const pesoCanasta = Number(cuerpo.pesoCanasta) > 0 ? Number(cuerpo.pesoCanasta) : 2.2;
  const valorIngresado = Number(cuerpo.valor) || 0;
  let modo = "neto";
  let valorEntrada = valorIngresado;
  if (p.unidad === "UND") {
    modo = "unidad";
  } else if (numCanastas > 0) {
    modo = "bruto";
    valorEntrada = valorIngresado - (numCanastas * pesoCanasta);
  }
  if (valorEntrada < 0) throw new Error("El valor calculado es negativo, revisa canastas/peso");

  const { data: existentesHoy, error: eExist } = await sb.from("inventarios").select("*")
    .eq("producto_id", p.id).eq("fecha", cuerpo.fecha);
  throwIfError(eExist);
  const existenteHoy = (existentesHoy && existentesHoy.length > 0) ? existentesHoy[0] : null;
  const acumular = !!cuerpo.acumular && !!existenteHoy;

  const hoyReal = todayISO();
  const esEdicionDiaAnterior = !!existenteHoy && existenteHoy.fecha !== hoyReal;
  if (esEdicionDiaAnterior && !cuerpo.motivoEdicion) {
    return { requiereMotivoEdicion: true, fecha: existenteHoy.fecha, valorActual: Number(existenteHoy.valor), unidad: p.unidad };
  }

  const stockRow = await fetchStockRow(p.id);
  const anterior = stockRow ? Number(stockRow.valor) : null;

  let valor;
  if (acumular) {
    valor = Number(existenteHoy.valor) + valorEntrada;
  } else {
    valor = valorEntrada;
    if (anterior !== null && Math.abs(valor - anterior) > TOLERANCIA && !cuerpo.motivo) {
      return { requiereMotivo: true, valorEsperado: anterior, valorNuevo: valor, unidad: p.unidad };
    }
  }

  let invRow;
  if (existenteHoy) {
    const patch = { valor, hora: horaActual() };
    if (acumular) {
      patch.modo = modo;
      if (modo === "bruto") {
        const prevBruto = Number(existenteHoy.peso_bruto) || 0;
        const prevCanastas = Number(existenteHoy.num_canastas) || 0;
        patch.peso_bruto = prevBruto + valorIngresado;
        patch.num_canastas = prevCanastas + numCanastas;
        patch.peso_canasta = pesoCanasta;
      } else {
        patch.peso_bruto = null; patch.num_canastas = null; patch.peso_canasta = null;
      }
      const notaNueva = (cuerpo.notas || "").trim();
      const notaPrevia = (existenteHoy.notas || "").trim();
      patch.notas = notaNueva && notaPrevia ? `${notaPrevia}; ${notaNueva}` : (notaNueva || notaPrevia || null);
    } else {
      patch.modo = modo;
      patch.peso_bruto = modo === "bruto" ? valorIngresado : null;
      patch.num_canastas = modo === "bruto" ? numCanastas : null;
      patch.peso_canasta = modo === "bruto" ? pesoCanasta : null;
      patch.notas = cuerpo.notas || null;
    }
    const { data, error } = await sb.from("inventarios").update(patch).eq("id", existenteHoy.id).select().single();
    throwIfError(error);
    invRow = data;
    await sb.from("diferencias").delete().eq("inventario_id", invRow.id);
  } else {
    const { data, error } = await sb.from("inventarios").insert({
      producto_id: p.id, fecha: cuerpo.fecha, hora: horaActual(), modo,
      peso_bruto: modo === "bruto" ? valorIngresado : null,
      num_canastas: modo === "bruto" ? numCanastas : null,
      peso_canasta: modo === "bruto" ? pesoCanasta : null,
      valor, notas: cuerpo.notas || null,
    }).select().single();
    throwIfError(error);
    invRow = data;
  }

  let diferencia = null;
  if (!acumular && anterior !== null && Math.abs(valor - anterior) > TOLERANCIA) {
    const { data: difRow, error: e2 } = await sb.from("diferencias").insert({
      producto_id: p.id, fecha: cuerpo.fecha, valor_esperado: anterior, valor_real: valor,
      diferencia: valor - anterior, motivo: cuerpo.motivo || null, nota: cuerpo.motivoNota || null,
      inventario_id: invRow.id,
    }).select().single();
    throwIfError(e2);
    diferencia = mapDiferencia(difRow);
  }

  if (esEdicionDiaAnterior) {
    await registrarCorreccion({
      tipo: acumular ? "sumar" : "editar", productoId: p.id, fecha: invRow.fecha,
      valorAnterior: existenteHoy ? Number(existenteHoy.valor) : null, valorNuevo: valor,
      motivo: cuerpo.motivoEdicion, nota: cuerpo.motivoEdicionNota, inventarioId: invRow.id,
    });
  }

  await upsertStock(p.id, valor, cuerpo.fecha, "inventario");
  return { inventario: mapInventario(invRow), diferencia };
}

// Elimina un conteo. Devuelve { requiereMotivoEdicion } en vez de borrar si el
// registro es de un dia anterior al de hoy (real) y no viene motivo.
async function eliminarInventarioCloud(id, motivoEdicion, motivoEdicionNota) {
  if (esSoloLectura()) throw new Error("Estás en modo solo lectura, no puedes eliminar registros.");
  const { data: inv, error } = await sb.from("inventarios").select("*").eq("id", id).single();
  throwIfError(error);
  const ultimo = await ultimoMovimientoDeProducto(inv.producto_id);
  if (!ultimo || ultimo.id !== id) throw new Error("Solo se puede eliminar el ultimo movimiento registrado de este producto");

  const hoyReal = todayISO();
  if (inv.fecha !== hoyReal && !motivoEdicion) {
    return { requiereMotivoEdicion: true, fecha: inv.fecha, valorActual: Number(inv.valor) };
  }
  if (inv.fecha !== hoyReal) {
    await registrarCorreccion({
      tipo: "eliminar", productoId: inv.producto_id, fecha: inv.fecha,
      valorAnterior: Number(inv.valor), valorNuevo: null,
      motivo: motivoEdicion, nota: motivoEdicionNota, inventarioId: inv.id,
    });
  }

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
  return { ok: true };
}

async function quitarInventario(inventarioId) {
  if (!confirm("¿Quitar este producto del inventario de hoy?")) return;
  try {
    const resultado = await eliminarInventarioCloud(inventarioId);
    if (resultado.requiereMotivoEdicion) {
      abrirModalMotivoCorreccion(
        "Explica por qué eliminas este registro",
        `Este conteo es del <strong>${resultado.fecha}</strong> (un día anterior). Indica el motivo para eliminarlo.`,
        async (motivo, nota) => {
          try {
            await eliminarInventarioCloud(inventarioId, motivo, nota);
            cerrarModal();
            toast("Eliminado con motivo registrado");
            await refrescarTodo();
          } catch (err2) {
            toast(err2.message || "No se pudo eliminar", true);
          }
        }
      );
      return;
    }
    toast("Quitado del inventario de hoy");
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo quitar (puede que ya se haya despachado)", true);
  }
}

function seleccionarProductoInventario(productoId, modoEdicion = false) {
  const p = productosPorId[productoId];
  const it = estado.find(e => e.id === productoId);
  if (!p) return;
  const container = document.getElementById("formInventarioInline");
  container.hidden = false;

  const yaHoy = it.inventariadoHoy;
  const acumulando = yaHoy && !modoEdicion;

  const camposHtml = p.unidad === "KG" ? `
    <div class="form-grid">
      <label>Peso (kg)
        <input type="number" id="invValor" min="0" step="0.01" inputmode="decimal">
      </label>
      <label>N° de canastas (opcional)
        <input type="number" id="invNumCanastas" min="0" step="1" placeholder="Vacío = peso ya neto">
      </label>
      <label>Peso por canasta (kg)
        <input type="number" id="invPesoCanasta" min="0" step="0.01" value="2.2">
      </label>
    </div>
    <div class="calc-line" id="calcLinea">Peso neto: <strong>0 kg</strong></div>
  ` : `
    <div class="form-grid">
      <label>Cantidad (unidades)
        <input type="number" id="invValor" min="0" step="1" inputmode="numeric">
      </label>
    </div>
  `;

  let badge = "";
  if (modoEdicion && yaHoy) {
    badge = '<span class="badge badge-ok">Editando el registro de hoy</span>';
  } else if (acumulando) {
    badge = `<span class="badge badge-ok">Ya tienes ${fmt(it.inventarioHoyValor, p.unidad)} hoy · esto se sumará</span>`;
  }

  container.innerHTML = `
    <div class="producto-elegido">${escapeHtml(p.codigo)} · ${escapeHtml(p.nombre)} ${badge}</div>
    ${camposHtml}
    <label class="campo-simple">Notas (opcional)
      <input type="text" id="invNotas" placeholder="Opcional">
    </label>
    <div class="form-actions">
      <button type="button" class="btn-primary" id="btnGuardarInventarioInline">${modoEdicion && yaHoy ? "Guardar cambios" : (acumulando ? "Sumar al inventario de hoy" : "Agregar al inventario de hoy")}</button>
      <button type="button" class="btn-ghost" id="btnCancelarInventarioInline">Cancelar</button>
    </div>
  `;

  if (modoEdicion && yaHoy) {
    document.getElementById("invValor").value = it.inventarioHoyValor;
    document.getElementById("invNotas").value = it.inventarioHoyNotas || "";
  }

  if (p.unidad === "KG") {
    const recalcular = () => {
      const valor = Number(document.getElementById("invValor").value) || 0;
      const n = Number(document.getElementById("invNumCanastas").value) || 0;
      const tara = Number(document.getElementById("invPesoCanasta").value) || 2.2;
      const neto = n > 0 ? valor - (n * tara) : valor;
      const el = document.getElementById("calcLinea");
      el.innerHTML = `Peso neto: <strong>${neto.toLocaleString("es-CO", { maximumFractionDigits: 2 })} kg</strong>` +
        (n > 0 ? "" : ` <small style="color:var(--muted)">(directo, sin canastas)</small>`);
      el.classList.toggle("negativo", neto < 0);
    };
    ["invValor", "invNumCanastas", "invPesoCanasta"].forEach(id => document.getElementById(id).addEventListener("input", recalcular));
    recalcular();
  }

  document.getElementById("btnGuardarInventarioInline").addEventListener("click", () => confirmarInventarioInline(p, acumulando ? { acumular: true } : null));
  document.getElementById("btnCancelarInventarioInline").addEventListener("click", cerrarFormInventarioInline);
  document.getElementById("invValor").focus();
}

function cerrarFormInventarioInline() {
  const container = document.getElementById("formInventarioInline");
  container.hidden = true;
  container.innerHTML = "";
}

function leerCuerpoInventarioInline(p) {
  const fecha = fechaTrabajo();
  const notas = document.getElementById("invNotas").value.trim();
  const valor = Number(document.getElementById("invValor").value) || 0;
  if (p.unidad === "UND") {
    return { productoId: p.id, fecha, valor, notas };
  }
  return {
    productoId: p.id, fecha, valor, notas,
    numCanastas: Number(document.getElementById("invNumCanastas").value) || 0,
    pesoCanasta: Number(document.getElementById("invPesoCanasta").value) || 2.2,
  };
}

async function confirmarInventarioInline(p, cuerpoExtra) {
  let cuerpo;
  try {
    cuerpo = leerCuerpoInventarioInline(p);
  } catch (e) {
    toast("Revisa los datos ingresados", true);
    return;
  }
  if (cuerpoExtra) Object.assign(cuerpo, cuerpoExtra);

  try {
    const resultado = await guardarInventario(p, cuerpo);
    if (resultado.requiereMotivo) {
      abrirModalMotivoInventario(p, cuerpo, resultado);
      return;
    }
    if (resultado.requiereMotivoEdicion) {
      abrirModalMotivoCorreccion(
        "Explica por qué editas este registro",
        `Este conteo es del <strong>${resultado.fecha}</strong> (un día anterior). Indica el motivo del cambio.`,
        async (motivo, nota) => {
          try {
            const cuerpo2 = Object.assign({}, cuerpo, { motivoEdicion: motivo, motivoEdicionNota: nota });
            const resultado2 = await guardarInventario(p, cuerpo2);
            if (resultado2.requiereMotivo) {
              cerrarModal();
              abrirModalMotivoInventario(p, cuerpo2, resultado2);
              return;
            }
            cerrarModal();
            cerrarFormInventarioInline();
            toast("Guardado con motivo registrado");
            await refrescarTodo();
          } catch (err2) {
            toast(err2.message || "No se pudo guardar", true);
          }
        }
      );
      return;
    }
    cerrarFormInventarioInline();
    toast("Guardado en el inventario de hoy");
    await refrescarTodo();
    document.getElementById("buscarInventario").focus();
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
        cerrarFormInventarioInline();
        toast("Guardado con motivo registrado");
        await refrescarTodo();
      } catch (err) {
        toast(err.message || "No se pudo guardar", true);
      }
    },
  });
}

/* ==========================================================================
   SUGERIDO DEL DIA (importado desde Google Sheets, pegando el rango copiado)
   ========================================================================== */

// Interpreta el texto pegado desde la hoja "PEDIDO LEGUMBRE OR": cada fila es
// codigo, producto, unidad, Bello, Colores, y de ahi en adelante (hasta la
// columna M) el resto de los puntos, que se suman como Puntos Expres.
async function importarSugeridos(texto, fecha) {
  if (esSoloLectura()) throw new Error("Estás en modo solo lectura, no puedes importar el sugerido.");
  const parseNum = (v) => {
    const n = Number(String(v ?? "").replace(/,/g, "").trim());
    return isNaN(n) ? 0 : n;
  };
  const filas = texto.split(/\r?\n/).map(l => l.split("\t"));
  // Se acumula por producto_id (en vez de empujar directo a un arreglo) porque si el
  // mismo codigo aparece repetido en lo pegado, Supabase rechaza un upsert que toque
  // la misma fila (producto_id, fecha) dos veces en un solo envio.
  const porProducto = new Map();
  let noEncontrados = 0;

  for (const cols of filas) {
    const codigo = String(cols[0] ?? "").trim();
    if (!codigo) continue;
    const producto = productos.find(p => p.codigo.trim() === codigo);
    if (!producto) { noEncontrados++; continue; }

    const bello = parseNum(cols[3]);
    const colores = parseNum(cols[4]);
    let expres = 0;
    for (let i = 5; i <= 12; i++) expres += parseNum(cols[i]);

    if (bello === 0 && colores === 0 && expres === 0) continue;

    const previo = porProducto.get(producto.id) || { bello: 0, colores: 0, expres: 0 };
    porProducto.set(producto.id, {
      bello: previo.bello + bello, colores: previo.colores + colores, expres: previo.expres + expres,
    });
  }

  const registros = Array.from(porProducto.entries()).map(([producto_id, v]) => ({
    producto_id, fecha, bello: v.bello, colores: v.colores, puntos_expres: v.expres,
    actualizado_en: new Date().toISOString(),
  }));

  if (registros.length > 0) {
    const { error } = await sb.from("sugeridos").upsert(registros, { onConflict: "producto_id,fecha" });
    throwIfError(error);
  }
  return { encontrados: registros.length, noEncontrados };
}

document.getElementById("btnImportarSugerido").addEventListener("click", async () => {
  const textarea = document.getElementById("sugeridoTexto");
  const texto = textarea.value;
  if (!texto.trim()) { toast("Pega primero los datos copiados de la hoja", true); return; }
  try {
    const { encontrados, noEncontrados } = await importarSugeridos(texto, fechaTrabajo());
    let pedidoFilasGuardadas = 0;
    let pedidoAviso = "";
    try {
      pedidoFilasGuardadas = await importarPedidoDia(texto, fechaTrabajo());
    } catch (errPedido) {
      pedidoAviso = " · No se pudo guardar el pedido (¿ya corriste la migración v10?)";
    }
    if (encontrados === 0 && pedidoFilasGuardadas === 0) { toast("No se reconoció ningún código en lo pegado", true); return; }
    textarea.value = "";
    toast(`Sugerido importado: ${encontrados} producto(s)` + (noEncontrados ? ` · ${noEncontrados} código(s) no encontrado(s)` : "") + (pedidoFilasGuardadas ? ` · Pedido: ${pedidoFilasGuardadas} fila(s)` : "") + pedidoAviso);
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo importar el sugerido", true);
  }
});

/* ---------- Hojas de impresion del sugerido (mallas y varios grupos de
   productos que un companero necesita ver impresos en papel) ---------- */

function normalizarNombreSugerido(s) {
  return String(s || "").trim().toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Lee el texto pegado en el textarea de sugerido tal cual (sin exigir que el
// codigo exista en el catalogo), porque algunas filas de la hoja solo traen
// nombre y no codigo, y para imprimir igual se necesitan.
function parsearFilasSugeridoParaImprimir(texto) {
  const parseNum = (v) => {
    const n = Number(String(v ?? "").replace(/,/g, "").trim());
    return isNaN(n) ? 0 : n;
  };
  const filas = texto.split(/\r?\n/).map(l => l.split("\t"));
  const resultado = [];
  for (const cols of filas) {
    const codigo = String(cols[0] ?? "").trim();
    const nombre = String(cols[1] ?? "").trim();
    if (!codigo && !nombre) continue;
    const bello = parseNum(cols[3]);
    const colores = parseNum(cols[4]);
    let expres = 0;
    for (let i = 5; i <= 12; i++) expres += parseNum(cols[i]);
    if (bello === 0 && colores === 0 && expres === 0) continue;
    resultado.push({ codigo, nombre, bello, colores, expres });
  }
  return resultado;
}

const HOJAS_SUGERIDO_IMPRIMIR = [
  {
    titulo: "Mallas y ofertas",
    codigos: ["308", "302", "13241", "13095", "83", "13215", "13106", "287", "291", "13248", "13295", "311", "312"],
    nombres: [
      "Oferta Guayaba paquete *2000", "Oferta Tómate aliño malla", "Oferta Cebolla huevo malla",
      "Oferta Pepino malla", "Oferta Tómate árbol malla", "Oferta Aguacate malla", "Oferta Mango malla",
      "Oferta Papayuela paquete", "Oferta Maracuya malla", "Oferta Limon mandarino malla",
      "Oferta Limón taity malla", "Oferta Papa criolla malla", "Oferta Durazno bandeja malla",
      "Oferta Ciruela bandeja malla",
    ].map(normalizarNombreSugerido),
  },
  {
    titulo: "Legumbre",
    codigos: ["424", "405", "306", "309", "367", "53", "159", "177"],
    nombres: [],
  },
  {
    titulo: "Ramas",
    codigos: ["368", "369", "197", "76", "39", "40", "70", "121", "93", "149", "109"],
    nombres: [],
  },
];

function filtrarFilasParaHoja(filas, hoja) {
  const codigosSet = new Set(hoja.codigos);
  return filas.filter(f => {
    if (f.codigo && codigosSet.has(f.codigo)) return true;
    if (!f.codigo && hoja.nombres.includes(normalizarNombreSugerido(f.nombre))) return true;
    return false;
  });
}

function renderHojaImprimirSugerido(hoja, filas, fecha, saltoPagina) {
  const total = (campo) => filas.reduce((a, f) => a + Number(f[campo]), 0);
  const totalLinea = (f) => Number(f.bello) + Number(f.colores) + Number(f.expres);
  const totalGeneral = filas.reduce((a, f) => a + totalLinea(f), 0);
  const filasHtml = filas.map(f => `
    <tr>
      <td>${escapeHtml(f.nombre || f.codigo)}</td>
      <td class="num">${f.bello || "-"}</td>
      <td class="num">${f.colores || "-"}</td>
      <td class="num">${f.expres || "-"}</td>
      <td class="num">${totalLinea(f)}</td>
    </tr>
  `).join("") || `<tr><td colspan="5">Sin pedido para este grupo en lo pegado.</td></tr>`;
  return `
    <div class="hoja-imprimir${saltoPagina ? " hoja-salto-pagina" : ""}">
      <h2>${escapeHtml(hoja.titulo)}</h2>
      <div class="hoja-sub">Mercados y Carnes OR · Sugerido del ${fecha}</div>
      <table>
        <thead><tr><th>Producto</th><th>Bello</th><th>Colores</th><th>Puntos Expres</th><th>Total</th></tr></thead>
        <tbody>${filasHtml}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${total("bello")}</td><td class="num">${total("colores")}</td><td class="num">${total("expres")}</td><td class="num">${totalGeneral}</td></tr></tfoot>
      </table>
    </div>
  `;
}

document.getElementById("btnImprimirSugerido").addEventListener("click", () => {
  const texto = document.getElementById("sugeridoTexto").value;
  if (!texto.trim()) { toast("Pega primero los datos copiados de la hoja (antes de importar, porque Importar borra el cuadro)", true); return; }
  const filas = parsearFilasSugeridoParaImprimir(texto);
  const fecha = fechaExcel(fechaTrabajo());
  const html = HOJAS_SUGERIDO_IMPRIMIR
    .map((hoja, i) => renderHojaImprimirSugerido(hoja, filtrarFilasParaHoja(filas, hoja), fecha, i === 0))
    .join("");
  document.getElementById("areaImprimirSugerido").innerHTML = html;
  window.print();
});

/* ==========================================================================
   DESPACHO
   ========================================================================== */

function celdaConPedido(valor, pedido, unidad) {
  const pedidoHtml = pedido !== null
    ? `<div style="font-size:10.5px;color:var(--muted);line-height:1.3">Pedido: ${fmt(pedido, unidad)}</div>`
    : "";
  return `<td>${pedidoHtml}${fmt(valor, unidad)}</td>`;
}

function filaDespachoHoy(d) {
  const p = productosPorId[d.productoId];
  const unidad = p ? p.unidad : "";
  const it = estado.find(e => e.id === d.productoId);
  const tieneSugerido = it && it.tieneSugerido;
  return `
    <tr>
      <td>${d.hora || ""}</td>
      <td>${p ? escapeHtml(p.codigo) : "-"}</td>
      <td>${p ? escapeHtml(p.nombre) : "(eliminado)"}</td>
      ${celdaConPedido(d.bello, tieneSugerido ? it.sugeridoBello : null, unidad)}
      ${celdaConPedido(d.colores, tieneSugerido ? it.sugeridoColores : null, unidad)}
      ${celdaConPedido(d.puntosExpres, tieneSugerido ? it.sugeridoExpres : null, unidad)}
      <td>${fmt(d.queda, unidad)}</td>
      <td><button class="btn-icon danger" data-quitar-desp="${d.id}">✕</button></td>
    </tr>
  `;
}

async function renderDespachoHoy() {
  let items;
  try {
    const { data, error } = await sb.from("despachos").select("*").eq("fecha", fechaTrabajo()).order("hora");
    throwIfError(error);
    items = (data || []).map(mapDespacho);
  } catch (err) {
    toast(err.message || "No se pudo cargar el despacho de hoy", true);
    return;
  }
  const tbody = document.getElementById("tablaDespachoHoy");
  tbody.innerHTML = items.map(filaDespachoHoy).join("") || `<tr class="empty-row"><td colspan="8">Sin despachos todavía.</td></tr>`;
  tbody.querySelectorAll("[data-quitar-desp]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("¿Eliminar este despacho? Solo se puede si es el último movimiento de ese producto.")) return;
    try {
      await eliminarDespachoCloud(b.dataset.quitarDesp);
      toast("Despacho eliminado");
      await refrescarTodo();
    } catch (err) {
      toast(err.message || "No se pudo eliminar", true);
    }
  }));
}

function seleccionarProductoDespacho(productoId) {
  const p = productosPorId[productoId];
  const it = estado.find(e => e.id === productoId);
  if (!p) return;
  const container = document.getElementById("formDespachoInline");
  container.hidden = false;

  const sinInventario = it.stockActual === null;
  const disponibleBase = sinInventario ? 0 : Number(it.stockActual);

  const step = p.unidad === "UND" ? "1" : "0.01";
  const sugerido = it.tieneSugerido
    ? `<span class="sep">·</span><span>Piden: <strong>Bello ${fmt(it.sugeridoBello, p.unidad)} · Colores ${fmt(it.sugeridoColores, p.unidad)} · Expres ${fmt(it.sugeridoExpres, p.unidad)}</strong></span>`
    : "";
  const avisoSinInventario = sinInventario
    ? `<div class="alerta-box">Este producto no tiene inventario registrado todavía. Puedes despacharlo igual, pero va a quedar la diferencia en negativo hasta que lo cuentes en Inventario.</div>`
    : "";
  container.innerHTML = `
    <div class="producto-elegido">${escapeHtml(p.codigo)} · ${escapeHtml(p.nombre)}</div>
    <div class="datos-referencia">
      <span>Disponible: <strong>${sinInventario ? "Sin registrar (0)" : fmt(it.stockActual, p.unidad)}</strong></span>
      ${sugerido}
    </div>
    ${avisoSinInventario}
    <div class="form-grid">
      <label>Bello
        <input type="number" id="despBello" min="0" step="${step}" value="0">
      </label>
      <label>Colores
        <input type="number" id="despColores" min="0" step="${step}" value="0">
      </label>
      <label>Puntos Expres
        <input type="number" id="despExpres" min="0" step="${step}" value="0">
      </label>
    </div>
    <div class="calc-line" id="calcDespacho">Despachando: <strong>0</strong> · Queda: <strong>${fmt(disponibleBase, p.unidad)}</strong></div>
    <label class="campo-simple">Notas (opcional)
      <input type="text" id="despNotas" placeholder="Opcional">
    </label>
    <div class="form-actions">
      <button type="button" class="btn-primary" id="btnGuardarDespachoInline">Registrar despacho</button>
      <button type="button" class="btn-ghost" id="btnCancelarDespachoInline">Cancelar</button>
    </div>
  `;

  const recalcular = () => {
    const bello = Number(document.getElementById("despBello").value) || 0;
    const colores = Number(document.getElementById("despColores").value) || 0;
    const expres = Number(document.getElementById("despExpres").value) || 0;
    const total = bello + colores + expres;
    const queda = disponibleBase - total;
    const el = document.getElementById("calcDespacho");
    el.innerHTML = `Despachando: <strong>${fmt(total, p.unidad)}</strong> · Queda: <strong>${fmt(queda, p.unidad)}</strong>`;
    el.classList.toggle("negativo", queda < 0);
  };
  ["despBello", "despColores", "despExpres"].forEach(id => document.getElementById(id).addEventListener("input", recalcular));
  recalcular();

  document.getElementById("btnGuardarDespachoInline").addEventListener("click", () => confirmarDespachoInline(p));
  document.getElementById("btnCancelarDespachoInline").addEventListener("click", cerrarFormDespachoInline);
  document.getElementById("despBello").focus();
}

function cerrarFormDespachoInline() {
  const container = document.getElementById("formDespachoInline");
  container.hidden = true;
  container.innerHTML = "";
}

async function guardarDespacho(p, cuerpo) {
  if (esSoloLectura()) throw new Error("Estás en modo solo lectura, no puedes registrar despachos.");
  const stockRow = await fetchStockRow(p.id);
  const disponible = stockRow ? Number(stockRow.valor) : 0;
  const bello = Number(cuerpo.bello) || 0;
  const colores = Number(cuerpo.colores) || 0;
  const expres = Number(cuerpo.puntosExpres) || 0;
  const total = bello + colores + expres;
  if (total <= 0) throw new Error("Debes despachar una cantidad mayor a 0");

  if (total > disponible && !cuerpo.forzar) {
    return { excedeDisponible: true, disponible, total, unidad: p.unidad };
  }

  const queda = disponible - total;
  const { data: despRow, error } = await sb.from("despachos").insert({
    producto_id: p.id, fecha: cuerpo.fecha, hora: horaActual(), disponible_antes: disponible,
    bello, colores, puntos_expres: expres,
    total_despachado: total, queda, notas: cuerpo.notas || null, excede_inventario: total > disponible,
  }).select().single();
  throwIfError(error);

  await upsertStock(p.id, queda, cuerpo.fecha, "despacho");
  return { despacho: mapDespacho(despRow) };
}

async function eliminarDespachoCloud(id) {
  if (esSoloLectura()) throw new Error("Estás en modo solo lectura, no puedes eliminar despachos.");
  const { data: desp, error } = await sb.from("despachos").select("*").eq("id", id).single();
  throwIfError(error);
  const ultimo = await ultimoMovimientoDeProducto(desp.producto_id);
  if (!ultimo || ultimo.id !== id) throw new Error("Solo se puede eliminar el ultimo movimiento registrado de este producto");

  await sb.from("despachos").delete().eq("id", id);
  await upsertStock(desp.producto_id, Number(desp.disponible_antes), desp.fecha, "inventario");
  return { ok: true };
}

async function confirmarDespachoInline(p, forzar) {
  const cuerpo = {
    productoId: p.id,
    fecha: fechaTrabajo(),
    bello: Number(document.getElementById("despBello").value) || 0,
    colores: Number(document.getElementById("despColores").value) || 0,
    puntosExpres: Number(document.getElementById("despExpres").value) || 0,
    notas: document.getElementById("despNotas").value.trim(),
  };
  if (forzar) cuerpo.forzar = true;

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
    cerrarFormDespachoInline();
    toast("Despacho registrado");
    await refrescarTodo();
    document.getElementById("buscarDespacho").focus();
  } catch (err) {
    toast(err.message || "No se pudo registrar el despacho", true);
  }
}

async function confirmarDespachoForzado(p, cuerpo) {
  try {
    await guardarDespacho(p, Object.assign({}, cuerpo, { forzar: true }));
    cerrarModal();
    cerrarFormDespachoInline();
    toast("Despacho registrado (excede lo inventariado)");
    await refrescarTodo();
  } catch (err) {
    toast(err.message || "No se pudo registrar el despacho", true);
  }
}

wireAutocomplete("buscarInventario", "dropdownInventario", seleccionarProductoInventario);
wireAutocomplete("buscarDespacho", "dropdownDespacho", seleccionarProductoDespacho);

/* ==========================================================================
   PLATANO (libro contable acumulado: Entradas, Maduracion, Salidas -- no se
   reinicia cada dia, a diferencia del inventario normal)
   ========================================================================== */

let platanoEntradas = [];
let platanoMaduraciones = [];
let platanoSalidas = [];
let platanoAjustes = [];

const PLATANO_PROVEEDORES_SUGERIDOS = ["Gerardo Carvajal", "Alejandro Granados", "Finca Valle", "Alejandro Arias", "Zuleta", "Flor del Plátano"];

async function cargarPlatano() {
  const [{ data: e, error: e1 }, { data: m, error: e2 }, { data: s, error: e3 }, { data: a, error: e4 }] = await Promise.all([
    sb.from("platano_entradas").select("*").order("fecha", { ascending: false }).order("creado_en", { ascending: false }),
    sb.from("platano_maduracion").select("*").order("fecha", { ascending: false }).order("creado_en", { ascending: false }),
    sb.from("platano_salidas").select("*").order("fecha", { ascending: false }).order("creado_en", { ascending: false }),
    sb.from("platano_ajustes_canastas").select("*").order("fecha", { ascending: false }).order("creado_en", { ascending: false }),
  ]);
  throwIfError(e1); throwIfError(e2); throwIfError(e3); throwIfError(e4);
  platanoEntradas = e || [];
  platanoMaduraciones = m || [];
  platanoSalidas = s || [];
  platanoAjustes = a || [];
}

// El sugerido de Platano Verde/Maduro se pega junto con el de todos los demas
// productos en "Sugerido del dia" (pestaña Despacho) -- aqui solo se lee lo
// que ya quedo importado para los productos "PLATANO VERDE" y "PLATANO MADURO".
function platanoSugerido(producto) {
  const nombreBuscado = producto === "MADURO" ? "PLATANO MADURO" : "PLATANO VERDE";
  const it = estado.find(e => e.nombre && e.nombre.trim().toUpperCase() === nombreBuscado);
  if (!it || !it.tieneSugerido) return { bello: 0, colores: 0, puntos_expres: 0 };
  return { bello: it.sugeridoBello, colores: it.sugeridoColores, puntos_expres: it.sugeridoExpres };
}

// Bello y Colores son destinos exactos; todo lo demas (campoamor, casafruber,
// ewin, listas, etc.) cuenta como Puntos Expres. Desperdicio no es un destino
// real, no entra en el comparativo de pedido vs despachado.
function clasePlatanoDestino(destino) {
  const d = (destino || "").trim().toLowerCase();
  if (d === "bello") return "bello";
  if (d === "colores") return "colores";
  if (d === "desperdicio") return null;
  return "expres";
}

function platanoDespachadoPorDestino(fecha) {
  const resultado = {
    VERDE: { bello: 0, colores: 0, expres: 0 },
    MADURO: { bello: 0, colores: 0, expres: 0 },
  };
  platanoSalidas.filter(s => s.fecha === fecha).forEach(s => {
    const clase = clasePlatanoDestino(s.destino);
    if (!clase || !resultado[s.producto]) return;
    resultado[s.producto][clase] += Number(s.peso_neto);
  });
  return resultado;
}

function renderPlatanoComparativo() {
  const fecha = document.getElementById("filtroFechaPlatano").value || todayISO();
  const despachado = platanoDespachadoPorDestino(fecha);
  const filas = [
    { etiqueta: "Verde", clave: "VERDE" },
    { etiqueta: "Maduro", clave: "MADURO" },
  ];
  document.getElementById("tablaPlatanoComparativo").innerHTML = filas.map(f => {
    const pide = platanoSugerido(f.clave);
    const va = despachado[f.clave];
    const celda = (pedido, hecho) => `<td>Piden ${fmtKgPlatano(pedido)} <br> Van ${fmtKgPlatano(hecho)}</td>`;
    return `
      <tr>
        <td>${f.etiqueta}</td>
        ${celda(pide.bello, va.bello)}
        ${celda(pide.colores, va.colores)}
        ${celda(pide.puntos_expres, va.expres)}
      </tr>
    `;
  }).join("");
}

function pesoNetoPlatano(bruto, canastas) {
  return Math.max(0, (Number(bruto) || 0) - (Number(canastas) || 0) * 2.2);
}
// El redondeo evita que sumas/restas acumuladas dejen un "-0" o un ".0000001"
// cosmetico cuando en la practica el saldo esta exactamente en cero.
function fmtKgPlatano(n) {
  let v = Number(n || 0);
  if (Math.abs(v) < 0.05) v = 0;
  return v.toLocaleString("es-CO", { maximumFractionDigits: 1 }) + " kg";
}
function fmtCanastasPlatano(n) {
  let v = Number(n || 0);
  if (Math.abs(v) < 0.5) v = 0;
  return v.toLocaleString("es-CO", { maximumFractionDigits: 0 }) + " canastas";
}

function platanoVerdeDisponible() {
  const sumar = (arr, campo) => arr.reduce((a, r) => a + Number(r[campo]), 0);
  const salidasVerde = platanoSalidas.filter(s => s.producto === "VERDE");
  const ajustesVerde = platanoAjustes.filter(a => a.ubicacion === "VERDE");
  return {
    kg: sumar(platanoEntradas, "peso_neto") - sumar(salidasVerde, "peso_neto") - sumar(platanoMaduraciones, "peso_neto") + sumar(ajustesVerde, "kilos"),
    canastas: sumar(platanoEntradas, "canastas") - sumar(salidasVerde, "canastas") - sumar(platanoMaduraciones, "canastas") + sumar(ajustesVerde, "canastas"),
  };
}

// Todos los lotes que alguna vez existieron, con su saldo actual (puede ser 0
// si ya se vendio por completo -- igual se puede volver a usar ese numero).
function platanoTodosLosLotes() {
  const numeros = new Set(platanoMaduraciones.map(m => Number(m.lote)));
  const lista = [];
  numeros.forEach(lote => {
    const entradasLote = platanoMaduraciones.filter(m => Number(m.lote) === lote);
    const salidasLote = platanoSalidas.filter(s => s.producto === "MADURO" && Number(s.lote) === lote);
    const ajustesLote = platanoAjustes.filter(a => a.ubicacion === "MADURO" && Number(a.lote) === lote);
    const kg = entradasLote.reduce((a, r) => a + Number(r.peso_neto), 0) - salidasLote.reduce((a, r) => a + Number(r.peso_neto), 0) + ajustesLote.reduce((a, r) => a + Number(r.kilos), 0);
    const canastas = entradasLote.reduce((a, r) => a + Number(r.canastas), 0) - salidasLote.reduce((a, r) => a + Number(r.canastas), 0) + ajustesLote.reduce((a, r) => a + Number(r.canastas), 0);
    lista.push({ lote, kg, canastas });
  });
  return lista.sort((a, b) => a.lote - b.lote);
}

// Cuanto se ha perdido por deshidrate (todo el historico), comparado contra
// todo lo que ha pasado por maduracion, para saber la tasa promedio de merma.
function platanoAnalisisDeshidrate() {
  const esDeshidrate = a => (a.concepto || "").trim().toLowerCase().includes("deshidrat");
  const totalMermaKg = platanoAjustes.filter(esDeshidrate).reduce((s, a) => s + Math.abs(Math.min(0, Number(a.kilos))), 0);
  const totalMaduradoKg = platanoMaduraciones.reduce((s, m) => s + Number(m.peso_neto), 0);
  const porcentaje = totalMaduradoKg > 0 ? (totalMermaKg / totalMaduradoKg) * 100 : 0;
  return { totalMermaKg, totalMaduradoKg, porcentaje };
}
function platanoLotesActivos() {
  return platanoTodosLosLotes().filter(l => l.kg > 0.01);
}

// Kilos brutos por canasta, calculado sobre todo el historico (entradas +
// maduracion + salidas), para poder avisar si un dato nuevo se ve inusual
// comparado con lo que normalmente da una canasta de platano.
const PLATANO_UMBRAL_INUSUAL = 0.10; // 10% de diferencia contra el promedio historico
function platanoFactorHistorico() {
  const ratios = [...platanoEntradas, ...platanoMaduraciones, ...platanoSalidas]
    .filter(r => Number(r.canastas) > 0 && Number(r.peso_bruto) > 0)
    .map(r => Number(r.peso_bruto) / Number(r.canastas));
  if (ratios.length < 5) return null;
  const media = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return { media, n: ratios.length };
}
function platanoRatioInusual(bruto, canastas) {
  if (!bruto || !canastas) return null;
  const factor = platanoFactorHistorico();
  if (!factor) return null;
  const ratio = bruto / canastas;
  const desviacion = (ratio - factor.media) / factor.media;
  if (Math.abs(desviacion) < PLATANO_UMBRAL_INUSUAL) return null;
  return { ratio, media: factor.media, desviacionPct: desviacion * 100 };
}
function platanoProximoLote() {
  const todos = platanoTodosLosLotes();
  return todos.length ? Math.max(...todos.map(l => l.lote)) + 1 : 1;
}

function renderPlatanoResumen() {
  const verde = platanoVerdeDisponible();
  const todosLotes = platanoTodosLosLotes();
  const maduroTotal = {
    kg: todosLotes.reduce((a, l) => a + l.kg, 0),
    canastas: todosLotes.reduce((a, l) => a + l.canastas, 0),
  };
  const html = `
    <div class="kpi-card kpi-green">
      <span class="kpi-label">Verde disponible</span>
      <span class="kpi-value">${fmtKgPlatano(verde.kg)}</span>
      <span class="kpi-label">${fmtCanastasPlatano(verde.canastas)}</span>
    </div>
    <div class="kpi-card kpi-gold">
      <span class="kpi-label">Maduro disponible</span>
      <span class="kpi-value">${fmtKgPlatano(maduroTotal.kg)}</span>
      <span class="kpi-label">${fmtCanastasPlatano(maduroTotal.canastas)}</span>
    </div>
  `;
  document.getElementById("platanoResumenGrid").innerHTML = html;
  document.getElementById("platanoMiniVerde").textContent = `${fmtKgPlatano(verde.kg)} · ${fmtCanastasPlatano(verde.canastas)}`;
  document.getElementById("platanoMiniMaduro").textContent = `${fmtKgPlatano(maduroTotal.kg)} · ${fmtCanastasPlatano(maduroTotal.canastas)}`;
  document.getElementById("platanoMiniLotes").innerHTML = platanoLotesActivos().map(l =>
    `<span>Lote ${l.lote}: ${fmtKgPlatano(l.kg)} · ${fmtCanastasPlatano(l.canastas)}</span>`
  ).join("");
}

// Tabla con TODOS los lotes (incluye los ya vaciados), para responder
// "cuanto queda en cada lote" sin importar si esta activo o no.
function renderPlatanoLotesTabla() {
  const todos = platanoTodosLosLotes();
  document.getElementById("tablaPlatanoLotes").innerHTML = todos.map(l => `
    <tr>
      <td>Lote ${l.lote}</td>
      <td>${fmtKgPlatano(l.kg)}</td>
      <td>${fmtCanastasPlatano(l.canastas)}</td>
    </tr>
  `).join("") || `<tr class="empty-row"><td colspan="3">Todavía no hay lotes de maduración.</td></tr>`;
}

function renderPlatanoFormularios() {
  const verde = platanoVerdeDisponible();
  document.getElementById("platanoVerdeRefMaduracion").innerHTML =
    `<span>Verde disponible: <strong>${fmtKgPlatano(verde.kg)} · ${fmtCanastasPlatano(verde.canastas)}</strong></span>`;

  const todos = platanoTodosLosLotes();
  const proximo = platanoProximoLote();
  const selectorPmLote = document.getElementById("pmLote");
  const valorPrevioPm = selectorPmLote.value;
  selectorPmLote.innerHTML = `<option value="" selected disabled>Selecciona…</option>` + todos.map(l =>
    `<option value="${l.lote}">Lote ${l.lote} (${fmtKgPlatano(l.kg)} · ${fmtCanastasPlatano(l.canastas)}${l.kg <= 0.01 ? " · vacío" : ""})</option>`
  ).join("") + `<option value="nuevo">+ Nuevo lote (${proximo})</option>`;
  if (valorPrevioPm && [...selectorPmLote.options].some(o => o.value === valorPrevioPm)) selectorPmLote.value = valorPrevioPm;

  const activos = platanoLotesActivos();
  const selectorPsLote = document.getElementById("psLote");
  const valorPrevioPs = selectorPsLote.value;
  selectorPsLote.innerHTML = activos.map(l =>
    `<option value="${l.lote}">Lote ${l.lote} (${fmtKgPlatano(l.kg)} · ${fmtCanastasPlatano(l.canastas)})</option>`
  ).join("") || `<option value="">Sin lotes con saldo</option>`;
  if ([...selectorPsLote.options].some(o => o.value === valorPrevioPs)) selectorPsLote.value = valorPrevioPs;

  document.getElementById("platanoProveedores").innerHTML = PLATANO_PROVEEDORES_SUGERIDOS.map(p => `<option value="${escapeHtml(p)}"></option>`).join("");

  const selectorAjLote = document.getElementById("ajLote");
  const valorPrevioAj = selectorAjLote.value;
  selectorAjLote.innerHTML = todos.map(l =>
    `<option value="${l.lote}">Lote ${l.lote} (${fmtKgPlatano(l.kg)} · ${fmtCanastasPlatano(l.canastas)})</option>`
  ).join("") || `<option value="">Sin lotes todavía</option>`;
  if ([...selectorAjLote.options].some(o => o.value === valorPrevioAj)) selectorAjLote.value = valorPrevioAj;

  const deshidrate = platanoAnalisisDeshidrate();
  document.getElementById("platanoDeshidrateRef").innerHTML = deshidrate.totalMaduradoKg > 0
    ? `<span>Deshidrate acumulado: <strong>${fmtKgPlatano(deshidrate.totalMermaKg)}</strong> de ${fmtKgPlatano(deshidrate.totalMaduradoKg)} madurados</span><span class="sep">·</span><span>Promedio: <strong>${deshidrate.porcentaje.toLocaleString("es-CO", { maximumFractionDigits: 1 })}%</strong> (${(deshidrate.porcentaje * 10).toLocaleString("es-CO", { maximumFractionDigits: 1 })} kg por cada 1.000 kg)</span>`
    : `<span>Todavía no hay suficiente historial para calcular el promedio de deshidrate.</span>`;

  actualizarRefSalidaPlatano();
}

function actualizarAjusteLoteWrap() {
  document.getElementById("ajLoteWrap").hidden = document.getElementById("ajUbicacion").value !== "MADURO";
}
document.getElementById("ajUbicacion").addEventListener("change", actualizarAjusteLoteWrap);

function actualizarRefSalidaPlatano() {
  const producto = document.getElementById("psProducto").value;
  document.getElementById("psLoteWrap").hidden = producto !== "MADURO";
  const ref = document.getElementById("platanoDisponibleRefSalida");
  if (!producto) {
    ref.innerHTML = `<span>Selecciona verde o maduro para ver el disponible.</span>`;
    return;
  }
  const esPago = document.getElementById("psEsPago").checked;
  const sug = platanoSugerido(producto);
  const pideAlgo = !esPago && (Number(sug.bello) > 0 || Number(sug.colores) > 0 || Number(sug.puntos_expres) > 0);
  const pidenHtml = pideAlgo
    ? `<span class="sep">·</span><span>Piden hoy: <strong>Bello ${fmtKgPlatano(sug.bello)} · Colores ${fmtKgPlatano(sug.colores)} · Expres ${fmtKgPlatano(sug.puntos_expres)}</strong></span>`
    : "";
  if (producto === "VERDE") {
    const verde = platanoVerdeDisponible();
    ref.innerHTML = `<span>Disponible (verde): <strong>${fmtKgPlatano(verde.kg)} · ${fmtCanastasPlatano(verde.canastas)}</strong></span>${pidenHtml}`;
  } else {
    const lote = document.getElementById("psLote").value;
    const info = platanoTodosLosLotes().find(l => String(l.lote) === String(lote));
    ref.innerHTML = (info
      ? `<span>Disponible (lote ${info.lote}): <strong>${fmtKgPlatano(info.kg)} · ${fmtCanastasPlatano(info.canastas)}</strong></span>`
      : `<span>Selecciona un lote con saldo.</span>`) + pidenHtml;
  }
}
document.getElementById("psProducto").addEventListener("change", actualizarRefSalidaPlatano);
document.getElementById("psLote").addEventListener("change", actualizarRefSalidaPlatano);

function actualizarModoPagoPrestamo() {
  const esPago = document.getElementById("psEsPago").checked;
  document.getElementById("psDestinoLabel").textContent = esPago ? "Proveedor del préstamo" : "A quién se despachó";
  document.getElementById("psDestino").setAttribute("list", esPago ? "platanoProveedores" : "platanoDestinos");
  document.getElementById("psDestino").placeholder = esPago ? "Ej: Gerardo Carvajal" : "Ej: Bello";
  actualizarRefSalidaPlatano();
}
document.getElementById("psEsPago").addEventListener("change", actualizarModoPagoPrestamo);

function wireCalcPlatano(idBruto, idCanastas, idCalc) {
  const recalc = () => {
    const bruto = Number(document.getElementById(idBruto).value) || 0;
    const canastas = Number(document.getElementById(idCanastas).value) || 0;
    const neto = pesoNetoPlatano(bruto, canastas);
    document.getElementById(idCalc).innerHTML = `Peso neto: <strong>${fmtKgPlatano(neto)}</strong>`;
  };
  document.getElementById(idBruto).addEventListener("input", recalc);
  document.getElementById(idCanastas).addEventListener("input", recalc);
}
wireCalcPlatano("peBruto", "peCanastas", "calcPlatanoEntrada");
wireCalcPlatano("pmBruto", "pmCanastas", "calcPlatanoMaduracion");
wireCalcPlatano("psBruto", "psCanastas", "calcPlatanoSalida");

function filaAccionesPlatano(origen, id) {
  return `
    <td>
      <button class="btn-icon" data-plat-edit="${origen}|${id}">✎</button>
      <button class="btn-icon danger" data-plat-del="${origen}|${id}">✕</button>
    </td>
  `;
}

function wirePlatanoAccionesEnTabla(tbodyId) {
  const tbody = document.getElementById(tbodyId);
  tbody.querySelectorAll("[data-plat-edit]").forEach(b => {
    b.addEventListener("click", () => {
      const [origen, id] = b.dataset.platEdit.split("|");
      abrirEditarPlatanoMovimiento(origen, id);
    });
  });
  tbody.querySelectorAll("[data-plat-del]").forEach(b => {
    b.addEventListener("click", () => {
      const [origen, id] = b.dataset.platDel.split("|");
      abrirEliminarPlatanoConMotivo(origen, id);
    });
  });
}

function ordenarPlatanoPorFecha(a, b) {
  return (b.fecha + (b.creado_en || "")).localeCompare(a.fecha + (a.creado_en || ""));
}

function renderPlatanoEntradasHist(enRango, textoFiltro) {
  const filas = platanoEntradas
    .filter(r => enRango(r.fecha))
    .filter(r => !textoFiltro || normalizarNombreSugerido(r.proveedor || "").includes(textoFiltro))
    .sort(ordenarPlatanoPorFecha)
    .slice(0, 300);
  document.getElementById("tablaPlatanoEntradasHist").innerHTML = filas.map(r => `
    <tr>
      <td>${r.fecha}</td>
      <td>${escapeHtml(r.proveedor || "-")}</td>
      <td>${fmtKgPlatano(r.peso_bruto)}</td>
      <td>${fmtCanastasPlatano(r.canastas)}</td>
      <td>${fmtKgPlatano(r.peso_neto)}</td>
      <td>${r.es_prestamo ? "Sí" : "-"}</td>
      ${filaAccionesPlatano("entrada", r.id)}
    </tr>
  `).join("") || `<tr class="empty-row"><td colspan="7">Sin entradas en ese rango.</td></tr>`;
  wirePlatanoAccionesEnTabla("tablaPlatanoEntradasHist");
}

function renderPlatanoSalidasHist(enRango, textoFiltro) {
  const filas = platanoSalidas
    .filter(r => enRango(r.fecha))
    .filter(r => !textoFiltro || normalizarNombreSugerido(r.destino || "").includes(textoFiltro))
    .sort(ordenarPlatanoPorFecha)
    .slice(0, 300);
  document.getElementById("tablaPlatanoSalidasHist").innerHTML = filas.map(r => `
    <tr>
      <td>${r.fecha}</td>
      <td>${r.producto === "MADURO" ? "Maduro" + (r.lote ? ` (lote ${r.lote})` : "") : "Verde"}</td>
      <td>${escapeHtml(r.destino || "-")}</td>
      <td>${fmtKgPlatano(r.peso_bruto)}</td>
      <td>${fmtCanastasPlatano(r.canastas)}</td>
      <td>${fmtKgPlatano(r.peso_neto)}</td>
      <td>${r.es_pago_prestamo ? "Sí" : "-"}</td>
      ${filaAccionesPlatano("salida", r.id)}
    </tr>
  `).join("") || `<tr class="empty-row"><td colspan="8">Sin salidas en ese rango.</td></tr>`;
  wirePlatanoAccionesEnTabla("tablaPlatanoSalidasHist");
}

function renderPlatanoOtrosHist(enRango) {
  const items = [
    ...platanoMaduraciones.filter(r => enRango(r.fecha)).map(r => ({
      tipo: "A maduración", origen: "maduracion", detalle: `Lote ${r.lote}`,
      bruto: r.peso_bruto, canastas: r.canastas, neto: r.peso_neto, fecha: r.fecha, creado_en: r.creado_en, id: r.id,
    })),
    ...platanoAjustes.filter(r => enRango(r.fecha)).map(r => ({
      tipo: r.kilos ? `Ajuste (${r.concepto || "kilos"})` : "Ajuste canastas", origen: "ajuste",
      detalle: (r.ubicacion === "MADURO" ? `Lote ${r.lote}` : "Verde") + (r.nota ? ` · ${r.nota}` : ""),
      bruto: null, canastas: r.canastas, neto: r.kilos, fecha: r.fecha, creado_en: r.creado_en, id: r.id,
    })),
  ].sort(ordenarPlatanoPorFecha).slice(0, 300);
  document.getElementById("tablaPlatanoOtrosHist").innerHTML = items.map(it => {
    const conSigno = (fmtFn, valor) => (Number(valor) > 0 ? "+" : "") + fmtFn(valor);
    const canastasTexto = it.origen === "ajuste"
      ? (Number(it.canastas) ? conSigno(fmtCanastasPlatano, it.canastas) : "-")
      : fmtCanastasPlatano(it.canastas);
    const netoTexto = it.origen === "ajuste"
      ? (it.neto ? conSigno(fmtKgPlatano, it.neto) : "-")
      : (it.neto === null ? "-" : fmtKgPlatano(it.neto));
    return `
      <tr>
        <td>${it.fecha}</td>
        <td>${it.tipo}</td>
        <td>${escapeHtml(it.detalle)}</td>
        <td>${it.bruto === null ? "-" : fmtKgPlatano(it.bruto)}</td>
        <td>${canastasTexto}</td>
        <td>${netoTexto}</td>
        ${filaAccionesPlatano(it.origen, it.id)}
      </tr>
    `;
  }).join("") || `<tr class="empty-row"><td colspan="7">Sin maduración ni ajustes en ese rango.</td></tr>`;
  wirePlatanoAccionesEnTabla("tablaPlatanoOtrosHist");
}

function renderPlatanoHistorial() {
  const filtroFecha = document.getElementById("filtroFechaPlatano").value || todayISO();
  document.getElementById("filtroFechaPlatano").value = filtroFecha;
  renderPlatanoComparativo();

  const desdeInput = document.getElementById("platMovDesde");
  const hastaInput = document.getElementById("platMovHasta");
  if (!desdeInput.value) desdeInput.value = todayISO();
  if (!hastaInput.value) hastaInput.value = todayISO();
  const desde = desdeInput.value;
  const hasta = hastaInput.value;
  const enRango = (fecha) => fecha >= desde && fecha <= hasta;
  const textoFiltro = normalizarNombreSugerido(document.getElementById("platMovTexto").value);

  renderPlatanoEntradasHist(enRango, textoFiltro);
  renderPlatanoSalidasHist(enRango, textoFiltro);
  renderPlatanoOtrosHist(enRango);
}
document.getElementById("filtroFechaPlatano").addEventListener("change", renderPlatanoHistorial);
["platMovDesde", "platMovHasta"].forEach(id => document.getElementById(id).addEventListener("change", renderPlatanoHistorial));
document.getElementById("platMovTexto").addEventListener("input", renderPlatanoHistorial);
document.getElementById("btnFiltrarPlatanoMov").addEventListener("click", renderPlatanoHistorial);

function buscarPlatanoRegistro(origen, id) {
  const arr = {
    entrada: platanoEntradas, maduracion: platanoMaduraciones,
    salida: platanoSalidas, ajuste: platanoAjustes,
  }[origen];
  return arr.find(r => String(r.id) === String(id));
}

async function eliminarPlatanoMovimiento(origen, id, justificacion, registro) {
  if (esSoloLecturaPlatano()) throw new Error("Estás en modo solo lectura, no puedes eliminar movimientos.");
  const tabla = {
    entrada: "platano_entradas", maduracion: "platano_maduracion",
    salida: "platano_salidas", ajuste: "platano_ajustes_canastas",
  }[origen];
  const { error: errAud } = await sb.from("platano_auditoria").insert({
    tabla, movimiento_id: id, accion: "eliminar", justificacion,
    detalle: JSON.stringify(registro || {}), fecha_movimiento: registro ? registro.fecha : null,
  });
  throwIfError(errAud);
  const { error } = await sb.from(tabla).delete().eq("id", id);
  throwIfError(error);
}

function abrirEliminarPlatanoConMotivo(origen, id) {
  const registro = buscarPlatanoRegistro(origen, id);
  abrirModal("Eliminar movimiento de plátano", `
    <div class="modal-body-grid">
      <div class="alerta-box">Esta acción no se puede deshacer.</div>
      <label>Motivo de la eliminación (obligatorio)
        <textarea id="emDelMotivo" rows="2" placeholder="Ej: Se registró por error, duplicado"></textarea>
      </label>
    </div>
  `, {
    textoConfirmar: "Eliminar",
    onConfirm: async () => {
      const motivo = document.getElementById("emDelMotivo").value.trim();
      if (!motivo) { toast("Escribe el motivo de la eliminación", true); return; }
      try {
        await eliminarPlatanoMovimiento(origen, id, motivo, registro);
        cerrarModal();
        toast("Movimiento eliminado");
        await cargarPlatano();
        renderPlatano();
      } catch (err) {
        toast(err.message || "No se pudo eliminar", true);
      }
    },
  });
}

async function editarPlatanoMovimiento(origen, id, cambios, justificacion, registroAnterior) {
  if (esSoloLecturaPlatano()) throw new Error("Estás en modo solo lectura, no puedes editar movimientos.");
  const tabla = {
    entrada: "platano_entradas", maduracion: "platano_maduracion",
    salida: "platano_salidas", ajuste: "platano_ajustes_canastas",
  }[origen];
  const { error } = await sb.from(tabla).update(cambios).eq("id", id);
  throwIfError(error);
  const { error: errAud } = await sb.from("platano_auditoria").insert({
    tabla, movimiento_id: id, accion: "editar", justificacion,
    detalle: `Antes: ${JSON.stringify(registroAnterior)} · Después: ${JSON.stringify(cambios)}`,
    fecha_movimiento: cambios.fecha || registroAnterior.fecha,
  });
  throwIfError(errAud);
}

function abrirEditarPlatanoMovimiento(origen, id) {
  if (esSoloLecturaPlatano()) { toast("Estás en modo solo lectura, no puedes editar movimientos.", true); return; }
  const r = buscarPlatanoRegistro(origen, id);
  if (!r) { toast("No se encontró el movimiento", true); return; }

  const motivoHtml = `
    <label>Motivo de la edición (obligatorio)
      <textarea id="emMotivo" rows="2" placeholder="Ej: El peso bruto estaba mal digitado"></textarea>
    </label>`;

  if (origen === "entrada") {
    abrirModal("Editar entrada de verde", `
      <div class="modal-body-grid">
        <label>Fecha
          <input type="date" id="emFecha" value="${r.fecha}">
        </label>
        <label>De quién entra
          <input type="text" id="emProveedor" value="${escapeHtml(r.proveedor || "")}">
        </label>
        <label>Peso bruto (kg)
          <input type="number" id="emBruto" min="0" step="0.01" value="${r.peso_bruto}">
        </label>
        <label>Canastas
          <input type="number" id="emCanastas" min="0" step="1" value="${r.canastas}">
        </label>
        <label class="campo-checkbox">
          <input type="checkbox" id="emEsPrestamo" ${r.es_prestamo ? "checked" : ""}>
          Es préstamo (el proveedor me presta este plátano)
        </label>
        ${motivoHtml}
      </div>
    `, { onConfirm: () => {
      const fecha = document.getElementById("emFecha").value;
      const proveedor = document.getElementById("emProveedor").value.trim();
      const bruto = Number(document.getElementById("emBruto").value) || 0;
      const canastas = Number(document.getElementById("emCanastas").value) || 0;
      const esPrestamo = document.getElementById("emEsPrestamo").checked;
      const motivo = document.getElementById("emMotivo").value.trim();
      if (!fecha) { toast("Selecciona la fecha", true); return; }
      if (!proveedor) { toast("Indica de quién entra la mercancía", true); return; }
      if (bruto <= 0) { toast("Ingresa el peso bruto", true); return; }
      if (canastas <= 0) { toast("Ingresa las canastas", true); return; }
      if (!motivo) { toast("Escribe el motivo de la edición", true); return; }
      guardarEdicionPlatano(origen, id, {
        fecha, proveedor, peso_bruto: bruto, canastas, peso_neto: pesoNetoPlatano(bruto, canastas), es_prestamo: esPrestamo,
      }, motivo, r);
    } });
    return;
  }

  if (origen === "maduracion") {
    abrirModal("Editar paso a maduración", `
      <div class="modal-body-grid">
        <label>Fecha
          <input type="date" id="emFecha" value="${r.fecha}">
        </label>
        <label>Lote
          <input type="number" id="emLote" min="1" step="1" value="${r.lote}">
        </label>
        <label>Peso bruto (kg)
          <input type="number" id="emBruto" min="0" step="0.01" value="${r.peso_bruto}">
        </label>
        <label>Canastas
          <input type="number" id="emCanastas" min="0" step="1" value="${r.canastas}">
        </label>
        ${motivoHtml}
      </div>
    `, { onConfirm: () => {
      const fecha = document.getElementById("emFecha").value;
      const lote = Number(document.getElementById("emLote").value) || 0;
      const bruto = Number(document.getElementById("emBruto").value) || 0;
      const canastas = Number(document.getElementById("emCanastas").value) || 0;
      const motivo = document.getElementById("emMotivo").value.trim();
      if (!fecha) { toast("Selecciona la fecha", true); return; }
      if (lote <= 0) { toast("Indica el lote", true); return; }
      if (bruto <= 0) { toast("Ingresa el peso bruto", true); return; }
      if (canastas <= 0) { toast("Ingresa las canastas", true); return; }
      if (!motivo) { toast("Escribe el motivo de la edición", true); return; }
      guardarEdicionPlatano(origen, id, {
        fecha, lote, peso_bruto: bruto, canastas, peso_neto: pesoNetoPlatano(bruto, canastas),
      }, motivo, r);
    } });
    return;
  }

  if (origen === "salida") {
    abrirModal("Editar salida", `
      <div class="modal-body-grid">
        <label>Fecha
          <input type="date" id="emFecha" value="${r.fecha}">
        </label>
        <label>Producto
          <select id="emProducto">
            <option value="VERDE">Verde</option>
            <option value="MADURO">Maduro</option>
          </select>
        </label>
        <label id="emLoteWrap">Lote
          <input type="number" id="emLote" min="1" step="1" value="${r.lote || ""}">
        </label>
        <label>A quién se despachó / a qué proveedor le pagas
          <input type="text" id="emDestino" value="${escapeHtml(r.destino || "")}">
        </label>
        <label>Peso bruto (kg)
          <input type="number" id="emBruto" min="0" step="0.01" value="${r.peso_bruto}">
        </label>
        <label>Canastas
          <input type="number" id="emCanastas" min="0" step="1" value="${r.canastas}">
        </label>
        <label class="campo-checkbox">
          <input type="checkbox" id="emEsPago" ${r.es_pago_prestamo ? "checked" : ""}>
          Préstamo
        </label>
        ${motivoHtml}
      </div>
    `, { onConfirm: () => {
      const fecha = document.getElementById("emFecha").value;
      const producto = document.getElementById("emProducto").value;
      const lote = producto === "MADURO" ? (Number(document.getElementById("emLote").value) || 0) : null;
      const destino = document.getElementById("emDestino").value.trim();
      const bruto = Number(document.getElementById("emBruto").value) || 0;
      const canastas = Number(document.getElementById("emCanastas").value) || 0;
      const esPago = document.getElementById("emEsPago").checked;
      const motivo = document.getElementById("emMotivo").value.trim();
      if (!fecha) { toast("Selecciona la fecha", true); return; }
      if (!destino) { toast("Indica a quién se despachó", true); return; }
      if (bruto <= 0) { toast("Ingresa el peso bruto", true); return; }
      if (canastas <= 0) { toast("Ingresa las canastas", true); return; }
      if (producto === "MADURO" && !lote) { toast("Indica el lote", true); return; }
      if (!motivo) { toast("Escribe el motivo de la edición", true); return; }
      guardarEdicionPlatano(origen, id, {
        fecha, producto, lote, destino, peso_bruto: bruto, canastas, peso_neto: pesoNetoPlatano(bruto, canastas), es_pago_prestamo: esPago,
      }, motivo, r);
    } });
    document.getElementById("emProducto").value = r.producto;
    const actualizarLoteWrap = () => { document.getElementById("emLoteWrap").hidden = document.getElementById("emProducto").value !== "MADURO"; };
    document.getElementById("emProducto").addEventListener("change", actualizarLoteWrap);
    actualizarLoteWrap();
    return;
  }

  if (origen === "ajuste") {
    abrirModal("Editar ajuste de canastas y kilos", `
      <div class="modal-body-grid">
        <label>Fecha
          <input type="date" id="emFecha" value="${r.fecha}">
        </label>
        <label>Ubicación
          <select id="emUbicacion">
            <option value="VERDE">Verde</option>
            <option value="MADURO">Maduro (por lote)</option>
          </select>
        </label>
        <label id="emLoteWrap">Lote
          <input type="number" id="emLote" min="1" step="1" value="${r.lote || ""}">
        </label>
        <label>Canastas a ajustar
          <input type="number" id="emCanastas" step="1" value="${r.canastas}">
        </label>
        <label>Kilos a ajustar
          <input type="number" id="emKilos" step="0.01" value="${r.kilos}">
        </label>
        <label>Concepto (para los kilos)
          <input type="text" id="emConcepto" value="${escapeHtml(r.concepto || "")}">
        </label>
        <label>Nota (opcional)
          <input type="text" id="emNota" value="${escapeHtml(r.nota || "")}">
        </label>
        ${motivoHtml}
      </div>
    `, { onConfirm: () => {
      const fecha = document.getElementById("emFecha").value;
      const ubicacion = document.getElementById("emUbicacion").value;
      const lote = ubicacion === "MADURO" ? (Number(document.getElementById("emLote").value) || 0) : null;
      const canastas = Number(document.getElementById("emCanastas").value) || 0;
      const kilos = Number(document.getElementById("emKilos").value) || 0;
      const concepto = document.getElementById("emConcepto").value.trim();
      const nota = document.getElementById("emNota").value.trim();
      const motivo = document.getElementById("emMotivo").value.trim();
      if (!fecha) { toast("Selecciona la fecha", true); return; }
      if (!canastas && !kilos) { toast("Ingresa canastas y/o kilos a ajustar", true); return; }
      if (kilos && !concepto) { toast("Indica el concepto de los kilos", true); return; }
      if (ubicacion === "MADURO" && !lote) { toast("Indica el lote", true); return; }
      if (!motivo) { toast("Escribe el motivo de la edición", true); return; }
      guardarEdicionPlatano(origen, id, {
        fecha, ubicacion, lote, canastas, kilos, concepto: kilos ? concepto : null, nota: nota || null,
      }, motivo, r);
    } });
    document.getElementById("emUbicacion").value = r.ubicacion;
    const actualizarLoteWrap = () => { document.getElementById("emLoteWrap").hidden = document.getElementById("emUbicacion").value !== "MADURO"; };
    document.getElementById("emUbicacion").addEventListener("change", actualizarLoteWrap);
    actualizarLoteWrap();
    return;
  }
}

async function guardarEdicionPlatano(origen, id, cambios, motivo, registroAnterior) {
  try {
    await editarPlatanoMovimiento(origen, id, cambios, motivo, registroAnterior);
    cerrarModal();
    toast("Movimiento editado");
    await cargarPlatano();
    renderPlatano();
  } catch (err) {
    toast(err.message || "No se pudo editar", true);
  }
}

function renderPlatano() {
  renderPlatanoResumen();
  renderPlatanoLotesTabla();
  renderPlatanoFormularios();
  renderPlatanoHistorial();
  renderPlatanoDeuda();
}

// Deuda de prestamos de platano: lo prestado por cada proveedor menos lo ya
// devuelto (todo el historico, no se reinicia). Saldo positivo = yo debo,
// saldo negativo = me deben (si se pago de mas).
function platanoDeudaPorProveedor() {
  const mapa = new Map();
  const sumar = (nombreCrudo, campo, valor) => {
    const nombre = (nombreCrudo || "Sin proveedor").trim();
    const key = normalizarNombreSugerido(nombre);
    const prev = mapa.get(key) || { nombre, prestado: 0, pagado: 0 };
    prev[campo] += valor;
    mapa.set(key, prev);
  };
  platanoEntradas.filter(r => r.es_prestamo).forEach(r => sumar(r.proveedor, "prestado", Number(r.peso_neto)));
  platanoSalidas.filter(r => r.es_pago_prestamo).forEach(r => sumar(r.destino, "pagado", Number(r.peso_neto)));
  return Array.from(mapa.values()).map(v => ({ ...v, saldo: v.prestado - v.pagado }));
}

function renderPlatanoDeuda() {
  const filas = platanoDeudaPorProveedor().sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo));
  document.getElementById("tablaPlatanoDeuda").innerHTML = filas.map(f => {
    const saldoTxt = Math.abs(f.saldo) < 0.05
      ? `<span>Saldado</span>`
      : f.saldo > 0
        ? `<span class="texto-debo">Debes ${fmtKgPlatano(f.saldo)}</span>`
        : `<span class="texto-me-deben">Te deben ${fmtKgPlatano(-f.saldo)}</span>`;
    return `
      <tr>
        <td>${escapeHtml(f.nombre)}</td>
        <td>${fmtKgPlatano(f.prestado)}</td>
        <td>${fmtKgPlatano(f.pagado)}</td>
        <td>${saldoTxt}</td>
      </tr>
    `;
  }).join("") || `<tr class="empty-row"><td colspan="4">No hay préstamos de plátano registrados.</td></tr>`;
}

async function guardarAjusteCanastas() {
  if (esSoloLecturaPlatano()) { toast("Estás en modo solo lectura, no puedes registrar ajustes.", true); return; }
  const ubicacion = document.getElementById("ajUbicacion").value;
  const lote = ubicacion === "MADURO" ? Number(document.getElementById("ajLote").value) : null;
  const canastas = Number(document.getElementById("ajCanastas").value) || 0;
  const kilos = Number(document.getElementById("ajKilos").value) || 0;
  const concepto = document.getElementById("ajConcepto").value.trim();
  const nota = document.getElementById("ajNota").value.trim();
  if (!canastas && !kilos) { toast("Ingresa canastas y/o kilos a ajustar (puede ser negativo)", true); return; }
  if (kilos && !concepto) { toast("Indica el concepto de los kilos (ej. Deshidrate)", true); return; }
  if (ubicacion === "MADURO" && !lote) { toast("Selecciona un lote", true); return; }
  try {
    const { error } = await sb.from("platano_ajustes_canastas").insert({
      fecha: fechaTrabajo(), ubicacion, lote, canastas, kilos,
      concepto: kilos ? concepto : null, nota: nota || null,
    });
    throwIfError(error);
    document.getElementById("ajCanastas").value = "0";
    document.getElementById("ajKilos").value = "0";
    document.getElementById("ajNota").value = "";
    toast("Ajuste registrado");
    await cargarPlatano();
    renderPlatano();
  } catch (err) {
    toast(err.message || "No se pudo registrar el ajuste", true);
  }
}
document.getElementById("btnGuardarAjusteCanastas").addEventListener("click", guardarAjusteCanastas);

async function guardarPlatanoEntrada(forzar) {
  if (esSoloLecturaPlatano()) { toast("Estás en modo solo lectura, no puedes registrar entradas.", true); return; }
  const proveedor = document.getElementById("peProveedor").value.trim();
  const brutoInput = document.getElementById("peBruto").value;
  const canastasInput = document.getElementById("peCanastas").value;
  const bruto = Number(brutoInput) || 0;
  const canastas = Number(canastasInput) || 0;
  if (!proveedor) { toast("Indica de quién entra la mercancía", true); return; }
  if (!brutoInput || bruto <= 0) { toast("Ingresa el peso bruto", true); return; }
  if (!canastasInput || canastas <= 0) { toast("Ingresa las canastas", true); return; }
  const inusual = platanoRatioInusual(bruto, canastas);
  if (inusual && !forzar) {
    abrirModal("Este dato se ve inusual", `
      <div class="alerta-box">
        Este ingreso da <strong>${inusual.ratio.toFixed(1)} kg por canasta</strong>, y lo usual según el histórico es cerca de <strong>${inusual.media.toFixed(1)} kg por canasta</strong> (${inusual.desviacionPct > 0 ? "+" : ""}${inusual.desviacionPct.toFixed(0)}%).<br>
        Revisa que el peso bruto y las canastas estén bien digitados.<br>¿Guardar de todas formas?
      </div>
    `, { textoConfirmar: "Sí, guardar igual", onConfirm: () => { cerrarModal(); guardarPlatanoEntrada(true); } });
    return;
  }
  const neto = pesoNetoPlatano(bruto, canastas);
  const esPrestamo = document.getElementById("peEsPrestamo").checked;
  try {
    const { error } = await sb.from("platano_entradas").insert({
      fecha: fechaTrabajo(), proveedor, peso_bruto: bruto, canastas, peso_neto: neto, es_prestamo: esPrestamo,
    });
    throwIfError(error);
    document.getElementById("peProveedor").value = "";
    document.getElementById("peBruto").value = "";
    document.getElementById("peCanastas").value = "";
    document.getElementById("peEsPrestamo").checked = false;
    toast(esPrestamo ? "Entrada registrada como préstamo" : "Entrada de verde registrada");
    await cargarPlatano();
    renderPlatano();
  } catch (err) {
    toast(err.message || "No se pudo registrar la entrada", true);
  }
}
document.getElementById("btnGuardarPlatanoEntrada").addEventListener("click", () => guardarPlatanoEntrada(false));

async function guardarPlatanoMaduracion(forzarRatio, forzarDisponible) {
  if (esSoloLecturaPlatano()) { toast("Estás en modo solo lectura, no puedes registrar maduración.", true); return; }
  const selectorLote = document.getElementById("pmLote");
  if (!selectorLote.value) { toast("Selecciona un lote", true); return; }
  const lote = selectorLote.value === "nuevo" ? platanoProximoLote() : Number(selectorLote.value);
  const brutoInput = document.getElementById("pmBruto").value;
  const canastasInput = document.getElementById("pmCanastas").value;
  const bruto = Number(brutoInput) || 0;
  const canastas = Number(canastasInput) || 0;
  if (!brutoInput || bruto <= 0) { toast("Ingresa el peso bruto", true); return; }
  if (!canastasInput || canastas <= 0) { toast("Ingresa las canastas", true); return; }
  const inusual = platanoRatioInusual(bruto, canastas);
  if (inusual && !forzarRatio) {
    abrirModal("Este dato se ve inusual", `
      <div class="alerta-box">
        Este ingreso da <strong>${inusual.ratio.toFixed(1)} kg por canasta</strong>, y lo usual según el histórico es cerca de <strong>${inusual.media.toFixed(1)} kg por canasta</strong> (${inusual.desviacionPct > 0 ? "+" : ""}${inusual.desviacionPct.toFixed(0)}%).<br>
        Revisa que el peso bruto y las canastas estén bien digitados.<br>¿Guardar de todas formas?
      </div>
    `, { textoConfirmar: "Sí, guardar igual", onConfirm: () => { cerrarModal(); guardarPlatanoMaduracion(true, forzarDisponible); } });
    return;
  }
  const neto = pesoNetoPlatano(bruto, canastas);
  const verde = platanoVerdeDisponible();
  if (neto > verde.kg && !forzarDisponible) {
    abrirModal("Vas a pasar más verde del disponible", `
      <div class="alerta-box">
        Verde disponible: <strong>${fmtKgPlatano(verde.kg)}</strong> ·
        Vas a pasar a maduración: <strong>${fmtKgPlatano(neto)}</strong><br>
        ¿Continuar de todas formas? El verde quedará en negativo.
      </div>
    `, { textoConfirmar: "Sí, continuar", onConfirm: () => { cerrarModal(); guardarPlatanoMaduracion(forzarRatio, true); } });
    return;
  }
  try {
    const { error } = await sb.from("platano_maduracion").insert({
      fecha: fechaTrabajo(), lote, peso_bruto: bruto, canastas, peso_neto: neto,
    });
    throwIfError(error);
    selectorLote.value = "";
    document.getElementById("pmBruto").value = "";
    document.getElementById("pmCanastas").value = "";
    toast(`Pasado a maduración en el lote ${lote}`);
    await cargarPlatano();
    renderPlatano();
  } catch (err) {
    toast(err.message || "No se pudo registrar la maduración", true);
  }
}
document.getElementById("btnGuardarPlatanoMaduracion").addEventListener("click", () => guardarPlatanoMaduracion(false, false));

async function guardarPlatanoSalida(forzarRatio, forzarDisponible) {
  if (esSoloLecturaPlatano()) { toast("Estás en modo solo lectura, no puedes registrar salidas.", true); return; }
  const producto = document.getElementById("psProducto").value;
  const destino = document.getElementById("psDestino").value.trim();
  const esPago = document.getElementById("psEsPago").checked;
  const lote = producto === "MADURO" ? Number(document.getElementById("psLote").value) : null;
  const brutoInput = document.getElementById("psBruto").value;
  const canastasInput = document.getElementById("psCanastas").value;
  const bruto = Number(brutoInput) || 0;
  const canastas = Number(canastasInput) || 0;
  if (!producto) { toast("Selecciona si es verde o maduro", true); return; }
  if (!destino) { toast(esPago ? "Indica el proveedor del préstamo" : "Indica a quién se despachó", true); return; }
  if (!brutoInput || bruto <= 0) { toast("Ingresa el peso bruto", true); return; }
  if (!canastasInput || canastas <= 0) { toast("Ingresa las canastas", true); return; }
  if (producto === "MADURO" && !lote) { toast("Selecciona un lote", true); return; }
  const inusual = platanoRatioInusual(bruto, canastas);
  if (inusual && !forzarRatio) {
    abrirModal("Este dato se ve inusual", `
      <div class="alerta-box">
        Este ingreso da <strong>${inusual.ratio.toFixed(1)} kg por canasta</strong>, y lo usual según el histórico es cerca de <strong>${inusual.media.toFixed(1)} kg por canasta</strong> (${inusual.desviacionPct > 0 ? "+" : ""}${inusual.desviacionPct.toFixed(0)}%).<br>
        Revisa que el peso bruto y las canastas estén bien digitados.<br>¿Guardar de todas formas?
      </div>
    `, { textoConfirmar: "Sí, guardar igual", onConfirm: () => { cerrarModal(); guardarPlatanoSalida(true, forzarDisponible); } });
    return;
  }
  const neto = pesoNetoPlatano(bruto, canastas);

  const disponible = producto === "VERDE"
    ? platanoVerdeDisponible().kg
    : (platanoTodosLosLotes().find(l => l.lote === lote) || { kg: 0 }).kg;

  if (neto > disponible && !forzarDisponible) {
    abrirModal("Estás despachando de más", `
      <div class="alerta-box">
        Disponible: <strong>${fmtKgPlatano(disponible)}</strong> ·
        Vas a despachar: <strong>${fmtKgPlatano(neto)}</strong><br>
        ¿Continuar de todas formas? Quedará registrado con saldo negativo.
      </div>
    `, { textoConfirmar: "Sí, despachar igual", onConfirm: () => { cerrarModal(); guardarPlatanoSalida(forzarRatio, true); } });
    return;
  }
  try {
    const { error } = await sb.from("platano_salidas").insert({
      fecha: fechaTrabajo(), destino, producto, lote, peso_bruto: bruto, canastas, peso_neto: neto, es_pago_prestamo: esPago,
    });
    throwIfError(error);
    document.getElementById("psProducto").value = "";
    document.getElementById("psDestino").value = "";
    document.getElementById("psBruto").value = "";
    document.getElementById("psCanastas").value = "";
    document.getElementById("psEsPago").checked = false;
    actualizarModoPagoPrestamo();
    toast(esPago ? "Salida de préstamo registrada" : "Salida registrada");
    await cargarPlatano();
    renderPlatano();
  } catch (err) {
    toast(err.message || "No se pudo registrar la salida", true);
  }
}
document.getElementById("btnGuardarPlatanoSalida").addEventListener("click", () => guardarPlatanoSalida(false, false));

/* ==========================================================================
   PEDIDO (pedido del dia de Bello y Colores + estado de despacho)
   Despacho (clave de edicion) marca cada producto; los demas solo ven el estado.
   ========================================================================== */

const PEDIDO_ESTADOS = {
  pendiente: "Pendiente",
  despachado: "Despachado",
  falta: "Falta",
  no_hay: "No hay",
};
const PEDIDO_SIMBOLOS = { despachado: "✓", falta: "!", no_hay: "✕" };
let pedidoFilas = [];
let pedidoError = "";
let pedidoFiltroEstado = "";
let pedidoEscribiendo = 0;

function pedidoCampo(destino, tipo) {
  return `${tipo}_${destino}`;
}

// Si el nombre que viene de la hoja esta vacio o es solo un numero, se usa el del catalogo.
function pedidoNombreReal(nombre, codigo) {
  const n = String(nombre || "").trim();
  if ((!n || /^\d+([.,]\d+)?$/.test(n)) && codigo) {
    const p = productos.find(x => String(x.codigo).trim() === String(codigo).trim());
    if (p) return p.nombre;
  }
  return n || String(codigo || "");
}
function pedidoNombre(f) {
  return pedidoNombreReal(f.nombre, f.codigo);
}

async function cargarPedido() {
  const { data, error } = await sb.from("pedido_dia").select("*").eq("fecha", fechaTrabajo()).order("orden", { ascending: true });
  if (error) {
    pedidoError = error.message || "Error";
    pedidoFilas = [];
    return;
  }
  pedidoError = "";
  pedidoFilas = data || [];
}

// Guarda el pedido pegado (codigo, producto, unidad, Bello, Colores) tal cual, incluidas
// las filas sin codigo (ofertas/mallas). Si se vuelve a pegar, se actualizan cantidades y
// orden pero se conservan las marcas ya hechas.
async function importarPedidoDia(texto, fecha) {
  if (!puedeMarcarPedido()) throw new Error("Solo la clave de edición puede importar el pedido.");
  const parseNum = (v) => {
    const n = Number(String(v ?? "").replace(/,/g, "").trim());
    return isNaN(n) ? 0 : n;
  };
  const porClave = new Map();
  texto.split(/\r?\n/).map(l => l.split("\t")).forEach((cols, idx) => {
    const codigo = String(cols[0] ?? "").trim();
    const nombre = String(cols[1] ?? "").trim();
    if (!codigo && !nombre) return;
    const clave = codigo ? "C:" + codigo : "N:" + normalizarNombreSugerido(nombre);
    const bello = parseNum(cols[3]);
    const colores = parseNum(cols[4]);
    const previo = porClave.get(clave);
    if (previo) {
      previo.bello += bello;
      previo.colores += colores;
      return;
    }
    porClave.set(clave, {
      fecha, clave, orden: idx, codigo: codigo || null, nombre: pedidoNombreReal(nombre, codigo),
      unidad: String(cols[2] ?? "").trim() || null, bello, colores,
    });
  });

  const { data: existentes, error: errExistentes } = await sb.from("pedido_dia").select("clave,orden").eq("fecha", fecha);
  throwIfError(errExistentes);
  const clavesExistentes = new Set((existentes || []).map(r => r.clave));
  const ahora = new Date().toISOString();
  // Filas sin pedido solo se guardan si ya existian (para poder ponerlas en 0).
  const aGuardar = Array.from(porClave.values())
    .filter(r => r.bello > 0 || r.colores > 0 || clavesExistentes.has(r.clave));
  // Si lo pegado no comparte ningun producto con lo que ya hay (por ejemplo, solo las
  // ofertas pegadas aparte), va al final en vez de mezclarse con los primeros.
  const solapa = aGuardar.some(r => clavesExistentes.has(r.clave));
  const desplazamiento = clavesExistentes.size && !solapa
    ? Math.max(...(existentes || []).map(r => Number(r.orden) || 0)) + 1
    : 0;
  aGuardar.forEach(r => { r.orden += desplazamiento; r.actualizado_en = ahora; });
  if (!aGuardar.length) return 0;
  const { error } = await sb.from("pedido_dia").upsert(aGuardar, { onConflict: "fecha,clave" });
  throwIfError(error);
  return aGuardar.filter(r => r.bello > 0 || r.colores > 0).length;
}

// Si ya se importo el sugerido del dia (antes de existir esta seccion) pero el pedido
// esta vacio, lo arma desde ese sugerido para no tener que pegarlo otra vez. Solo trae
// productos con codigo; un nuevo "Importar sugerido" lo completa (ofertas y orden de la hoja).
async function sembrarPedidoDesdeSugerido() {
  const porClave = new Map();
  estado.filter(it => it.tieneSugerido && (it.sugeridoBello > 0 || it.sugeridoColores > 0)).forEach((it, idx) => {
    const codigo = String(it.codigo || "").trim();
    if (!codigo) return;
    const clave = "C:" + codigo;
    const previo = porClave.get(clave);
    if (previo) {
      previo.bello += it.sugeridoBello;
      previo.colores += it.sugeridoColores;
      return;
    }
    porClave.set(clave, {
      fecha: fechaTrabajo(), clave, orden: idx, codigo, nombre: it.nombre,
      unidad: it.unidad ? String(it.unidad).toLowerCase() : null,
      bello: it.sugeridoBello, colores: it.sugeridoColores, actualizado_en: new Date().toISOString(),
    });
  });
  if (!porClave.size) return false;
  const { error } = await sb.from("pedido_dia").upsert(Array.from(porClave.values()), { onConflict: "fecha,clave" });
  return !error;
}

async function marcarPedido(id, destino, estado, nota) {
  if (!puedeMarcarPedido()) { toast("Solo despacho puede marcar el pedido.", true); return; }
  const campoEstado = pedidoCampo(destino, "estado");
  const campoNota = pedidoCampo(destino, "nota");
  const fila = pedidoFilas.find(f => f.id === id);
  const anterior = fila ? { estado: fila[campoEstado], nota: fila[campoNota] } : null;
  if (fila) {
    fila[campoEstado] = estado;
    fila[campoNota] = nota || null;
    renderPedido();
  }
  pedidoEscribiendo++;
  try {
    const { error } = await sb.from("pedido_dia").update({
      [campoEstado]: estado, [campoNota]: nota || null, actualizado_en: new Date().toISOString(),
    }).eq("id", id);
    throwIfError(error);
  } catch (err) {
    if (fila && anterior) {
      fila[campoEstado] = anterior.estado;
      fila[campoNota] = anterior.nota;
      renderPedido();
    }
    toast(err.message || "No se pudo guardar la marca", true);
  } finally {
    pedidoEscribiendo--;
  }
}

function abrirNotaPedido(fila, destino, estado) {
  const nombreDestino = destino === "bello" ? "Bello" : "Colores";
  const esFalta = estado === "falta";
  abrirModal(`${esFalta ? "Falta" : "No hay"} · ${pedidoNombre(fila)} (${nombreDestino})`, `
    <div class="modal-body-grid">
      <label>${esFalta ? "¿Cuánto falta o qué pasó? (opcional)" : "¿Por qué no se pudo? (opcional)"}
        <input type="text" id="pedNota" placeholder="${esFalta ? "Ej: faltan 5" : "Ej: no se consigue"}">
      </label>
    </div>
  `, {
    textoConfirmar: "Guardar",
    onConfirm: () => {
      const nota = document.getElementById("pedNota").value.trim();
      cerrarModal();
      marcarPedido(fila.id, destino, estado, nota);
    },
  });
  const input = document.getElementById("pedNota");
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") document.getElementById("modalConfirmar").click(); });
  input.focus();
}

function pedidoConteos(destino) {
  const c = { total: 0, pendiente: 0, despachado: 0, falta: 0, no_hay: 0 };
  pedidoFilas.forEach(f => {
    if (!(Number(f[destino]) > 0)) return;
    c.total++;
    c[f[pedidoCampo(destino, "estado")]]++;
  });
  return c;
}

function pedidoCardHtml(titulo, c) {
  const pct = (n) => (c.total ? (n / c.total) * 100 : 0);
  return `
    <div class="ped-card">
      <div class="ped-card-titulo">${titulo}<span>${c.despachado} de ${c.total} despachados</span></div>
      <div class="ped-barra">
        <i class="b-despachado" style="width:${pct(c.despachado)}%"></i>
        <i class="b-falta" style="width:${pct(c.falta)}%"></i>
        <i class="b-no_hay" style="width:${pct(c.no_hay)}%"></i>
      </div>
      <div class="ped-card-detalle">${c.pendiente} pendientes · ${c.falta} con falta · ${c.no_hay} sin existencia</div>
    </div>
  `;
}

function pedidoCeldaHtml(fila, destino) {
  const cantidad = Number(fila[destino]);
  if (!(cantidad > 0)) return `<td class="ped-celda"><span class="ped-vacio">—</span></td>`;
  const estado = fila[pedidoCampo(destino, "estado")];
  const nota = fila[pedidoCampo(destino, "nota")];
  const cantidadTxt = cantidad.toLocaleString("es-CO", { maximumFractionDigits: 2 });
  // Con permiso de marcar, el estado se ve en los botones y el color de la celda;
  // sin permiso, se muestra la etiqueta del estado.
  const control = puedeMarcarPedido()
    ? `<span class="ped-botones">${["despachado", "falta", "no_hay"].map(e =>
        `<button type="button" class="ped-btn${estado === e ? " activo" : ""}" data-id="${fila.id}" data-destino="${destino}" data-estado="${e}" title="${PEDIDO_ESTADOS[e]}" aria-label="${PEDIDO_ESTADOS[e]}">${PEDIDO_SIMBOLOS[e]}</button>`).join("")}</span>`
    : `<span class="ped-estado ped-estado-${estado}">${PEDIDO_ESTADOS[estado]}</span>`;
  return `<td class="ped-celda ped-${estado}"><div class="ped-linea"><span class="ped-cant">${cantidadTxt}${fila.unidad ? ` <small>${escapeHtml(fila.unidad)}</small>` : ""}</span>${control}${nota ? `<span class="ped-nota">${escapeHtml(nota)}</span>` : ""}</div></td>`;
}

function renderPedido() {
  const tbody = document.getElementById("tablaPedido");
  document.getElementById("pedidoHint").textContent = `Pedido del ${fechaExcel(fechaTrabajo())}`;
  if (pedidoError) {
    document.getElementById("pedidoResumen").innerHTML = "";
    document.getElementById("pedidoChips").innerHTML = "";
    tbody.innerHTML = `<tr class="empty-row"><td colspan="3">Esta sección todavía no está activada (falta crear la tabla en Supabase).</td></tr>`;
    return;
  }
  const conPedido = pedidoFilas.filter(f => Number(f.bello) > 0 || Number(f.colores) > 0);
  document.getElementById("pedidoResumen").innerHTML =
    pedidoCardHtml("Bello", pedidoConteos("bello")) + pedidoCardHtml("Colores", pedidoConteos("colores"));

  const filaTieneEstado = (f, estado) =>
    (Number(f.bello) > 0 && f.estado_bello === estado) || (Number(f.colores) > 0 && f.estado_colores === estado);
  const chips = [["", "Todos"], ["pendiente", "Pendientes"], ["despachado", "Despachados"], ["falta", "Con falta"], ["no_hay", "No hay"]];
  document.getElementById("pedidoChips").innerHTML = chips.map(([clave, texto]) => {
    const n = clave ? conPedido.filter(f => filaTieneEstado(f, clave)).length : conPedido.length;
    return `<button type="button" class="chip${pedidoFiltroEstado === clave ? " active" : ""}" data-estado="${clave}">${texto} (${n})</button>`;
  }).join("");

  const texto = normalizarNombreSugerido(document.getElementById("pedidoBuscar").value);
  const visibles = conPedido
    .filter(f => !pedidoFiltroEstado || filaTieneEstado(f, pedidoFiltroEstado))
    .filter(f => !texto || normalizarNombreSugerido(pedidoNombre(f)).includes(texto) || String(f.codigo || "").includes(texto))
    .sort((a, b) => pedidoNombre(a).localeCompare(pedidoNombre(b), "es", { sensitivity: "base", numeric: true }));

  document.getElementById("pedidoLeyenda").hidden = !puedeMarcarPedido();
  tbody.innerHTML = visibles.length
    ? visibles.map(f => `<tr><td class="ped-prod"><strong>${escapeHtml(pedidoNombre(f))}</strong>${f.codigo ? `<span class="ped-cod">${escapeHtml(f.codigo)}</span>` : ""}</td>${pedidoCeldaHtml(f, "bello")}${pedidoCeldaHtml(f, "colores")}</tr>`).join("")
    : `<tr class="empty-row"><td colspan="3">${conPedido.length
        ? "Ningún producto coincide con el filtro."
        : "No hay pedido cargado para esta fecha." + (puedeMarcarPedido() ? " Pégalo en Despacho → Importar sugerido." : " Pídele a despacho que lo cargue.")}</td></tr>`;
}

document.getElementById("pedidoChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  pedidoFiltroEstado = chip.dataset.estado;
  renderPedido();
});
document.getElementById("pedidoBuscar").addEventListener("input", renderPedido);
document.getElementById("tablaPedido").addEventListener("click", (e) => {
  const btn = e.target.closest(".ped-btn");
  if (!btn) return;
  const { id, destino, estado } = btn.dataset;
  const fila = pedidoFilas.find(f => f.id === id);
  if (!fila) return;
  if (fila[pedidoCampo(destino, "estado")] === estado) { marcarPedido(id, destino, "pendiente", ""); return; }
  if (estado === "despachado") { marcarPedido(id, destino, estado, ""); return; }
  abrirNotaPedido(fila, destino, estado);
});

// Los demas companeros ven los cambios sin recargar: se refresca solo cada 20 s
// mientras la pestana esta abierta.
setInterval(async () => {
  if (!rolActual() || document.hidden || pedidoEscribiendo > 0) return;
  if (!document.getElementById("tab-pedido").classList.contains("active")) return;
  if (!document.getElementById("modalOverlay").hidden) return;
  await cargarPedido();
  renderPedido();
}, 20000);

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
  return `Bello: ${fmt(m.bello, unidad)} · Colores: ${fmt(m.colores, unidad)} · Expres: ${fmt(m.puntosExpres, unidad)} · Total: <strong>${fmt(m.totalDespachado, unidad)}</strong> · Queda: ${fmt(m.queda, unidad)}`;
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
    if (tipoMov === "inventario") { await quitarInventario(id); return; }
    if (!confirm("¿Eliminar este movimiento? Solo se puede si es el último registrado para ese producto.")) return;
    try {
      await eliminarDespachoCloud(id);
      toast("Movimiento eliminado");
      await refrescarTodo();
    } catch (err) {
      toast(err.message || "No se pudo eliminar", true);
    }
  }));
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

async function renderCorrecciones() {
  const { data, error } = await sb.from("correcciones").select("*").order("creado_en", { ascending: false }).limit(200);
  if (error) { toast(error.message, true); return; }
  const items = (data || []).map(mapCorreccion);
  const tbody = document.getElementById("tablaCorrecciones");
  const ACCION_LABEL = { editar: "Editado", sumar: "Sumado", eliminar: "Eliminado" };
  tbody.innerHTML = items.map(c => {
    const p = productosPorId[c.productoId];
    const unidad = p ? p.unidad : "";
    return `
      <tr>
        <td>${c.fecha}</td>
        <td>${p ? escapeHtml(p.codigo + " · " + p.nombre) : "(eliminado)"}</td>
        <td>${ACCION_LABEL[c.tipo] || c.tipo}</td>
        <td>${fmt(c.valorAnterior, unidad)}</td>
        <td>${c.valorNuevo === null || c.valorNuevo === undefined ? "-" : fmt(c.valorNuevo, unidad)}</td>
        <td>${escapeHtml(c.motivo || "-")}</td>
        <td>${escapeHtml(c.nota || "-")}</td>
      </tr>
    `;
  }).join("") || `<tr class="empty-row"><td colspan="7">Sin correcciones registradas.</td></tr>`;
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
  if (esSoloLectura()) { toast("Estás en modo solo lectura, no puedes guardar productos.", true); return; }
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
  if (esSoloLectura()) { toast("Estás en modo solo lectura, no puedes eliminar productos.", true); return; }
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
    const [prods, stock, invs, desps, difs, corrs] = await Promise.all([
      sb.from("productos").select("*"),
      sb.from("stock").select("*"),
      sb.from("inventarios").select("*"),
      sb.from("despachos").select("*"),
      sb.from("diferencias").select("*"),
      sb.from("correcciones").select("*"),
    ]);
    const payload = {
      productos: prods.data, stock: stock.data, inventarios: invs.data,
      despachos: desps.data, diferencias: difs.data, correcciones: corrs.data,
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
document.getElementById("filtroDesde").value = "";
refrescarTodo();
