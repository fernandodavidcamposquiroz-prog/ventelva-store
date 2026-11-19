const PRODUCT = 'Ventilador de cuello Ventelva';
const UNIT = 3990;
const MP = 'https://api.mercadopago.com/v1/orders';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ORDER = /^ORD[A-Z0-9]{1,64}$/i;
const money = cents => (cents / 100).toFixed(2);
function toCents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const decimal = String(value);
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(decimal);
  if (!parts || parts[0] !== decimal) return null;
  const cents = Number(parts[1]) * 100 + Number((parts[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}
class Problem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireThat(ok, status, message) { if (!ok) throw new Problem(status, message); }

export function endpoint(handler) {
  return async ({request, env}) => {
    let status = 200, result;
    try {
      requireThat(request.method === 'POST', 405, 'Usa POST.');
      requireThat(request.headers.get('content-type')?.includes('application/json'), 415, 'Se requiere JSON.');
      requireThat(env.DB, 503, 'El entorno de prueba todavía no está configurado.');
      result = await handler(request, env);
    } catch (error) {
      status = error instanceof Problem ? error.status : 503;
      result = {error: error instanceof Problem ? error.message : 'Servicio temporalmente no disponible. Reintenta.'};
    }
    return Response.json(result, {status, headers:{'Cache-Control':'no-store'}});
  };
}
async function body(request) {
  requireThat(Number(request.headers.get('content-length')) <= 8192, 413, 'Solicitud demasiado extensa.');
  const reader = request.body?.getReader();
  requireThat(reader, 400, 'Faltan los datos.');
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 8192) { await reader.cancel(); throw new Problem(413, 'Solicitud demasiado extensa.'); }
    text += decoder.decode(value,{stream:true});
  }
  try {
    const data = JSON.parse(text + decoder.decode());
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  throw new Problem(400,'Datos inválidos.');
}
function field(obj, key, min, max) {
  const value = typeof obj?.[key] === 'string' ? obj[key].trim() : '';
  requireThat(value.length >= min && value.length <= max && !/[\u0000-\u001f]/.test(value), 400, 'Revisa el campo ' + key + '.');
  return value;
}
function destination(obj) {
  return Object.fromEntries(['departamento','provincia','distrito'].map(k=>[k,field(obj,k,1,80)]));
}
function customer(obj) {
  const data = {...destination(obj), nombre:field(obj,'nombre',2,120), correo:field(obj,'correo',3,254),
    telefono:field(obj,'telefono',7,20), direccion:field(obj,'direccion',3,180), referencia:field(obj,'referencia',0,180)};
  requireThat(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.correo),400,'Revisa el correo electrónico.');
  requireThat(/^[0-9]{7,15}$/.test(obj.telefono),400,'Ingresa un teléfono de 7 a 15 dígitos.');
  return data;
}
async function quote(db, dest) {
  const norm = s=>s.normalize('NFC').toLocaleLowerCase('es-PE');
  const rate = await db.prepare('SELECT cents FROM shipping_rates WHERE department=? AND province=? AND district=?')
    .bind(norm(dest.departamento),norm(dest.provincia),norm(dest.distrito)).first();
  return {unit: UNIT, shipping: rate?.cents ?? null, total: rate ? UNIT + rate.cents : null};
}
function ready(env) {
  requireThat(env.CHECKOUT_MODE==='test' && env.MP_ACCESS_TOKEN?.trim() && env.MP_ACCESS_TOKEN!=='TEST-ejemplo' &&
    env.MP_WEBHOOK_SECRET?.trim() && env.MP_WEBHOOK_SECRET!=='ejemplo',503,'El checkout de prueba aún no está habilitado.');
}
async function provider(env, path, options = {}) {
  const res = await fetch(MP + path, {...options, redirect:'error', signal:AbortSignal.timeout(10000),
    headers:{Authorization:'Bearer ' + env.MP_ACCESS_TOKEN, 'Content-Type':'application/json', ...options.headers}});
  if (options.method==='POST' && res.status===409) {
    throw new Problem(409,'La clave de esta orden ya fue utilizada.');
  }
  if (!res.ok) {
    const detail = await res.json().catch(()=>null);
    const causes = [detail?.errors, detail?.cause].filter(Array.isArray).flat();
    const codes = [detail?.error, detail?.code, detail?.message, ...causes.map(e=>e?.code)];
    if (codes.includes('invalid_credentials')) {
      throw new Problem(502,'Mercado Pago rechazó las credenciales de prueba (invalid_credentials). Revisa la configuración de Preview.');
    }
    if (res.status===401 || res.status===403) throw new Problem(502,'Mercado Pago denegó el acceso. Revisa las credenciales y permisos de Preview.');
    throw new Problem(502,'Mercado Pago no confirmó la operación. Reintenta el mismo pedido.');
  }
  return res.json();
}
function matches(order, row) {
  return order.live_mode!==true && ORDER.test(order.id) && order.currency==='PEN' && order.country_code==='PER' &&
    order.external_reference===row.id && toCents(order.total_amount)===row.total;
}
export async function handleOrders(request, env) {
  const origin = new URL(request.url).origin;
  requireThat(request.headers.get('origin')===origin,403,'Origen inválido.');
  const data = await body(request);
  const db = env.DB;
  if (data.action==='quote') return quote(db,destination(data.destination));
  requireThat(UUID.test(data.attempt),400,'Identificador inválido.');
  const lookup = () => db.prepare('SELECT * FROM orders WHERE attempt=?').bind(data.attempt).first();
  if (data.action==='status') {
    const row = await lookup();
    requireThat(row,404,'Pedido no encontrado.');
    return {state:row.state};
  }
  requireThat(data.action==='create',400,'Operación inválida.');
  ready(env);
  requireThat(env.PUBLIC_ORIGIN===origin && origin.startsWith('https://'),503,'Falta configurar el origen HTTPS de prueba.');
  const buyer = customer(data.customer);
  const serialized = JSON.stringify(buyer);
  let row = await lookup();
  if (!row) {
    const prices = await quote(db,buyer);
    requireThat(prices.total!==null,409,'El envío aún no tiene tarifa confirmada.');
    requireThat(prices.total===data.acceptedTotal,409,'El total cambió. Vuelve a revisar el envío.');
    await db.prepare('INSERT INTO orders(id,attempt,customer,total) VALUES(?,?,?,?) ON CONFLICT(attempt) DO NOTHING')
      .bind(crypto.randomUUID(),data.attempt,serialized,prices.total).run();
    row = await lookup();
  }
  requireThat(row.customer===serialized && row.total===data.acceptedTotal,409,'Este intento corresponde a otros datos.');
  requireThat(['creating','pending'].includes(row.state),409,'Este pedido ya tiene un resultado. Consulta su estado.');
  if (row.checkout_url) return {checkout_url:row.checkout_url};
  const items = [{title:PRODUCT,quantity:1,unit_price:money(UNIT)}];
  if (row.total>UNIT) items.push({title:'Envío',quantity:1,unit_price:money(row.total-UNIT)});
  const online = Object.fromEntries(['success','pending','failure'].map(state => {
    const url = new URL('/', origin);
    url.search = new URLSearchParams({retorno:state, pedido:row.attempt}).toString();
    return [state+'_url', url.href];
  }));
  const payload = {
    type:'online',processing_mode:'manual',external_reference:row.id,total_amount:money(row.total),
    payer:{email:buyer.correo},items,config:{online}
  };
  let order;
  try {
    order = await provider(env,'',{method:'POST',headers:{'X-Idempotency-Key':row.id},body:JSON.stringify(payload)});
  } catch (error) {
    if (error.status!==409) throw error;
    // La respuesta del primer POST puede perderse después de crear la orden.
    const begin = (row.created_at - 60) * 1000;
    const query = new URLSearchParams({external_reference:row.id,begin_date:new Date(begin).toISOString(),
      end_date:new Date(Math.min(Date.now(),begin+30*86400000)).toISOString()});
    const found = await provider(env,'?'+query);
    const hits = found.data?.filter(item=>item.external_reference===row.id && ORDER.test(item.id));
    requireThat(hits?.length===1,502,'La orden sigue en conciliación. Reintenta el mismo pedido.');
    order = await provider(env,'/'+hits[0].id);
    requireThat(order.status==='created',409,'La orden ya fue procesada. Revisa su estado.');
  }
  requireThat(matches(order,row),502,'La orden recibida no coincide con el pedido de prueba.');
  const url = new URL(order.checkout_url);
  requireThat(['https://www.mercadopago.com.pe','https://sandbox.mercadopago.com.pe'].includes(url.origin) && !url.username && !url.password,502,'Destino de checkout inválido.');
  await db.prepare("UPDATE orders SET mp_id=?,checkout_url=?,state=CASE WHEN state='creating' THEN 'pending' ELSE state END WHERE id=? AND (mp_id IS NULL OR mp_id=?)")
    .bind(order.id,url.href,row.id,order.id).run();
  return {checkout_url:url.href};
}

export async function handleWebhook(request,env) {
  ready(env);
  const id = new URL(request.url).searchParams.get('data.id') || '';
  const rid = request.headers.get('x-request-id');
  const signature = Object.fromEntries((request.headers.get('x-signature')||'').split(',').map(s=>s.trim().split('=')));
  requireThat(ORDER.test(id) && rid && /^\d{10,13}$/.test(signature.ts) && /^[0-9a-f]{64}$/i.test(signature.v1),401,'Firma inválida.');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw',enc.encode(env.MP_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const digest = Uint8Array.from(signature.v1.match(/../g),s=>parseInt(s,16));
  const manifest = 'id:'+id.toLowerCase()+';request-id:'+rid+';ts:'+signature.ts+';';
  requireThat(await crypto.subtle.verify('HMAC',key,digest,enc.encode(manifest)),401,'Firma inválida.');
  const event = await body(request);
  requireThat(event.type==='order' && event.live_mode===false && event.data?.id?.toLowerCase()===id.toLowerCase(),400,'Evento de prueba inválido.');
  const order = await provider(env,'/'+id.toUpperCase());
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(order.external_reference).first();
  if (!row) return {received:true};
  requireThat(matches(order,row) && order.id===id.toUpperCase() && (!row.mp_id || row.mp_id===order.id),409,'Orden inconsistente.');
  const updated = Date.parse(order.last_updated_date);
  requireThat(Number.isFinite(updated),502,'Orden sin fecha de actualización.');
  const states = {processed:'review',failed:'rejected',cancelled:'cancelled',canceled:'cancelled',expired:'expired',refunded:'refunded',charged_back:'review',created:'pending',action_required:'pending',processing:'pending'};
  let state = states[order.status] || 'review';
  if (order.status==='processed' && order.status_detail==='accredited' && toCents(order.total_paid_amount)===row.total) state='approved';
  await env.DB.prepare('UPDATE orders SET mp_id=?,state=?,provider_updated=? WHERE id=? AND provider_updated<? AND (mp_id IS NULL OR mp_id=?)')
    .bind(order.id,state,updated,row.id,updated,order.id).run();
  return {received:true};
}
