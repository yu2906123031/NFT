import {runLocalBenchmark} from './local-bench.mjs';
try{
  const args=process.argv.slice(2);let seconds=15,samples=8;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--seconds')seconds=Number(args[++i]);
    else if(args[i]==='--samples')samples=Number(args[++i]);
    else throw Error('Usage: node bench-local.mjs [--seconds 5-60] [--samples 3-30]');
  }
  await runLocalBenchmark({seconds,samples});
}catch(e){console.error(e.message.length>180?'Local benchmark failed':e.message);process.exitCode=1;}
