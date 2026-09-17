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
node bench-local.mjs
# 或双击 04-LOCAL-BENCH.bat
~~~

- mint.mjs check：无需私钥，打印链上真实 start/end、免费状态、剩余量、配置地址资格。
- multi-mint.mjs check：检查已配置钱包的余额、latest/pending nonce、资格及开售时间模拟，不签名、不广播。
- prepare：检查成功后离线签名验证，仅输出哈希，不保存 raw 或广播。
- estimate-gas.mjs：对 config 的钱包地址执行三次开售时间覆盖模拟，取最大估算加 25%，打印建议，不自动改配置。
- bench / bench-local.mjs：本机测速，包括冷/热连接 RTT、连接复用、定时器额外延迟、官方 feed 与 HTTP 同块到达差；不加载私钥、不广播有效交易。

实盘至少提前两分钟启动，保持机器唤醒：

~~~powershell
node multi-mint.mjs run --live
# 单钱包隐藏输入私钥：
.\start.ps1
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
| trigger / wallets[].mode | chain | 所有钱包共用官方 feed 和 HTTP 开售块监听 |
| useSequencerFeed | true | 默认连接固定官方 feed，无需 API key |
| feedStallMs | 2000 | feed 停更检测阈值 |
| backupPollMs | 1000 | 推送健康时 HTTP 备份查询间隔 |
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
| pollMs | 100 | 推送不可用时 HTTP 轮询，每节点最多一个在途请求 |
| receiptPollMs | 150 | 回执轮询间隔，多读节点并行 |
| chainWaitTimeoutSeconds | 60 | 等开售块的最长时间，也用于回滚后等待 |
| sendOffsetMs | 0 | 相对 startTime；负值仅对 clock 有效，chain 仍须先看到开售块 |
| allowPartialWallets | true | 仅跳过缺密钥的钱包，错误配置仍停止 |
| minReadyWallets | 1 | 最少已配置钱包数，可设为 6 |

重试预留不保证能重试。第二笔需要确认首笔回滚、区块未重组、仍有余量/资格、
nonce 无冲突、当前模拟通过、当前余额及累计预算足够。UNKNOWN/pending 不重试。

## 准备与发射

1. 启动时打印链上时间、价格、剩余量并核对钱包。
2. T−60s 预签、算哈希、预编码各路 JSON-RPC 字节，使用发送的同一 HTTPS Agent 预热；连接官方 feed，并用已验证链 ID 的 RPC 核对 feed 的块哈希与时间戳。
3. T−15s 开始复核 drop 指纹、钱包资格、余额、nonce 和费用；必须在 T−5s 前完成。
4. 保存公开交易哈希，T−10s 至 T−3s 刷新连接，最迟 T−2s 完成。最后两秒不重新模拟或估 Gas。
5. 触发时写预编码字节，所有钱包开始提交后才查询回执和记录结果。
6. status=1 且本 NFT 合约 Transfer 从零地址到本钱包才报告软确认成功。

keep-alive 允许复用连接，不能保证服务器不关闭 socket。
预热只发送无效载荷，不能用真实签名字节提前“预热”。
任一路 accepted / already known 即记录已提交；nonce too low 只是诊断，不能证明原哈希成功。

## 本机运行与官方 feed

默认在当前电脑运行，无需云服务器。实盘提前连接固定官方地址：
wss://feed.mainnet.chain.robinhood.com。六钱包共用一条连接，无需 API key。

每次连接先与已校验 chainId=4663 的 RPC 核对同块哈希及时间戳，再允许 feed 触发。
过滤过期历史消息、未来异常时间、重复/倒退序号；使用 sequenceNumber 对应 L2 块号，不能误用消息头中的 L1 blockNumber。
该连接信任官方 WSS 的 TLS 和连接时的 RPC 核对；没有实现 signatureV2 的独立密码学验签，不能替换为第三方 feed URL。

feed、可选标准 WSS、HTTP 首个有效开售块都可触发。推送正常时 HTTP 保持低频备份；
断线或停更时恢复较快轮询。feed 重连采用 1/2/4/.../15 秒退避，重连后重新核对。
HTTP 429 或已识别的 RPC 限流会让同一连接池中的该主机暂停请求，遵守 Retry-After。
这减少重复请求，不能保证官方不会限流。

READ_WS_RPC 仍可选填提供商的标准 eth_subscribe("newHeads") 地址；
即使不填，内置官方 feed 也默认启用。官方 feed 不是标准 newHeads RPC，请勿填入 READ_WS_RPC。
useSequencerFeed=false 可关闭官方 feed，保留标准 WSS / HTTP。

秒级区块 timestamp 不能证明本机达到毫秒级时钟精度。
clock 是实验选项；默认 chain 按有效链上开售块触发，不自动按测速 RTT 提前发送。
本工具不修改系统时间、优先级或电源设置。保持机器唤醒、网络稳定。

## 本机测速

~~~powershell
npm run bench:local
node bench-local.mjs --seconds 15 --samples 8
~~~

双击 04-LOCAL-BENCH.bat 也可运行。01-PREFLIGHT.bat 会附带较短测速。
--seconds 是 feed/HTTP 对比采样时长，--samples 是每条发送路径的热请求数。
测速只请求链状态和无效交易拒包结果，不加载私钥、不签名，不会广播有效交易。
它与实盘共用运行锁，避免抢占正在实盘的网络连接。

reports/local-bench-时间.txt / .json 分别记录：
- 冷连接 RTT，以及可观测的 DNS、TCP、TLS 建连耗时；
- 热请求 RTT、连接复用样本数、本机请求写出耗时、响应头到达耗时；
- 本机 20ms 定时器的额外延迟 P50/P95/最大值；
- 同一块号且同一哈希下，RPC 相对 feed 的观测差值，正数表示 feed 先到；
- 失败/限流数量、feed 连通性、重连次数和发送超时建议。

“热请求”不保证每次都复用了连接，应同时查看 reused 样本。
同块对比采用 500ms HTTP 查询间隔，差值包含查询节奏和节点处理时间，不是纯单程网络延迟。
定时器额外延迟与网络 RTT 分开报告，不相加推算入块时间。
链上时间戳差值和观测到的本机时钟跳变都不是 NTP 校时精度。
程序不自动改发送偏移、费用或超时；建议需结合本机多次测量判断。

## 报告与恢复

reports/mint-时间.json 记录配置/实际 sendOffsetMs、端点响应耗时及状态、
触发来源、触发到提交耗时、请求写出/响应头/完整响应耗时、连接复用状态、
区块号、transactionIndex、gasUsed、gasUsedForL1、effectiveGasPrice。
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
本机测速不能验证真实入块速度，不保证 Mint 排序或成功。
eth_sendRawTransactionSync 未启用，端点兼容性未验证，它也不改变 FCFS 排序。

参考：[官方连接说明](https://docs.robinhood.com/chain/connecting/)、
[FCFS 说明](https://docs.robinhood.com/chain/)、
[Blockscout 交易 API](https://docs.blockscout.com/api-reference/get-transaction-info)。
