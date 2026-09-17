import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {Interface,getAddress} from 'ethers';
import {CHAIN,NFT} from './core.mjs';
import {RpcPool} from './rpc-pool.mjs';
const root=new URL('./',import.meta.url),pool=new RpcPool({timeoutMs:10000});
const abi=new Interface(['function balanceOf(address) view returns (uint256)']);
try {
 const config=JSON.parse(await readFile(new URL('config.json',root),'utf8'));
 const multi=JSON.parse(await readFile(new URL('multi-config.json',root),'utf8'));
 const lines=(await readFile(new URL('钱包.txt',root),'utf8')).replace(/^\uFEFF/,'').split(/\r?\n/);
 const addresses=[];
 for(const [i,line] of lines.entries()) {if(!line.trim())continue;try{addresses.push(getAddress(line.trim()));}catch{throw Error('Invalid address at line '+(i+1));}}
 const unique=[...new Set(addresses)];if(!unique.length)throw Error('No addresses');
 const valid=[];
 for(const url of [...new Set([config.readRpc,...multi.readRpcs])]){try{if(BigInt(await pool.call(url,'eth_chainId'))===CHAIN)valid.push(url);}catch{}}
 if(!valid.length)throw Error('No available RPC with matching chain ID');
 let block;
 for(const url of valid){try{const b=await pool.call(url,'eth_getBlockByNumber',['latest',false]);if(/^0x[0-9a-f]+$/i.test(b?.number)&&/^0x[0-9a-f]{64}$/i.test(b?.hash)){block=b;break;}}catch{}}
 if(!block)throw Error('Cannot read block');
 console.log(`Contract: ${NFT}, block: ${BigInt(block.number)}, addresses: ${unique.length}`);
 const rows=[];
 for(const address of unique){
  let row={address,status:'查询失败',balance:null};
  for(const url of valid){try{
   const result=await pool.call(url,'eth_call',[{to:NFT,data:abi.encodeFunctionData('balanceOf',[address])},block.number]);
   const balance=abi.decodeFunctionResult('balanceOf',result)[0];
   row={address,status:balance>0n?'有NFT':'无NFT',balance:balance.toString()};break;
  }catch{}}
  rows.push(row);console.log(`${address} ${row.status} ${row.balance??'unknown'}`);
 }
 const checkedAt=new Date().toISOString(),dir=new URL(`reports/nft-${checkedAt.replace(/[:.]/g,'-')}/`,root);
 await mkdir(dir,{recursive:true});
 await writeFile(new URL('结果.json',dir),JSON.stringify({checkedAt,chainId:CHAIN.toString(),contract:NFT,blockNumber:BigInt(block.number).toString(),blockHash:block.hash,rows},null,2));
 await writeFile(new URL('结果.csv',dir),'\uFEFF地址,NFT数量,状态\r\n'+rows.map(r=>`${r.address},${r.balance??''},${r.status}`).join('\r\n'));
 for(const status of ['有NFT','无NFT','查询失败']){const selected=rows.filter(r=>r.status===status);await writeFile(new URL(status+'.txt',dir),selected.map(r=>r.address).join('\r\n'));console.log(`${status}: ${selected.length}`);}
 console.log(decodeURIComponent(dir.pathname));if(rows.some(r=>r.balance===null))process.exitCode=1;
}catch(error){console.error(error.message);process.exitCode=1;}finally{pool.close();}
