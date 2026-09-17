# Robinhood / Rare Friends Mint

Node.js 22+。仅针对本次 Rare Friends Genesis，默认命令只读。
**未启动真实 Mint，未对真实钱包发送任何交易。**

## 安装、测速、检查

在此目录运行：

~~~powershell
npm install --ignore-scripts
node mint.mjs bench
node mint.mjs check
npm test
~~~

bench 向每个节点发送 12 次无效载荷（第一轮冷启动不计入延迟），输出 P50/P95 和失败数。
只测错误响应的往返时间，不代表节点支持真实广播或交易入块速度；网关也能返回 JSON-RPC 错误。
跨地区服务器分别运行相同命令，比较节点稳定性与延迟。

## 配置

编辑 config.json（可复制成 config.local.json，并设置 $env:MINT_CONFIG='config.local.json'）：

- readRpc：支持 eth_call、区块、余额、nonce、回执的完整 Robinhood RPC。
- broadcastRpcs：1–4 个广播端点，默认官方排序器和公共 RPC。并发发送完全相同的签名交易。
- walletAddress：填自己钱包的公开地址，check 才能核对个人 mint 限额；实盘会与私钥地址比对。
- trigger：chain（默认）等最新区块 timestamp >= startTime；clock 按电脑时间直接发送，低延迟但存在抢早回滚风险。
- expectedStartTime：1789567220，即 2026-09-16 北京时间 22:00:20。链上发生变化时拒绝发送，需重新核实后修改。
- gasLimit：**默认 null，不是已经准备好实盘的配置。开售前估算通常回滚。必须提前填入经模拟/可靠估算确定、包含 L1 数据费用的 Gas 上限。**
  其他交易的 gasUsed 只能参考，不能保证本次需要的 Gas。程序不会猜一个数值并发出去。
- maxFeeGwei：null 时用准备阶段 eth_gasPrice 的两倍作为费用上限；priority fee=0。
  该上限用于容纳基础费用变化，不代表加价获得排序优先权。
- maxGasBudgetEth：默认单笔最大 Gas 预算 0.001 ETH，**不是预计花费**。gasLimit × maxFeePerGas 超预算或余额则停止。
- prepareSeconds：提前 60 秒准备签名；最后约 15 秒再次检查链上配置、nonce、预热连接。
- rpcTimeoutMs：默认 3000ms，网络差会超时停止；不应该把高超时当成低延迟优化。

配置中没有私钥字段。带 API key 的 RPC URL 放 config.local.json，勿提交或公开。

## 真正启动

先确认 gasLimit、钱包 ETH、钱包地址和 trigger。
至少提前 2 分钟运行，保持机器唤醒、网络稳定、系统时钟同步。

Windows PowerShell：

~~~powershell
.\start.ps1
~~~

它在本机隐藏输入私钥，启动 node mint.mjs run --live，结束后清理父进程环境变量。
不要把私钥写入命令行历史或发送给他人。JS 内存不能保证安全擦除。
若执行策略阻止脚本，按自己机器的管理员策略处理，不需要降低全局执行策略。

Linux / bash：

~~~bash
read -rsp "Private key: " MINT_PRIVATE_KEY; echo
export MINT_PRIVATE_KEY
node mint.mjs run --live
unset MINT_PRIVATE_KEY
~~~

**run --live 是真实发送开关。** node mint.mjs run 不带 --live 仍只读。
默认 gasLimit=null 的实盘运行可能在开售前 60 秒停止，务必先完成上面的配置。
程序要求在开售前启动，错过准备窗口则停止，不自动追单。

## 运行行为

1. 校验 chain ID=4663、免费公售、时间、剩余量、该地址累计 mint 限额、允许的 SeaDrop 与费用地址。
2. 同一区块读取配置；准备时检查 latest/pending nonce 相等，余额足够覆盖费用上限。
3. 在内存签名一笔 quantity=1、value=0 的交易。签名和 calldata 不写日志。
4. 开售前再读配置及 nonce，按 trigger 发送到全部广播端点；所有路径都是同一交易哈希。
5. 无论 RPC 成功、失败或超时都查询原交易回执，仅首次明确回滚时，在链上已开售、仍有余量、资格有效、nonce 无冲突且当前模拟通过后，用下一 nonce 最多重试一次。首次与重试的费用上限合计不得超过原预算；回执未知或 pending 不重试。
6. receipt.status=1 且发现本合约从零地址到自己钱包的 Transfer 才报告 Mint 已入块（软确认）。
   超时只报告状态未知；去浏览器查原哈希，勿直接再发另一笔。

预签后不要再用这个钱包做其他交易。
最后检查与广播间仍存在状态变化窗口（售罄、费用变化、项目方改配置等）。
clock 模式没有毫秒级精度保证；系统调度、网络抖动和链上时间偏差都会影响结果。
Ctrl+C 在广播前可停止；广播后的交易不能靠退出程序撤回。
工具没有私有排序通道，也不保证排序优先或 Mint 成功。

官方参考：
- https://docs.robinhood.com/chain/connecting/
- https://docs.robinhood.com/chain/gas-and-fees/
- https://github.com/ProjectOpenSea/seadrop/blob/main/src/SeaDrop.sol
