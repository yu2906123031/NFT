# 双击启动

1. 双击 01-PREFLIGHT.bat：先查链上真实 start/end、免费状态和余量，再检查离线测试、语法、本机延迟/官方 feed、RPC 和已配置钱包的余额/nonce/资格/模拟/离线签名。不广播有效交易。
2. 查看 reports 中 TXT 日志和 JSON 汇总。PASS 只代表检查时状态；确认实际钱包数量，默认允许跳过缺少密钥的钱包。
3. 根据链上开售时间，至少提前两分钟双击 02-LIVE-MINT.bat。看到 ARMED 后保持窗口打开、不休眠、不再用这些钱包发交易。
4. 03-CHECK-NFT.bat 查询本地 钱包.txt 中公开地址的 NFT 数量。
5. 04-LOCAL-BENCH.bat 单独测试本机定时器延迟、网络 RTT、feed/RPC 同块到达差，报告保存在 reports/local-bench-时间.txt 和 .json。无需私钥，不会广播有效交易。

时间以启动时链上 getPublicDrop 输出为准，文档不再维护另一份日期。
默认所有钱包共用官方 feed，并以 HTTP 兜底等待链上开售块，每钱包 Mint 1 个，通过官方 sequencer 和官方 RPC 发同一 raw。
首次明确回滚且资格、模拟、余额和预算允许时最多重试一次；pending/UNKNOWN 不重试。

实盘报告位于 reports/mint-时间.json。
未知回执或中断后运行 node recover.mjs 查询原哈希，未确认记录会阻止再次实盘。
所有实盘入口共用运行锁；确认旧进程已结束后才能处理异常退出的残留锁。

BAT 自动切换项目目录。检查不会自动启动实盘，已运行进程不会加载新修改。
详细参数及 WSS 配置见 [README.md](README.md)。
