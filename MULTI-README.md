# 多钱包配置

multi-mint.mjs 支持 1～6 个不同 EOA，单钱包入口使用同一实现。
默认六个条目均为 chain，共用官方 feed / HTTP 开售监听，每钱包 Mint 1 个，同一 raw 发两路。

本地 .ENV 的格式：

~~~dotenv
MINT_PRIVATE_KEY=第一把私钥
MINT_PRIVATE_KEY_2=第二把私钥
MINT_PRIVATE_KEY_3=第三把私钥
MINT_PRIVATE_KEY_4=第四把私钥
MINT_PRIVATE_KEY_5=第五把私钥
MINT_PRIVATE_KEY_6=第六把私钥
READ_WS_RPC=
~~~

示例不要覆盖已有密钥；裸私钥文件不再兼容。
address 可填对应公开地址强制比对，enabled=false 明确停用。

默认 allowPartialWallets=true、minReadyWallets=1：缺少密钥的条目打印并跳过。
无效密钥、地址不符、重复钱包，以及已加载钱包的 nonce/余额/资格/模拟失败均停止。
要求六钱包全部就绪时设置 minReadyWallets=6。
allowPartialWallets=false 要求所有启用条目都填好密钥。
务必核对输出中的 configuredWallets 与跳过列表。

~~~powershell
node multi-mint.mjs check
node multi-mint.mjs prepare
node multi-mint.mjs bench
# 至少提前两分钟启动实盘：
node multi-mint.mjs run --live
~~~

check 不签名，prepare 仅离线签名，bench 仅无效载荷，均不广播有效交易。
.\start-multi.ps1 默认检查，-Live 才实盘。可用 MINT_CONFIG / MULTI_CONFIG 指定本地覆盖文件。

默认单钱包累计预算 0.001 ETH、总预算 0.006 ETH、费用乘数 2、priority fee 0。
首次签名前预留一次同费用上限重试资金；仅确认回滚且当前检查通过后最多重试一次。
六钱包两路产生 12 次首次请求，但仍只有六笔交易；读取、发送各有独立连接池。

详细阶段、参数、WSS 和恢复见 [README.md](README.md)。
官方 feed 默认启用并保留 HTTP 兜底，无需填写 READ_WS_RPC；该变量仅供可选标准 WSS 使用。
双击 04-LOCAL-BENCH.bat 查看本机延迟报告。测速不加载钱包密钥。
