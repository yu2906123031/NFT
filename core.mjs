import { Interface, ZeroAddress, getAddress, parseEther } from 'ethers';
export const CHAIN = 4663n;
export const NFT = '0x116eaa62241751e0c98da43d458600c6c17cd361';
export const SEA = '0x00005ea00ac477b1030ce78506496e8c2de24bf5';
export const abi = new Interface([
  'function getAllowedSeaDrop() view returns (address[])',
  'function getMintStats(address) view returns (uint256,uint256,uint256)',
  'function getPublicDrop(address) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address) view returns (address[])',
  'function mintPublic(address,address,address,uint256) payable',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)'
]);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const same = (a,b) => a.toLowerCase() === b.toLowerCase();
export const mintData = fee => abi.encodeFunctionData('mintPublic', [NFT, getAddress(fee), ZeroAddress, 1]);
export function validateState(s, config) {
  if (s.chain !== CHAIN) throw Error('Wrong chain ID');
  if (!s.allowed.some(a => same(a, SEA))) throw Error('SeaDrop no longer allowed');
  if (s.drop.mintPrice !== 0n) throw Error('Mint is no longer free');
  if (!config.autoStartTime && s.drop.startTime !== BigInt(config.expectedStartTime)) throw Error('Start time changed: review configuration');
  if (s.drop.endTime <= s.drop.startTime || s.now > s.drop.endTime) throw Error('Sale ended or invalid');
  if (s.minted >= s.maximum) throw Error('Sold out');
  if (s.userMinted >= s.drop.maxTotalMintableByWallet) throw Error('Wallet mint limit reached');
  if (!s.fees.length) throw Error('No verified fee recipient');
}
export function validateCost(gas, fee, balance, budget) {
  if (gas <= 0n || fee <= 0n) throw Error('Gas and fee must be positive');
  const cap = gas * fee;
  if (cap > parseEther(budget)) throw Error('Maximum gas cost exceeds configured budget');
  if (cap > balance) throw Error('Insufficient ETH for maximum gas cost');
  return cap;
}
export async function broadcast(urls, raw, hash, rpc, report = () => {}) {
  // Identical signed bytes/nonce on all routes; no new transaction retry.
  return Promise.allSettled(urls.map(async (url,i) => {
    const t = performance.now();
    try {
      const result = await rpc(url, 'eth_sendRawTransaction', [raw]);
      if (typeof result !== 'string' || !same(result, hash)) throw Error('Unexpected transaction hash');
      report(i, true, Math.round(performance.now()-t));
      return result;
    } catch (e) { report(i, false, Math.round(performance.now()-t)); throw e; }
  }));
}
