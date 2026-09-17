import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
const root=new URL('./reports/',import.meta.url);
export function createJournal(directory=root){
  const path=new URL('pending-mints.json',directory),tmp=new URL('pending-mints.tmp',directory);
  return {
    async assertNoPending(){
      try{await readFile(path);throw Error('Unresolved prior run: use node recover.mjs before starting another live run');}
      catch(e){if(e.code!=='ENOENT')throw e;}
    },
    async savePending(plans){
      await mkdir(directory,{recursive:true});
      if(!plans.length){await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});return;}
      const entries=plans.map(p=>({label:p.label,address:p.address,hash:p.hash,nonce:p.tx?.nonce??p.nonce}));
      await writeFile(tmp,JSON.stringify(entries,null,2)+'\n');
      await rename(tmp,path);
    },
    async readPending(){
      try{return JSON.parse(await readFile(path,'utf8'));}
      catch(e){if(e.code==='ENOENT')return [];throw e;}
    }
  };
}
export const {assertNoPending,savePending,readPending}=createJournal();
export async function writeRunReport(report){
  await mkdir(root,{recursive:true});
  const path=new URL('mint-'+report.startedAt.replace(/[:.]/g,'-')+'.json',root);
  await writeFile(path,JSON.stringify(report,null,2)+'\n');
  return path;
}
