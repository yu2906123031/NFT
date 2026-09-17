import {open,unlink} from 'node:fs/promises';
export async function acquireRunLock(path){
  let handle;
  try{handle=await open(path,'wx');}catch{throw Error('Cannot acquire multi-run.lock; live process or stale lock exists');}
  try{await handle.writeFile('PID '+process.pid+'\n');await handle.close();}
  catch(e){await handle.close().catch(()=>{});await unlink(path).catch(()=>{});throw e;}
  let released=false;
  return async()=>{if(released)return;released=true;await unlink(path);};
}