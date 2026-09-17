import {sleep} from './core.mjs';
export function summarize(values){
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  const round=n=>Math.round(n*100)/100;
  const percentile=p=>sorted.length?round(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]):null;
  return {samples:sorted.length,minMs:sorted.length?round(sorted[0]):null,p50Ms:percentile(.5),p95Ms:percentile(.95),
    maxMs:sorted.length?round(sorted.at(-1)):null};
}
export async function measureLocalTimers({samples=100,intervalMs=20,pause=sleep,wall=Date.now,mono=()=>performance.now()}={}){
  const overshoot=[],wallStart=wall(),monoStart=mono();let maxClockStep=0;
  for(let i=0;i<samples;i++){
    const before=mono();await pause(intervalMs);
    overshoot.push(Math.max(0,mono()-before-intervalMs));
    maxClockStep=Math.max(maxClockStep,Math.abs((wall()-wallStart)-(mono()-monoStart)));
  }
  return {timerOvershoot:summarize(overshoot),maxWallClockStepMs:Math.round(maxClockStep*100)/100,
    absoluteClockOffsetMs:null,note:'Timer scheduling delay only; not NTP accuracy or network latency.'};
}
export function observedBlockKey(block){return block.number.toLowerCase()+':'+block.hash.toLowerCase();}
export function recordArrival(map,block,time){
  const key=observedBlockKey(block);
  if(!map.has(key))map.set(key,time);
  if(map.size>5000)map.delete(map.keys().next().value);
}
export function compareArrivals(feed,rpc){
  const deltas=[];
  for(const [key,arrival] of rpc)if(feed.has(key))deltas.push(arrival-feed.get(key));
  return {rpcObservedAfterFeed:summarize(deltas),feedFirst:deltas.filter(n=>n>0).length,
    rpcFirst:deltas.filter(n=>n<0).length,ties:deltas.filter(n=>n===0).length,
    note:'Matched number AND hash; positive means feed observed first. Includes HTTP polling cadence.'};
}
export function recommendSendTimeout(rows,current){
  const p95=rows.map(r=>r.warm?.p95Ms).filter(Number.isFinite);
  if(!p95.length)return {recommendedMs:null,currentMs:current,changed:false};
  const recommended=Math.min(3000,Math.max(400,Math.ceil((Math.max(...p95)+200)/100)*100));
  return {recommendedMs:recommended,currentMs:current,changed:false,
    note:'Suggestion from invalid-payload RTT only; no fee/offset/endpoint configuration is changed.'};
}
