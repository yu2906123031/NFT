import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const root=new URL('./',import.meta.url);
const ethersURL=new URL('./node_modules/ethers/lib.esm/index.js',root).href;
// Isolated temporary project, ephemeral wallets, mocked HTTPS/fetch. No real network.
const fixture=String.raw`
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {Wallet,Transaction,ZeroAddress} from __ETHERS__;
import {CHAIN,NFT,SEA,abi} from './core.mjs';
const mode=process.argv[2];
const wallets=[Wallet.createRandom(),Wallet.createRandom()];
const realNow=Date.now.bind(Date),realTimeout=setTimeout;
const epoch=realNow();
Date.now=()=>epoch+(realNow()-epoch)*30;
globalThis.setTimeout=(fn,ms,...args)=>realTimeout(fn,Math.max(1,ms/30),...args);
globalThis.fetch=async()=>({ok:false,status:404});
const start=Math.floor((Date.now()+90000)/1000);
const blockHash='0x'+'ab'.repeat(32),fee='0x'+'12'.repeat(20);
const receipts=new Map(),events=[];
const cfg={readRpc:'https://read-a.invalid',readRpcs:['https://read-a.invalid','https://read-b.invalid'],
  broadcastRpcs:['https://send-a.invalid','https://send-b.invalid'],
  expectedStartTime:1,autoStartTime:true,trigger:'chain',pollMs:100,prepareSeconds:60,
  rpcTimeoutMs:500,sendTimeoutMs:400,receiptTimeoutSeconds:10,chainWaitTimeoutSeconds:10,
  gasPriceMultiplier:2,gasLimit:420000,maxGasBudgetEth:'0.001',totalGasBudgetEth:'0.006',
  wallets:wallets.map((w,i)=>({label:'wallet'+i,keyEnv:i?'MINT_PRIVATE_KEY_2':'MINT_PRIVATE_KEY',mode:'chain',address:w.address}))};
await writeFile('config.json',JSON.stringify(cfg));
await writeFile('multi-config.json',JSON.stringify({}));
await writeFile('.env',wallets.map((w,i)=>(i?'MINT_PRIVATE_KEY_2':'MINT_PRIVATE_KEY')+'='+w.privateKey).join('\n'));
function block(number='0x20'){return {number,timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),hash:blockHash};}
function answer(q){
  const {method,params}=q;
  if(method==='eth_chainId')return '0x'+CHAIN.toString(16);
  if(method==='eth_getBlockByNumber')return block(params[0]==='latest'?'0x20':params[0]);
  if(method==='eth_gasPrice')return '0x1';
  if(method==='eth_getBalance')return '0x1000000000000000';
  if(method==='eth_getTransactionCount')return '0x0';
  if(method==='eth_call'){
    const call=abi.parseTransaction({data:params[0].data});
    if(call.name==='getAllowedSeaDrop')return abi.encodeFunctionResult(call.name,[[SEA]]);
    if(call.name==='getPublicDrop')return abi.encodeFunctionResult(call.name,[[0,start,start+3600,1,0,false]]);
    if(call.name==='getAllowedFeeRecipients')return abi.encodeFunctionResult(call.name,[[fee]]);
    if(call.name==='getMintStats')return abi.encodeFunctionResult(call.name,[0,0,100]);
    if(call.name==='mintPublic')return '0x';
  }
  if(method==='eth_sendRawTransaction'){
    if(params[0]==='0x')throw {code:mode==='warm-fail'?-32601:-32602};
    const tx=Transaction.from(params[0]);events.push({kind:'send',hash:tx.hash});
    if(receipts.has(tx.hash))throw {code:-32000,message:'already known'};
    const event=abi.encodeEventLog(abi.getEvent('Transfer'),[ZeroAddress,tx.from,1]);
    receipts.set(tx.hash,{transactionHash:tx.hash,blockHash,blockNumber:'0x20',transactionIndex:'0x0',
      from:tx.from,to:SEA,status:'0x1',gasUsed:'0x100',logs:[{address:NFT,...event}]});
    return tx.hash;
  }
  if(method==='eth_getTransactionReceipt'){
    events.push({kind:'receipt'});
    return mode==='unknown'?null:receipts.get(params[0])??null;
  }
  throw Error('Unexpected mock RPC method '+method);
}
https.request=(url,options,callback)=>{
  if(!new URL(url).hostname.endsWith('.invalid'))throw Error('Unexpected external endpoint');
  const req=new EventEmitter();
  req.end=body=>queueMicrotask(()=>{
    const q=JSON.parse(body);let response;
    try{response={jsonrpc:'2.0',id:q.id,result:answer(q)};}
    catch(e){response={jsonrpc:'2.0',id:q.id,error:{code:e.code??-32603,message:e.message??'fixture'}};}
    const res=new EventEmitter();res.statusCode=200;res.setEncoding=()=>{};
    callback(res);res.emit('data',JSON.stringify(response));res.emit('end');
  });
  return req;
};
process.argv=[process.execPath,'multi-mint.mjs','run','--live'];
const {writeFileSync}=await import('node:fs');
process.on('exit',()=>writeFileSync('mock-events.json',JSON.stringify(events)));
await import('./multi-mint.mjs');
`;
test('scheduled orchestration: concurrent send, failed warm-up cleanup, and UNKNOWN guard',async t=>{
  for(const scenario of ['success','warm-fail','unknown'])await t.test(scenario,async()=>{
    const dir=await mkdtemp(join(tmpdir(),'mint-workflow-'));
    try{
      for(const name of await readdir(root)){
        if(!name.endsWith('.mjs')||name.endsWith('.test.mjs'))continue;
        const source=(await readFile(new URL(name,root),'utf8')).replaceAll("'ethers'",JSON.stringify(ethersURL));
        await writeFile(join(dir,name),source);
      }
      await writeFile(join(dir,'mock-live.mjs'),fixture.replace('__ETHERS__',JSON.stringify(ethersURL)));
      const env={...process.env};
      for(const key of Object.keys(env))if(/PRIVATE_KEY|^MINT_|^MULTI_CONFIG$|^READ_WS_RPC$|^NODE_OPTIONS$/.test(key))delete env[key];
      let code=0,stdout='';
      try{({stdout}=await execute(process.execPath,['mock-live.mjs',scenario],{cwd:dir,env,timeout:15000}));}
      catch(e){code=e.code;stdout=e.stdout;assert.equal(typeof code,'number',String(e));}
      const events=JSON.parse(await readFile(join(dir,'mock-events.json'),'utf8'));
      const files=await readdir(join(dir,'reports'));
      const report=JSON.parse(await readFile(join(dir,'reports',files.find(f=>f.startsWith('mint-'))),'utf8'));
      if(scenario==='warm-fail'){
        assert.equal(code,1,stdout);assert.equal(events.filter(e=>e.kind==='send').length,0);
        assert.equal(files.includes('pending-mints.json'),false);
        assert.match(report.error,/warmed/);
      }else{
        assert.equal(events.filter(e=>e.kind==='send').length,4,stdout);
        assert.ok(events.findIndex(e=>e.kind==='receipt')>=4,'all wallet routes start before receipt reads');
        assert.equal(report.attempts.length,2);
        assert.ok(report.attempts.every(a=>a.submitted&&a.routes.length===2));
        if(scenario==='success'){
          assert.equal(code,0,stdout);assert.equal(files.includes('pending-mints.json'),false);
          assert.ok(report.outcomes.every(r=>r.status==='MINT_INCLUDED_SOFT'&&r.transactionIndex==='0'));
        }else{
          assert.equal(code,2,stdout);assert.equal(files.includes('pending-mints.json'),true);
          assert.ok(report.outcomes.every(r=>r.status==='UNKNOWN_CHECK_EXPLORER'));
          const pending=JSON.parse(await readFile(join(dir,'reports','pending-mints.json'),'utf8'));
          assert.equal(pending.length,2);assert.ok(pending.every(p=>!('raw' in p)));
          await assert.rejects(execute(process.execPath,['multi-mint.mjs','run','--live'],{cwd:dir,env,timeout:5000}),
            e=>/Unresolved prior run/.test(e.stderr));
        }
      }
      assert.equal((await readdir(dir)).includes('multi-run.lock'),false);
    }finally{
      assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));
      await rm(dir,{recursive:true,force:true});
    }
  });
});
