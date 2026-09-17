import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {RpcPool} from './rpc-pool.mjs';

test('RPC validates response envelopes without network access',async t=>{
  let response;
  t.mock.method(https,'request',(url,options,callback)=>{
    const req=new EventEmitter();
    req.end=body=>queueMicrotask(()=>{
      const res=new EventEmitter();
      res.statusCode=200;res.setEncoding=()=>{};
      callback(res);
      res.emit('data',JSON.stringify(response(JSON.parse(body))));
      res.emit('end');
    });
    return req;
  });
  const pool=new RpcPool();
  try{
    for(const value of [null,[],42,'bad']){
      response=()=>value;
      await assert.rejects(pool.call('https://example.invalid','eth_chainId'),/Invalid RPC response/);
    }
    response=q=>({jsonrpc:'2.0',id:q.id+1,result:'0x1237'});
    await assert.rejects(pool.call('https://example.invalid','eth_chainId'),/ID mismatch/);
    response=q=>({jsonrpc:'1.0',id:q.id,result:'0x1237'});
    await assert.rejects(pool.call('https://example.invalid','eth_chainId'),/version/);
    response=q=>({jsonrpc:'2.0',id:q.id,result:null,error:{code:-32000}});
    await assert.rejects(pool.call('https://example.invalid','eth_chainId'),/Ambiguous/);
    response=q=>({jsonrpc:'2.0',id:q.id,error:{code:-32000,data:'0xab'}});
    await assert.rejects(pool.call('https://example.invalid','eth_chainId'),e=>e.code===-32000&&e.data==='0xab');
    response=q=>({jsonrpc:'2.0',id:q.id,result:null});
    assert.equal(await pool.call('https://example.invalid','eth_getTransactionReceipt',['0x00']),null);
    response=q=>({jsonrpc:'2.0',id:q.id,result:'0x1237'});
    assert.equal(await pool.call('https://example.invalid','eth_chainId'),'0x1237');
  }finally{pool.close();}
});
test('broadcast probe accepts invalid-payload codes but rejects unavailable methods',async t=>{
  const pool=new RpcPool();
  let code;
  t.mock.method(pool,'call',async()=>{throw Object.assign(Error('RPC error'),{code});});
  try{
    for(code of [-32000,-32602,-32600])assert.ok(await pool.probe('https://example.invalid')>=0);
    for(code of [-32601,-32603,429,undefined])await assert.rejects(pool.probe('https://example.invalid'),/unavailable/);
  }finally{pool.close();}
});

test('broadcast payload is encoded before trigger without opening a connection',async t=>{
  let requests=0,sent;
  t.mock.method(https,'request',(url,options,callback)=>{
    requests++;
    const req=new EventEmitter();
    req.end=body=>{
      sent=JSON.parse(body);
      queueMicrotask(()=>{
        const res=new EventEmitter();res.statusCode=200;res.setEncoding=()=>{};
        callback(res);res.emit('data',JSON.stringify({jsonrpc:'2.0',id:sent.id,result:'0x'+'ab'.repeat(32)}));res.emit('end');
      });
    };
    return req;
  });
  const pool=new RpcPool({allowBroadcast:true});
  try{
    const params=['signed-original'];
    const send=pool.prepareCall('https://example.invalid','eth_sendRawTransaction',params);
    params[0]='changed-after-preparation';
    assert.equal(requests,0);
    await send();
    assert.equal(requests,1);assert.deepEqual(sent.params,['signed-original']);
  }finally{pool.close();}
});

test('server broadcast errors expose controlled classifications only',async t=>{
  let message='already known secret-value';
  t.mock.method(https,'request',(url,options,callback)=>{
    const req=new EventEmitter();
    req.end=body=>queueMicrotask(()=>{
      const res=new EventEmitter();res.statusCode=200;res.setEncoding=()=>{};callback(res);
      res.emit('data',JSON.stringify({jsonrpc:'2.0',id:JSON.parse(body).id,error:{code:-32000,message}}));res.emit('end');
    });
    return req;
  });
  const pool=new RpcPool({allowBroadcast:true});
  try{
    await assert.rejects(pool.call('https://example.invalid','eth_sendRawTransaction',['signed']),
      e=>e.broadcastStatus==='already_known'&&!e.message.includes('secret-value'));
    message='nonce too low secret-value';
    await assert.rejects(pool.call('https://example.invalid','eth_sendRawTransaction',['signed']),
      e=>e.broadcastStatus==='nonce_too_low'&&!e.message.includes('secret-value'));
  }finally{pool.close();}
});
