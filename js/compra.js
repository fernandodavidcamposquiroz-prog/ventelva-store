const dialogo = document.querySelector('#compra');
const formulario = document.querySelector('#form-compra');
const continuar = document.querySelector('#continuar-compra');
const aviso = document.querySelector('#aviso-compra');
const resultado = document.querySelector('#resultado-compra');
const moneda = cents => 'S/ ' + (cents / 100).toFixed(2);
const retorno = new URLSearchParams(location.search);
let total = null;
let revision = 0;
let ocupado = false;

const { telefono, departamento, provincia, distrito } = formulario.elements;
telefono.addEventListener('input', () => {
  const original = telefono.value;
  if (/\D/.test(original)) {
    const cursor = original.slice(0, telefono.selectionStart).replace(/\D/g, '').length;
    telefono.value = original.replace(/\D/g, '');
    telefono.setSelectionRange(cursor, cursor);
  }
});

function opciones(control, nombres) {
  const opcionesNuevas = [...nombres].sort((a,b) => a.localeCompare(b, 'es-PE'))
    .map(nombre => new Option(nombre, nombre));
  control.replaceChildren(control.options[0], ...opcionesNuevas);
  control.value = '';
  control.disabled = nombres.length === 0;
}
opciones(departamento, Object.keys(ubigeoPeru));
departamento.addEventListener('change', () => {
  opciones(provincia, Object.keys(ubigeoPeru[departamento.value] || {}));
  opciones(distrito, []);
  revisarTotal();
});
provincia.addEventListener('change', () => {
  opciones(distrito, ubigeoPeru[departamento.value]?.[provincia.value] || []);
  revisarTotal();
});

function revisarTotal() {
  revision++;
  total = null;
  document.querySelector('#importe-envio').textContent = 'Por cotizar';
  document.querySelector('#importe-total').textContent = 'Pendiente de envío';
  continuar.textContent = 'Consultar envío y total';
  aviso.textContent = '';
}
async function api(datos) {
  const res = await fetch('/api/orders', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(datos),signal:AbortSignal.timeout(15000)});
  if (!res.headers.get('content-type')?.includes('application/json')) throw new Error('El servicio de pedidos de prueba aún no está disponible.');
  const respuesta = await res.json();
  if (!res.ok) throw Object.assign(new Error(respuesta.error || 'Servicio no disponible.'), {status:res.status});
  return respuesta;
}
function mensaje(error) {
  return ['TypeError','TimeoutError','AbortError'].includes(error.name) ? 'No se pudo conectar. Reintenta el mismo pedido.' : error.message;
}
async function intentoPara(cliente, importe) {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([cliente,importe])));
  const huella = Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  const previo = JSON.parse(sessionStorage.getItem('ventelva-intento') || 'null');
  if (previo?.huella===huella) return previo.id;
  const id = crypto.randomUUID();
  sessionStorage.setItem('ventelva-intento',JSON.stringify({huella,id}));
  return id;
}
document.querySelectorAll('[data-comprar]').forEach(boton=>boton.addEventListener('click',()=>{
  formulario.hidden = false;
  resultado.hidden = true;
  dialogo.showModal();
}));
document.querySelector('#cerrar-compra').addEventListener('click',()=>dialogo.close());
formulario.addEventListener('input', revisarTotal);
formulario.addEventListener('submit',async evento=>{
  evento.preventDefault();
  if (ocupado || !formulario.reportValidity()) return;
  const cliente = Object.fromEntries(new FormData(formulario));
  const version = revision;
  ocupado = true;
  continuar.disabled = true;
  try {
    if (total===null) {
      aviso.textContent = 'Consultando envío…';
      const {departamento,provincia,distrito} = cliente;
      const cotizacion = await api({action:'quote',destination:{departamento,provincia,distrito}});
      if (version!==revision) return;
      if (!Number.isSafeInteger(cotizacion.total)) {
        aviso.textContent = 'Aún no hay una tarifa confirmada para esta dirección. El pago queda pendiente.';
        return;
      }
      total = cotizacion.total;
      document.querySelector('#importe-unidad').textContent = moneda(cotizacion.unit);
      document.querySelector('#importe-envio').textContent = moneda(cotizacion.shipping);
      document.querySelector('#importe-total').textContent = moneda(total);
      continuar.textContent = 'Continuar a Mercado Pago';
      aviso.textContent = 'Revisa el total antes de continuar al checkout de prueba.';
    } else {
      formulario.querySelector('fieldset').disabled = true;
      aviso.textContent = 'Preparando el checkout de prueba…';
      const attempt = await intentoPara(cliente,total);
      const order = await api({action:'create',customer:cliente,attempt,acceptedTotal:total});
      location.assign(order.checkout_url);
    }
  } catch(error) {
    if (error.status===409) revisarTotal();
    aviso.textContent = mensaje(error);
  } finally {
    formulario.querySelector('fieldset').disabled = false;
    continuar.disabled = false;
    ocupado = false;
  }
});
async function consultarEstado() {
  const salida = resultado.querySelector('p');
  try {
    const attempt = retorno.get('pedido');
    if (!attempt) { salida.textContent = 'Este enlace de retorno no identifica un pedido. Usa el enlace del checkout correspondiente.'; return; }
    const {state} = await api({action:'status',attempt});
    const mensajes = {approved:'Pago de prueba confirmado.',rejected:'El pago de prueba fue rechazado.',cancelled:'Pedido cancelado.',expired:'El pedido venció.',refunded:'Pago de prueba reembolsado.',review:'El pedido está en revisión.'};
    salida.textContent = mensajes[state] || 'Esperando confirmación de Mercado Pago. Puedes actualizar el estado.';
    if (['rejected','cancelled','expired','refunded'].includes(state)) {
      const previo = JSON.parse(sessionStorage.getItem('ventelva-intento') || 'null');
      if (previo?.id===attempt) sessionStorage.setItem('ventelva-intento',JSON.stringify({...previo,huella:null}));
    }
  } catch(error) { salida.textContent = mensaje(error); }
}
document.querySelector('#consultar-estado').addEventListener('click',consultarEstado);
if (retorno.has('retorno')) {
  formulario.hidden = true;
  resultado.hidden = false;
  dialogo.showModal();
  consultarEstado();
}
