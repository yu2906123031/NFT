# 六钱包 / 多 RPC

此版本是 multi-mint.mjs。单钱包 mint.mjs 和 start.ps1 仍然保留，请勿同时运行同一钱包。
程序不会因为运行检查而启动真实 Mint。

## 已设置

- wallet1–wallet3：clock；wallet4–wallet6：chain。
- 当前八条广播路径：官方排序器、官方 RPC、PublicNode、Pocket、bloXroute、Blockmachine、SolidRPC、dRPC；支持 1–8 条。读取节点为官方 RPC、PublicNode、Pocket。
- config.json 中的 gasLimit=420000、gasPriceMultiplier=4、单钱包预算 0.001 ETH 被继承。
- multi-config.json 的总费用上限为 0.006 ETH，指所有已签交易的最大费用之和。
- prepareSeconds=60：提前签名。约 T-15s 再次检查；T-2.5s 为每个端点预热最多六条连接。
- 两组独立等待；链组只共用一套区块轮询，而非每钱包轮询。读节点与广播节点使用独立连接池。
- 每钱包向全部广播节点发送同一笔交易。六钱包 × 八路径 = 48 次提交，只有六笔交易。
- 首次交易明确回滚后，每钱包最多重试一次：等待链上开售、确认剩余量及钱包资格、nonce 无冲突且当前执行模拟通过后，用下一 nonce 发送。回执未知、pending 或成功但缺少 Mint 事件均不重试。首次与重试的最大费用合计仍受单钱包及总预算限制。

## 填写本机 .ENV

原来的第一把私钥已保留。其余五个位置需要你在本机填写：

~~~dotenv
MINT_PRIVATE_KEY=第一把私钥
MINT_PRIVATE_KEY_2=第二把私钥
MINT_PRIVATE_KEY_3=第三把私钥
MINT_PRIVATE_KEY_4=第四把私钥
MINT_PRIVATE_KEY_5=第五把私钥
MINT_PRIVATE_KEY_6=第六把私钥
~~~

上述是格式示意，不要原样复制覆盖已有密钥。不要把真实私钥发到聊天。
只含一把裸私钥的旧文件仍兼容第一钱包。多钱包需键值格式。
multi-config.json 的 address 可填写对应公开地址来强制校验；null 时从私钥派生并显示地址。
enabled=false 可明确停用该钱包；默认六个均启用，缺任何一个都会禁止实盘。

## 使用

~~~powershell
cd P:\自动脚本\区块链\NFT\robin-mint
node multi-mint.mjs bench
node multi-mint.mjs check
node multi-mint.mjs prepare
~~~

- bench：各端点无效载荷往返延迟，无真实广播，不能代表入块延迟。
- check：逐钱包检查地址、资格、余额、nonce、单笔及总预算；临时覆盖模拟区块时间进行只读 Mint 模拟。
- prepare：所有钱包检查成功后，在本机离线签名验证；只输出哈希，不保存或广播签名交易。
- 缺钱包、模拟失败等返回非零退出码，不能把部分钱包通过当成六钱包就绪。

在钱包及模式都确认后，至少提前两分钟，由你执行：

~~~powershell
node multi-mint.mjs run --live
~~~

或 .\start-multi.ps1 -Live。不加 -Live 的启动脚本只检查。
run 不加 --live 也只读检查。

## 多 RPC 配置

multi-config.json 中：
- broadcastRpcs：最多 8 条 HTTPS 广播路径；不要使用示例地址或未购买的 API key。
- readRpcs：1～3 个支持查询的完整节点，不要把只支持提交的排序器放进来。
- 普通查询按配置顺序故障切换；开售时的链组在所有通过 chainId 检查的读节点中等待首个合格区块。
- 每条 RPC 都要能承受 6 钱包瞬时并发。测通错误响应不等于真实交易一定接收。
- 当前没有真实交易入块测速；不能保证直连排序器比所有服务商都快。

clock 依赖已校准的电脑时钟，可能抢早回滚；chain 多一次区块观察等待。
实际发送的 sendOffsetMs 会记录相对开售时间的延迟；这不是入块时间。
Node 定时器不是硬实时定时器，机器繁忙/休眠/系统校时可能引入延迟。

## 保护与限制

- 检查两次 nonce，禁止有 pending 交易，禁止重复钱包，强制免费、数量 1、chainId 4663。
- 实盘有 multi-run.lock 防止误开两个多钱包进程。异常杀进程后可能残留；确认没有旧进程并查清交易状态后再移除。
- 锁无法阻止其他程序或其他机器使用同一钱包。预签后不要另发交易。
- 使用普通 EOA 私钥，不支持硬件钱包/智能合约钱包代签。
- 模拟基于当前链状态，未来售罄、配置变化或 Gas 大涨仍可能失败。
- 成功回执且有对应 NFT 的 mint Transfer 才报告软确认成功；UNKNOWN 状态须查原哈希。
- 停止程序不能撤回已经广播的交易。程序没有私有优先排序权。


SolidRPC 通过时间覆盖模拟和广播探测；dRPC 普通读取和广播探测通过，但时间覆盖模拟返回 HTTP 400，因此仅加入广播。NodeFlare 返回 HTTP 403，未启用。
