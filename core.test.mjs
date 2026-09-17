import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Transaction, keccak256, ZeroAddress } from 'ethers';
import { CHAIN,NFT,SEA,abi,mintData,validateState,validateCost,broadcast } from './core.mjs';
const fee='0x0000a26b00c1f0df003000390027140000faa719';
function fixture() { return {chain:CHAIN,allowed:[SEA],now:1789567200n,
  drop:{mintPrice:0n,startTime:1789567220n,endTime:1789570820n,maxTotalMintableByWallet:1n},
  fees:[fee],minted:963n,maximum:1024n,userMinted:0n}; }
const cfg={expectedStartTime:1789567220};
test('valid free drop accepted; changed price, start, chain and minter rejected',()=>{
  assert.doesNotThrow(()=>validateState(fixture(),cfg));
  for(const modify of [
    s=>s.chain=1n,s=>s.allowed=[],s=>s.drop.mintPrice=1n,s=>s.drop.startTime++,
    s=>s.userMinted=1n,s=>s.minted=1024n,s=>s.fees=[],s=>s.now=1789570821n
  ]) { const s=fixture();modify(s);assert.throws(()=>validateState(s,cfg)); }
});
test('maximum fee budget and insufficient funds rejected',()=>{
  assert.equal(validateCost(100000n,1000000n,1000000000000n,'0.001'),100000000000n);
  assert.throws(()=>validateCost(100000n,1000000n,1n,'0.001'));
  assert.throws(()=>validateCost(100000n,100000000000n,10n**20n,'0.001'));
  assert.throws(()=>validateCost(0n,1n,10n,'0.001'));
});
test('signed transaction preserves chain, destination, zero value, one NFT and sender recipient',async()=>{
  const wallet=Wallet.createRandom();
  const raw=await wallet.signTransaction({type:2,chainId:CHAIN,to:SEA,nonce:7,
    data:mintData(fee),value:0n,gasLimit:500000n,maxFeePerGas:1000000000n,maxPriorityFeePerGas:0n});
  const tx=Transaction.from(raw),args=abi.decodeFunctionData('mintPublic',tx.data);
  assert.equal(tx.chainId,CHAIN);
  assert.equal(tx.to.toLowerCase(),SEA);
  assert.equal(tx.from,wallet.address);
  assert.equal(tx.value,0n);
  assert.equal(tx.nonce,7);
  assert.equal(args[0].toLowerCase(),NFT);
  assert.equal(args[1].toLowerCase(),fee);
  assert.equal(args[2],ZeroAddress);
  assert.equal(args[3],1n);
  assert.equal(tx.hash,keccak256(raw));
});
test('broadcast starts every route concurrently and does not let one failure cancel others',async()=>{
  const calls=[],resolvers=[];
  const raw='0x0102',hash='0x'+'ab'.repeat(32);
  const rpc=(url,method,params)=>{calls.push({url,method,params});return new Promise((resolve,reject)=>resolvers.push({resolve,reject}));};
  const pending=broadcast(['one','two','three'],raw,hash,rpc);
  assert.equal(calls.length,3);
  for(const c of calls){assert.deepEqual(c.params,[raw]);assert.equal(c.method,'eth_sendRawTransaction');}
  resolvers[0].reject(Error('timeout'));resolvers[1].resolve(hash);resolvers[2].resolve('wrong hash');
  const result=await pending;
  assert.deepEqual(result.map(r=>r.status),['rejected','fulfilled','rejected']);
  assert.equal(calls.length,3);
});
