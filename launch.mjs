import {readFile,mkdir,writeFile,access} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
const root=fileURLToPath(new URL('./',import.meta.url));
process.chdir(root);
const mode=process.argv[2];
if(!['check','live'].includes(mode))throw Error('Usage: node launch.mjs check|live');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
await mkdir('reports',{recursive:true});
const prefix=`reports/${mode}-${stamp}`;
const log=createWriteStream(prefix+'.txt',{flags:'wx'});
await once(log,'open');
const report={mode,startedAt:new Date().toISOString(),stages:[]};
const print=text=>{process.stdout.write(text+'\n');log.write(text+'\n');};
async function stage(name,action){
 print('\n=== '+name+' ===');const start=Date.now();
 try{await action();report.stages.push({name,status:'PASS',durationMs:Date.now()-start});print('PASS: '+name);}
 catch(e){report.stages.push({name,status:'FAIL',durationMs:Date.now()-start,reason:e.message});print('FAIL: '+name+' - '+e.message);}
}
function node(args,timeout=120000){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd:root,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let expired=false;
  const timer=timeout?setTimeout(()=>{expired=true;child.kill();},timeout):null;
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{process.stdout.write(chunk);log.write(chunk);});
  child.on('error',()=>{clearTimeout(timer);reject(Error('Unable to start Node child'));});
  child.on('close',code=>{clearTimeout(timer);if(expired)reject(Error('Check timed out'));else if(code!==0)reject(Error('Command exited with code '+code));else resolve();});
 });
}
let cfg;
try{
 print('Robinhood multi-wallet '+(mode==='live'?'LIVE MINT':'READ-ONLY PREFLIGHT'));
 print('Local time: '+new Date().toString());print('Report: '+prefix+'.txt');
 await stage('Environment, configuration and launch window',async()=>{
  if(Number(process.versions.node.split('.')[0])<22)throw Error('Node.js 22+ required');
  const json=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
  cfg={...await json('config.json'),...await json(process.env.MULTI_CONFIG||'multi-config.json')};
  if(!Number.isSafeInteger(cfg.expectedStartTime))throw Error('Invalid expectedStartTime');
  print('Node: '+process.version);
  print('Opening (Beijing): '+new Date(cfg.expectedStartTime*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));
  for(const w of cfg.wallets.filter(w=>w.enabled!==false))print(w.label+': '+w.mode);
  print('Broadcast endpoints: '+cfg.broadcastRpcs.length+'; read endpoints: '+cfg.readRpcs.length);
  print('Retry: at most once after confirmed revert, if supply/eligibility/simulation/budgets permit.');
  print('Wallet budget ETH: '+cfg.maxGasBudgetEth+'; combined budget ETH: '+cfg.totalGasBudgetEth);
  if(!cfg.autoStartTime && Date.now()>=cfg.expectedStartTime*1000-30000)throw Error('Too late: live start requires at least 30 seconds before opening');
 });
 if(mode==='live'){
  if(report.stages.some(s=>s.status==='FAIL'))throw Error('Launch checks failed');
  print('LIVE: preparing to mint one NFT per enabled wallet. Keep this window open. Ctrl+C stops the program.');
  await stage('Live multi-wallet Mint',()=>node(['multi-mint.mjs','run','--live'],0));
 }else{
  print('No valid transaction will be broadcast; signatures stay in memory.');
  await stage('Offline regression tests',()=>node(['--test','core.test.mjs','multi.test.mjs','rpc-pool.test.mjs','retry.test.mjs','resilience.test.mjs']));
  await stage('Runtime syntax',async()=>{for(const f of ['multi-mint.mjs','mint.mjs','retry.mjs','rpc-pool.mjs','multi-core.mjs','env.mjs','rpc-read.mjs','run-lock.mjs'])await node(['--check',f]);});
  if(cfg){
   await stage('All read nodes: chain, freshness, receipt and contract',async()=>{
    const {RpcPool}=await import('./rpc-pool.mjs');const {CHAIN,NFT,abi}=await import('./core.mjs');
    const pool=new RpcPool({timeoutMs:cfg.rpcTimeoutMs});
    try{
     const results=await Promise.allSettled(cfg.readRpcs.map(async(url,index)=>{
      if(BigInt(await pool.call(url,'eth_chainId'))!==CHAIN)throw Error('Wrong chain');
      const block=await pool.call(url,'eth_getBlockByNumber',['latest',false]);
      const age=Date.now()-Number(BigInt(block.timestamp))*1000;
      if(age>15000||age< -5000)throw Error('Clock/RPC freshness check failed');
      await pool.call(url,'eth_getTransactionReceipt',['0x'+'00'.repeat(32)]);
      const stats=abi.decodeFunctionResult('getMintStats',await pool.call(url,'eth_call',[{to:NFT,data:abi.encodeFunctionData('getMintStats',[cfg.walletAddress])},block.number]));
      print('Read '+index+': chain=4663, ageMs='+age+', remaining='+(stats[2]-stats[1]));
     }));
     results.forEach((r,i)=>{if(r.status==='rejected')print('Read '+i+': FAILED - '+r.reason.message);});
     if(results.some(r=>r.status==='rejected'))throw Error('One or more read endpoints failed');
    }finally{pool.close();}
   });
   await stage('All broadcast nodes: invalid-payload response and concurrent warm-up',async()=>{
    const {RpcPool}=await import('./rpc-pool.mjs');const pool=new RpcPool({timeoutMs:cfg.rpcTimeoutMs,sockets:6});
    const count=cfg.wallets.filter(w=>w.enabled!==false).length;
    try{
     const results=await Promise.allSettled(cfg.broadcastRpcs.map(async(url,index)=>{
      const times=[];for(let i=0;i<3;i++)times.push(await pool.probe(url));
      const warm=await Promise.allSettled(Array.from({length:count},()=>pool.probe(url,1000)));
      const passed=warm.filter(r=>r.status==='fulfilled').length;
      print('Broadcast '+index+': probeMs='+times.join(',')+', warmWithin1s='+passed+'/'+count);
      if(!passed)throw Error('No successful 1-second warm-up response');
      if(passed<count)print('WARNING: broadcast '+index+' had partial warm-up failures; invalid-payload probes do not prove transaction acceptance.');
     }));
     results.forEach((r,i)=>{if(r.status==='rejected')print('Broadcast '+i+': FAILED - '+r.reason.message);});
     if(results.some(r=>r.status==='rejected'))throw Error('One or more broadcast endpoints failed');
    }finally{pool.close();}
   });
   await stage('Six-wallet eligibility, balance, nonce, budgets, simulation and offline signature',()=>node(['multi-mint.mjs','prepare']));
  }
 }
}catch(e){report.stages.push({name:'Launcher',status:'FAIL',reason:e.message});print('ERROR: '+e.message);}
finally{
 report.finishedAt=new Date().toISOString();
 report.status=report.stages.some(s=>s.status==='FAIL')?'FAIL':'PASS';
 print('\n=== SUMMARY: '+report.status+' ===');
 for(const s of report.stages)print(s.status+' - '+s.name);
 if(mode==='check')print(report.status==='PASS'?'Preflight passed at the time of checking. No live Mint is running. Start 02-LIVE-MINT.bat to arm.':'Preflight has failures. Review this report before starting live mode.');
 print('TXT: '+prefix+'.txt');print('JSON: '+prefix+'.json');
 await writeFile(prefix+'.json',JSON.stringify(report,null,2)+'\n');
 await new Promise(resolve=>log.end(resolve));
 process.exitCode=report.status==='PASS'?0:1;
}