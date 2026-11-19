import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { onRequest as orders } from '../functions/api/orders.js';
import { onRequest as webhook } from '../functions/api/webhooks/mercadopago.js';

const origin = 'https://preview.example.invalid';
function setup(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_checkout.sql',import.meta.url),'utf8'));
  const DB = {prepare(query) {
    const stmt = sql.prepare(query);
    return {bind:(...args)=>({first:async()=>stmt.get(...args),run:async()=>stmt.run(...args)})};
  }};
  const env = {DB,PUBLIC_ORIGIN:origin,CHECKOUT_MODE:'test',MP_ACCESS_TOKEN:'TEST-simulado',MP_WEBHOOK_SECRET:'secreto-de-test'};
  const customer = {nombre:'Cliente ficticio',correo:'test@example.invalid',telefono:'999000000',departamento:'Departamento demo',provincia:'Provincia demo',distrito:'Distrito demo',direccion:'Calle de prueba 1',referencia:''};
  const create = {action:'create',customer,attempt:crypto.randomUUID(),acceptedTotal:3990};
  let notifyId = 'ORD1234';
  let remote, returnUrls, submissions = 0;
  const fake = t.mock.method(globalThis,'fetch',async(url,options)=>{
    if (options.method==='POST') {
      submissions++;
      const payload = JSON.parse(options.body);
      assert.equal(url,'https://api.mercadopago.com/v1/orders');
      assert.equal(options.headers['X-Idempotency-Key'],payload.external_reference);
      assert.equal(payload.total_amount,'39.90');
      assert.deepEqual(payload.items,[{title:'Ventilador de cuello Ventelva',quantity:1,unit_price:'39.90'}]);
      assert.deepEqual(Object.keys(payload.config.online).sort(),['failure_url','pending_url','success_url']);
      returnUrls = payload.config.online;
      notifyId = 'ORD' + submissions;
      remote = {id:notifyId,external_reference:payload.external_reference,country_code:'PER',currency:'PEN',total_amount:payload.total_amount,checkout_url:'https://www.mercadopago.com.pe/checkout/v1/redirect?order_id='+notifyId,status:'created',last_updated_date:'2026-01-01T00:00:00Z'};
    } else assert.equal(url,'https://api.mercadopago.com/v1/orders/'+notifyId);
    return Response.json(remote);
  });
  const post = (handler,path,data,headers={})=>handler({env,request:new Request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(data)})});
  const order = data=>post(orders,'/api/orders',data);
  function notify(bad=false) {
    const ts = String(Math.floor(Date.now()/1000)), rid='req-1';
    const mac=createHmac('sha256',env.MP_WEBHOOK_SECRET).update('id:'+notifyId.toLowerCase()+';request-id:'+rid+';ts:'+ts+';').digest('hex');
    return post(webhook,'/api/webhooks/mercadopago?data.id='+notifyId,{type:'order',live_mode:false,data:{id:notifyId}}, {'x-signature':'ts='+ts+',v1='+(bad?'0'.repeat(64):mac),'x-request-id':rid});
  }
  function seed(cents = 500, dest = customer) {
    sql.prepare('INSERT INTO shipping_rates VALUES(?,?,?,?)').run(
      dest.departamento.toLowerCase(), dest.provincia.toLowerCase(), dest.distrito.toLowerCase(), cents);
  }
  t.after(()=>sql.close());
  return {sql,env,order,create,customer,seed,notify,fake,remote:()=>remote,urls:()=>returnUrls,count:()=>submissions};
}

test('Cada retorno identifica su propio pedido aunque se inicie otro intento', async t => {
  const s = setup(t);
  s.seed();
  assert.equal((await s.order(s.create)).status, 200);
  const first = s.urls();
  Object.assign(s.remote(), {status:'processed',status_detail:'accredited',total_paid_amount:'39.90'});
  assert.equal((await s.notify()).status, 200);
  const secondAttempt = crypto.randomUUID();
  assert.equal((await s.order({...s.create, attempt:secondAttempt})).status, 200);
  const second = s.urls();
  for (const outcome of ['success', 'pending', 'failure']) {
    for (const [urls, expected] of [[first, 'approved'], [second, 'pending']]) {
      const params = new URL(urls[outcome + '_url']).searchParams;
      assert.equal(params.get('retorno'), outcome);
      const response = await s.order({action:'status',attempt:params.get('pedido')});
      assert.deepEqual(await response.json(), {state:expected});
    }
  }
});

for (const [amount, valid] of [['39.9',true], ['39.90',true], [39.9,true],
  ['39.89',false], ['39.901',false], ['39,90',false], ['39.90\n',false], [null,false]]) {
  test('Valida el importe en la creación y el webhook: ' + JSON.stringify(amount), async t => {
    const s = setup(t);
    s.seed(0);
    s.fake.mock.mockImplementationOnce(async (_url, options) => {
      const {external_reference} = JSON.parse(options.body);
      return Response.json({id:'ORD1234',external_reference,country_code:'PER',currency:'PEN',
        total_amount:amount,checkout_url:'https://www.mercadopago.com.pe/checkout/'});
    });
    assert.equal((await s.order(s.create)).status, valid ? 200 : 502);

    const attempt = crypto.randomUUID();
    assert.equal((await s.order({...s.create, attempt})).status, 200);
    Object.assign(s.remote(), {status:'processed',status_detail:'accredited',total_amount:amount,total_paid_amount:'39.90'});
    assert.equal((await s.notify()).status, valid ? 200 : 409);
    Object.assign(s.remote(), {total_amount:'39.90',total_paid_amount:amount,last_updated_date:'2026-01-02T00:00:00Z'});
    assert.equal((await s.notify()).status, valid ? 200 : 409);
    const response = await s.order({action:'status',attempt});
    assert.deepEqual(await response.json(), {state:valid ? 'approved' : 'pending'});
  });
}
test('Sin tarifa o sin modo de prueba se bloquea el pedido',async t=>{
  const s=setup(t);
  assert.equal((await (await s.order({action:'quote',destination:s.customer})).json()).total,null);
  assert.equal((await s.order(s.create)).status,409);
  s.seed();
  assert.equal((await s.order({...s.create,acceptedTotal:1})).status,409);
  assert.equal((await s.order({...s.create,acceptedTotal:4490})).status,409);
  assert.equal((await s.order({...s.create,customer:{...s.customer,correo:'inválido'}})).status,400);
  for (const mode of [undefined,'disabled','production']) {
    s.env.CHECKOUT_MODE=mode;
    assert.equal((await s.order(s.create)).status,503);
  }
  assert.equal(s.count(),0);
});
test('Cotización, checkout, reintento y dirección modificada',async t=>{
  const s=setup(t); s.seed();
  s.env.MP_ACCESS_TOKEN='APP_USR-ficticio';
  assert.deepEqual(await (await s.order({action:'quote',destination:s.customer})).json(),{total:3990});
  const first=await (await s.order(s.create)).json();
  assert.equal(first.checkout_url,s.remote().checkout_url);
  assert.deepEqual(await (await s.order(s.create)).json(),first);
  assert.equal((await s.order({...s.create,customer:{...s.customer,direccion:'Otra calle'}})).status,409);
  assert.equal(s.count(),1);
});
test('Lima y provincia mantienen el mismo precio con costos logísticos distintos', async t => {
  const s = setup(t);
  const lima = {...s.customer,departamento:'Lima',provincia:'Lima',distrito:'Miraflores'};
  const provincia = {...s.customer,departamento:'Arequipa',provincia:'Arequipa',distrito:'Cayma'};
  // Tarifas simuladas en SQLite en memoria para probar la independencia del precio.
  s.seed(500,lima);
  s.seed(1800,provincia);
  for (const customer of [lima,provincia]) {
    const quote = await s.order({action:'quote',destination:customer});
    assert.deepEqual(await quote.json(),{total:3990});
    assert.equal((await s.order({...s.create,customer,attempt:crypto.randomUUID()})).status,200);
  }
  assert.deepEqual(s.sql.prepare('SELECT DISTINCT total FROM orders').all().map(row=>row.total),[3990]);
  assert.equal(s.count(),2);
});
test('El rechazo de credenciales devuelve solo un diagnóstico fijo',async t=>{
  const s=setup(t); s.seed();
  s.fake.mock.mockImplementationOnce(async()=>Response.json({errors:[{code:'invalid_credentials',message:'detalle privado'}]},{status:401}));
  const res=await s.order(s.create);
  assert.equal(res.status,502);
  assert.deepEqual(await res.json(),{error:'Mercado Pago rechazó las credenciales de prueba (invalid_credentials). Revisa la configuración de Preview.'});
  assert.equal(s.fake.mock.callCount(),1);
});
for (const [status,detail,paid,expected] of [
  ['processed','accredited','39.90','approved'],['failed','bad_filled_card_number','0.00','rejected'],
  ['processing','pending','0.00','pending']
]) {
  test('Webhook verificado: '+status+' / '+paid,async t=>{
    const s=setup(t);s.seed();await s.order(s.create);
    Object.assign(s.remote(),{status,status_detail:detail,total_paid_amount:paid});
    assert.equal((await s.notify(true)).status,401);
    assert.equal((await s.notify()).status,200);
    assert.equal((await s.notify()).status,200);
    assert.equal((await (await s.order({action:'status',attempt:s.create.attempt})).json()).state,expected);
    Object.assign(s.remote(),{last_updated_date:'2025-01-01T00:00:00Z',status:'created'});
    await s.notify();
    assert.equal(s.sql.prepare('SELECT state FROM orders').get().state,expected);
  });
}
test('Falla de conexión y reintento con la misma clave',async t=>{
  const s=setup(t);s.seed();
  s.fake.mock.mockImplementationOnce(async()=>{throw new Error('conexión interrumpida')});
  assert.equal((await s.order(s.create)).status,503);
  const id=s.sql.prepare('SELECT id FROM orders').get().id;
  assert.equal((await s.order(s.create)).status,200);
  assert.equal(s.remote().external_reference,id);
  assert.equal(s.sql.prepare('SELECT count(*) AS n FROM orders').get().n,1);
});

test('Recupera la orden existente si el proveedor ya consumió la clave',async t=>{
  const s=setup(t);s.seed();
  const expected=await (await s.order(s.create)).json();
  // Simula la pérdida de la respuesta entre la creación remota y el UPDATE local.
  s.sql.exec("UPDATE orders SET mp_id=NULL, checkout_url=NULL, state='creating'");
  s.fake.mock.mockImplementationOnce(async()=>new Response(null,{status:409}));
  s.fake.mock.mockImplementationOnce(async url=>{
    assert.equal(new URL(url).searchParams.get('external_reference'),s.remote().external_reference);
    return Response.json({data:[s.remote()]});
  },s.fake.mock.callCount()+1);
  assert.deepEqual(await (await s.order(s.create)).json(),expected);
  assert.equal(s.count(),1);
});
