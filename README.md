# Robinhood / Rare Friends Mint

Node.js 22+，仅支持 EOA，每钱包 Mint 1 个免费 NFT。
单钱包与多钱包共用预签、广播、回执及运行锁。只有显式 run --live 才广播。

## 检查与启动

~~~powershell
npm install --ignore-scripts
npm test
node mint.mjs check
node multi-mint.mjs check
node multi-mint.mjs prepare
node estimate-gas.mjs
node multi-mint.mjs bench
~~~

- mint.mjs check：无需私钥，打印链上真实 start/end、免费状态、剩余量、配置地址资格。
- multi-mint.mjs check：检查已配置钱包的余额、latest/pending nonce、资格及开售时间模拟，不签名、不广播。
- prepare：检查成功后离线签名验证，仅输出哈希，不保存 raw 或广播。
- estimate-gas.mjs：对 config 的钱包地址执行三次开售时间覆盖模拟，取最大估算加 25%，打印建议，不自动改配置。
- bench：无效载荷的 HTTP 往返，不能代表真实交易接收或入块速度。

实盘至少提前两分钟启动，保持机器唤醒：

~~~powershell
node multi-mint.mjs run --live
# 单钱包隐藏输入私钥：
.start.ps1
~~~

双击入口见 [BAT-使用说明.md](BAT-使用说明.md)，多钱包设置见 [MULTI-README.md](MULTI-README.md)。
run 不带 --live 仍然只读，检查命令不会自动启动实盘。

## 密钥与配置

本地 .ENV / .env 只接受 KEY=value，拒绝裸私钥或夹杂裸私钥的文件。
照 .env.example 的格式填写；真实密钥不要放命令行、聊天或 Git。
.ENV、钱包.txt、reports/、*.local.json 已忽略；报告不含签名 raw 或私钥。

MINT_CONFIG 可指定基础配置覆盖文件，MULTI_CONFIG 可指定多钱包覆盖文件。
带 API key 的标准 WSS URL 通过本地 READ_WS_RPC 设置，不提交真实地址。

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| broadcastRpcs | 官方 sequencer + 官方 RPC | 同一 raw 并发两路，最多支持 8 路 |
| trigger / wallets[].mode | chain | 所有钱包共用开售块监听 |
| autoStartTime | true | 启动时取链上 startTime 并固定，运行中变化则停止 |
| expectedStartTime | 配置快照 | auto 模式不据此排程；关闭 auto 时严格比对 |
| prepareSeconds | 60 | 提前签名、编码请求、首次预热 |
| gasLimit | 420000 | 保留现有上限，降低前应核实各钱包估算 |
| gasPriceMultiplier | 2 | maxFeeGwei 未指定时使用；priority fee=0 |
| maxFeeGwei | null | 可设置固定帽，低于当前 gasPrice 会停止 |
| maxGasBudgetEth | 0.001 | 每钱包首次 + 重试最大费用累计上限 |
| totalGasBudgetEth | 0.006 | 多钱包合计费用上限 |
| reserveRetryBudget | true | 预算、余额必须覆盖两笔同费用上限交易 |
| sendTimeoutMs | 1000 | 发送响应期限，超时不等于未入块 |
| rpcTimeoutMs | 3000 | 常规读取期限 |
| pollMs | 100 | 共享 HTTP 出块监听，每节点最多一个在途请求 |
| receiptPollMs | 150 | 回执轮询间隔，多读节点并行 |
| chainWaitTimeoutSeconds | 60 | 等开售块的最长时间，也用于回滚后等待 |
| sendOffsetMs | 0 | 相对 startTime；负值仅对 clock 有效，chain 仍须先看到开售块 |
| allowPartialWallets | true | 仅跳过缺密钥的钱包，错误配置仍停止 |
| minReadyWallets | 1 | 最少已配置钱包数，可设为 6 |

重试预留不保证能重试。第二笔需要确认首笔回滚、区块未重组、仍有余量/资格、
nonce 无冲突、当前模拟通过、当前余额及累计预算足够。UNKNOWN/pending 不重试。

## 准备与发射

1. 启动时打印链上时间、价格、剩余量并核对钱包。
2. T−60s 预签、算哈希、预编码各路 JSON-RPC 字节，使用发送的同一 HTTPS Agent 预热；连接可选标准 WSS。
3. T−15s 开始复核 drop 指纹、钱包资格、余额、nonce 和费用；必须在 T−5s 前完成。
4. 保存公开交易哈希，T−10s 至 T−3s 刷新连接，最迟 T−2s 完成。最后两秒不重新模拟或估 Gas。
5. 触发时写预编码字节，所有钱包开始提交后才查询回执和记录结果。
6. status=1 且本 NFT 合约 Transfer 从零地址到本钱包才报告软确认成功。

keep-alive 允许复用连接，不能保证服务器不关闭 socket。
预热只发送无效载荷，不能用真实签名字节提前“预热”。
任一路 accepted / already known 即记录已提交；nonce too low 只是诊断，不能证明原哈希成功。

## WSS、时间与部署

READ_WS_RPC 必须支持 eth_chainId 和 eth_subscribe("newHeads")。
先校验链 ID，再接受匹配订阅的有效块头。断线重连，HTTP 保底；未配置时明确使用共享 HTTP。

官方 wss://feed.mainnet.chain.robinhood.com 是 Nitro sequencer feed，不是 newHeads RPC。
可用提供商或自建完整节点的标准 WSS；不要把 API key 提交进配置。
默认全部 chain，没有胜率测量时不做 3+3 分组。

秒级链上 timestamp 和网络响应不能证明本机达到毫秒级时钟精度。
clock 是实验选项；使用前确认 Windows 时间服务 / Linux chrony 同步，避免休眠。
Node 定时器、GC、系统校时和网络仍会抖动。本工具不修改系统时间或自动部署云主机。

## 报告与恢复

reports/mint-时间.json 记录配置/实际 sendOffsetMs、端点响应耗时及状态、
触发来源、区块号、transactionIndex、gasUsed、gasUsedForL1、effectiveGasPrice。
节点没返回的字段记 null。报告只记录 RPC 主机名，不记录完整路径或密钥。

发射前写 reports/pending-mints.json。未知回执或中断后，记录会阻止再次实盘：

~~~powershell
node recover.mjs
~~~

恢复只查询原哈希，多 RPC 查回执；UNKNOWN 时自动查 Blockscout API，输出原交易链接。
浏览器索引只作旁证，不代替验证后的 RPC 回执、不授权重发。
未确认的哈希继续阻断。正常退出会清理确定未发送的计划；异常退出可能保留未发送计划，需人工核对。

单钱包、多钱包和显式实盘测试共用 multi-run.lock。
异常退出留下锁时，先确认旧进程已结束、核对原哈希，再处理残留锁并运行恢复。
锁不能阻止其他程序/机器用同一钱包；预签后不要另发交易。退出进程不能撤回已广播交易。

## 测速边界

两条默认路径是减少并发的基线，不是实测赢家。
拒包 RTT、入口 accepted RTT、最终 block/index 是不同指标。
同一 raw 同时发多入口时，回执无法识别究竟哪条路径先到排序器。
机房选择、负偏移和真实入块速度需在目标环境独立实测，不保证 Mint 排序或成功。
eth_sendRawTransactionSync 未启用，端点兼容性未验证，它也不改变 FCFS 排序。

参考：[官方连接说明](https://docs.robinhood.com/chain/connecting/)、
[FCFS 说明](https://docs.robinhood.com/chain/)、
[Blockscout 交易 API](https://docs.blockscout.com/api-reference/get-transaction-info)。
