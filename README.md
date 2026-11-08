# luci-app-wol-autowake

**远程连接时自动唤醒** —— 当有人在外部连接某台设备的端口时，如果它不在线，路由器自动发送 WOL 魔术包把它叫起来。

带完整 LuCI 图形界面，**设备数量不限**，按"外部端口"区分设备。

---

## 它解决什么问题

```
手机点「远程桌面」连接 mypc.example.com:3389
        ↓
路由器收到 SYN（电脑关着，无响应）
        ↓
守护进程从防火墙日志看到这次连接尝试（DPT=3389）
        ↓
ping 一下 → 不通 → 发送魔术包
        ↓
电脑开机 → 再点一次 → 连上
```

---

## 安装

### 系统是 apk（OpenWrt 24.10+ / iStoreOS 新固件）

apk v3 的包容器是 **ADB 格式**，不能像 `.ipk` 那样手工构造，官方做法是用 **`apk mkpkg`** 生成。
好消息是：**你路由器上就有 apk**，所以直接在路由器上构建原生 `.apk` 即可。

```sh
# ① 把 tar.gz 传到路由器（在电脑上执行）
scp luci-app-wol-autowake-1.0.0.tar.gz root@192.168.1.1:/tmp/

# ② 解包并安装（在路由器上执行）
tar -xzf /tmp/luci-app-wol-autowake-1.0.0.tar.gz -C /tmp
sh /tmp/luci-app-wol-autowake/install.sh --enable-log
```

安装脚本会：

1. 探测 `apk mkpkg` 是否可用
2. **可用** → 构建原生 `.apk`（`/tmp/luci-app-wol-autowake_1.0.0-r0_<arch>.apk`）并用
   `apk add --allow-untrusted` 安装 —— 包会被**正确登记到 apk 数据库**（升级/卸载都正常）
3. **不可用** → 退化为直接拷贝文件安装
4. 装 `etherwake` 依赖、启用服务、清 LuCI 缓存

先确认一下你的 apk 是否带 `mkpkg`：

```sh
apk mkpkg --help 2>&1 | head -3
```

| 结果 | 说明 |
|---|---|
| 打印出用法 | ✅ 会构建原生 `.apk` |
| `unrecognized command` / 报错 | 走直接拷贝安装（功能一样，只是不登记到 apk 数据库） |

**只构建不安装**：

```sh
sh /tmp/luci-app-wol-autowake/install.sh --build-only
# 之后手动: apk add --allow-untrusted /tmp/luci-app-wol-autowake_1.0.0-r0_*.apk
```

### 系统是 opkg（OpenWrt 23.05 及更早）

```sh
opkg install /tmp/luci-app-wol-autowake_1.0.0-1_all.ipk
```

也可以走 **iStoreOS → iStore → 手动安装**，选择 `.ipk`。

### 其他参数

| 参数 | 作用 |
|---|---|
| `--enable-log` | 给所有端口转发规则打开日志（**自动唤醒的触发来源**，建议加） |
| `--force-config` | 覆盖已有的 `/etc/config/wol_autowake` |
| `--build-only` | 只构建 `.apk`，不安装 |
| `--no-apk` | 跳过 `apk mkpkg`，直接拷文件 |

---

## 使用

### 图形界面

**LuCI → 服务 → 自动唤醒** —— **单页**：

```
┌─ 自动唤醒（结论 + 分组）──────────────────────────────┐
│  ● 就绪                                              │
│  服务   运行中 · 设备 1 台（在线 1）                    │
│  依赖   etherwake 已装                                │
│  触发   转发日志已全部开启     ← 最容易静默失效的一环     │
│  参数   接口 br-lan · 节流 60 秒 · 日志监听 开          │
│  [全部唤醒] [立即清理日志]                             │
├─ 设备列表：配置 + 状态 合并成一张表（只有 6 列，很紧凑）──┤
│  启用 │ 名称       │ 外部端口     │ 在线 │ 端口转发      │ 操作 │
│   ☑  │ 我的电脑 │  3389      │ 在线 │ 已启用       │[唤醒]│
│                                                       │
│  「编辑」弹窗里：内网 IP / MAC / 启用转发 / 内网端口 / 转发协议 │
├─ 全局设置（含 [重启服务]）────────────────────────────┤
│  启用服务 / 发包接口 / 每设备节流 / 监听防火墙日志         │
├─ 系统日志清理 ───────────────────────────────────────┤
│  启用定期清理 / 检查间隔 / 日志阈值   [立即清理一次]       │
├─ 最近唤醒记录（默认展开，10 秒刷新）───────────────────┤
├───────────────────────────────────────────────────────┤
│  [保存并应用]  ← 保存后自动同步到防火墙设置               │
└───────────────────────────────────────────────────────┘
```

**「就绪」怎么判定**（三项全绿）：服务在跑 ✓ · etherwake 装了 ✓ · **所有启用了转发的设备，规则都存在且日志开着** ✓

**布局取舍（五轮实际使用反馈）**：

| 反馈 | 处理 |
|---|---|
| 设备页列太多被挤爆 | 表格只留 **4 列**（v1.2） |
| 三个页面拆得太碎 | **合并成一页**（v1.2） |
| 状态表格不对齐 | 状态列用 **flex + 定宽**（v1.2） |
| 转发设置散在状态区 | 移进**设备表单**，保存自动同步（v1.3） |
| 状态和设备列表是两批一样的数据 | **合并成一张表**（v1.4） |
| 日志每次要手动展开 / 重启服务混在状态区 | 日志**默认展开**；重启移到**全局设置**（v1.4） |
| 状态信息太潦草、看不出能不能用 | 改成 **「结论 + 分组」**，并标出「触发」这一关键项（v1.5） |
| 「同步转发配置」按钮让人以为要手动点 | **删掉** —— 保存时本来就自动同步（v1.5） |
| 转发模式三态太绕 | 简化成 **两态**：`启用转发` 开关（v1.5） |
| 「给所有端口开日志」不该让人记得点 | **改成全自动**：同步时对所有相关规则补齐日志（v1.5） |
| **设备列表还是太宽**（v1.5.1） | 三处下手：<br>① **减列** —— 内网 IP 收进弹窗（「在线」列已能说明可达性）<br>② **状态列渲染成纯文本** —— 不再用只读输入框（输入框默认很宽）<br>③ **输入框设死宽度**（名称 150px / 端口 72px）+ **压缩表格内边距**（作用域限定本页） |

### 命令行

```sh
wol-wake                 # 列出所有设备及在线状态
wol-wake 3389           # 按外部端口唤醒
wol-wake aa:bb:cc:dd:ee:ff   # 按 MAC 唤醒
wol-wake "我的电脑"    # 按名称唤醒
wol-wake --all           # 唤醒全部
```

### 服务管理

```sh
/etc/init.d/wol-autowake start | stop | restart | enable | disable
logread | grep -i wol-autowake | tail -20
```

---

## 配置参考（/etc/config/wol_autowake）

```
config settings 'settings'
	option enabled '1'          # 总开关
	option iface 'br-lan'       # 魔术包从哪个接口发出
	option throttle '60'        # 每设备节流（秒）
	option logread '1'          # 是否监听防火墙日志（触发来源）

config device 'pc1'
	option name '我的电脑'
	option enabled '1'
	option port '3389'         # 外部端口 —— 设备的触发标识
	option mac 'aa:bb:cc:dd:ee:ff'
	option ip '192.168.1.10'     # ping 判断在线用；创建转发时作目标地址
	option dest_port '3389'      # 内网端口：创建转发用，留空 = 与 port 相同
	option proto 'tcp'           # 协议：tcp / udp / "tcp udp"
	option manage_fw '0'         # 是否允许界面创建/关闭转发（默认关，更安全）
```

---

## 关键前提：端口转发规则必须打开日志（**v1.5 起已全自动**）

自动唤醒靠"防火墙日志里出现 `DPT=<端口>`"来触发，所以每台设备的**端口转发规则**都必须开日志。

**v1.5 起不需要你操心** —— 保存设备时 `sync` 会**自动给所有相关规则补齐日志**（`log=1` + `log_limit=2/minute`），
包括你手工创建的规则（只加日志，不开放任何东西）。

状态区那一行的「触发」会告诉你是否 OK：

```
触发   转发日志已全部开启        ← 绿 = 就绪
触发   有 1 台设备的转发规则缺日志 —— 自动唤醒不会触发   ← 红 = 要处理
```

**为什么会缺日志**（唯一的例外情况）：设备配置改了但**还没保存**，或者你刚手工建了规则还没同步过 →
**保存一次就自动修好** ✓

**手动检查/修补**（一般用不到）：

```sh
# 看哪些规则没开日志
uci show firewall | grep -E 'src_dport|\.log='

# 一次性全补上（幂等）
curl "http://192.168.1.1/cgi-bin/wol-ctl?q=sync"
```

---

## 端口转发管理（在设备设置里，集中配置）

**转发是设备的一个字段** —— 全部设置都在「设备列表」每行的**编辑弹窗**里：

| 字段 | UCI 键 | 作用 |
|---|---|---|
| **启用转发** | `fw_enabled` | **默认关**。关 = 规则仍会写进防火墙，但保持停用；开 = 规则生效 |
| **内网端口** | `dest_port` | 转发目标端口，留空 = 与外部端口相同（留空 = 与外部端口相同） |
| **转发协议** | `proto` | `TCP` / `UDP` / `TCP + UDP` |

### 只有两态：启不启用由你决定

| 状态 | 防火墙里发生什么 |
|---|---|
| **关**（默认） | 规则**写进防火墙配置但 `enabled=0`** —— 清单里能看到、能核对，**不开放任何端口** |
| **开** | 规则写进防火墙并生效 |

> **推荐流程**：先保持「关」→ 保存 → 去 `网络 → 防火墙 → 端口转发` 核对一遍 →
> 确认无误再打开「启用转发」→ 保存。**先配置、后启用**，不会一下子把端口暴露出去。

**保存时自动完成三件事**（`m.save` 挂钩 → `wol-ctl?q=sync`）：

1. **保证规则存在**（新建 / 更新为目标 IP、端口、协议）
2. **自动补齐日志**（`log=1` + `log_limit=2/minute`）—— 这是自动唤醒的触发来源，**不需要你手动开**
3. **应用启用状态**（`enabled` 按你那个开关设置）

> ⚠️ 第 2 条对**你手工建的规则**也会生效（只加日志，不开放任何东西）。
> 这是刻意的：自动唤醒**依赖**日志，漏开就会静默失效 —— 这是最容易踩的坑。

### 设备列表的「端口转发」列（只读）

| 显示 | 含义 |
|---|---|
| 🟢 **已启用** | 规则生效 + 日志已开 → 自动唤醒就绪 |
| 🟠 **已启用·缺日志** | ⚠️ 自动唤醒不会触发（正常情况下不该出现，因为保存时已自动补） |
| ⚪ **已写入·停用** | 规则存在但没启用（默认状态，符合预期） |
| 🔴 **待同步** | 规则还没写进防火墙 → 保存一次即可 |

### 手动方式（等价于界面操作）

```sh
# 把设备配置同步到防火墙设置（幂等；保存时界面会自动调用，一般不用手点）
curl "http://192.168.1.1/cgi-bin/wol-ctl?q=sync"
```

### 🔒 安全设计

| 措施 | 说明 |
|---|---|
| **默认「不启用」** | 规则可以预先写好，但**不开放端口**；启用是你显式决定的 |
| **enabled 只改自己的规则** | 名字以 `WOLAUTO-` 开头的才会被改启用状态；你手工建的规则**不会**被擅自启用/停用 |
| **自动补日志是安全的** | 只是打开日志开关（`log=1`），不开放任何流量 |
| **CGI 只暴露幂等动作** | `sync` 完全以 UCI 配置为准（重复调用结果相同，**不能凭空开端口**）；v1.2 的 `addfw`/`delfw` 已移除 |

---

## 系统日志清理

**为什么需要**：自动唤醒靠"防火墙日志里出现 `DPT=<端口>`"触发，所以转发规则必须开日志。
而防火墙日志写进的是**系统日志**（logd 的环形缓冲 / 可选的日志文件），
**应用没法只清掉自己那部分** ✗ —— 所以这里做整体兜底。

### 两层防护

| 层 | 措施 | 说明 |
|---|---|---|
| **① 源头控量** | 规则上的 `log_limit = 2/minute` | 应用每台设备 60 秒才唤醒一次，2/分钟完全够用 |
| **② 定期兜底** | `wol-logclean`（默认每 6 小时检查） | 日志写文件 → 超阈值截断（保护 flash）；<br>内存环形缓冲 → 超阈值重启 logd 清空 |

### 配置（全局设置 → 系统日志清理）

| 字段 | UCI 键 | 默认 |
|---|---|---|
| 启用定期清理 | `logclean_enabled` | `1` |
| 检查间隔（小时） | `logclean_interval` | `6` |
| 日志阈值（KB） | `logclean_maxkb` | `256` |

**实现方式**：安装时往 `/etc/crontabs/root` 写一行（每小时 `17` 分调用 `wol-logclean`），
脚本内部再按 `logclean_interval` 节流 —— 这样**改间隔不用重写 crontab** ✓

```sh
# 立即清理一次（忽略节流）
curl "http://192.168.1.1/cgi-bin/wol-ctl?q=logclean"
```

> ⚠️ **清理是整体的** —— 会连其他服务的日志一起清掉。
> 阈值默认 256KB，而 OpenWrt 默认环形缓冲只有 64KB，所以**正常情况下几乎不会触发**，
> 它更像是"日志失控时的保险丝"。

---

## 加一台新设备（3 步）

> 💡 **如果设备的「端口转发」模式选了「配置好，先停用」或「启用转发」，第 ① 步可以省掉** ——
> 在「设备」页加完设备后，去「状态与日志」页点它的「创建转发」即可（会自动带上日志开关）。

**① 加端口转发规则**（每台设备一个外部端口）

```sh
uci add firewall redirect
uci set firewall.@redirect[-1].name='RDP-IPv4-3389'
uci set firewall.@redirect[-1].target='DNAT'
uci set firewall.@redirect[-1].src='wan'
uci set firewall.@redirect[-1].src_dport='3389'
uci set firewall.@redirect[-1].dest='lan'
uci set firewall.@redirect[-1].dest_ip='192.168.1.11'
uci set firewall.@redirect[-1].dest_port='3389'
uci set firewall.@redirect[-1].proto='tcp'
uci set firewall.@redirect[-1].log='1'
uci set firewall.@redirect[-1].log_limit='6/minute'
uci commit firewall && /etc/init.d/firewall restart
```

**② 加设备**（LuCI 界面点"添加"，或命令行）

```sh
uci add wol_autowake device
uci set wol_autowake.@device[-1].name='NAS'
uci set wol_autowake.@device[-1].port='3389'
uci set wol_autowake.@device[-1].mac='aa:bb:cc:dd:ee:ff'
uci set wol_autowake.@device[-1].ip='192.168.1.11'
uci commit wol_autowake
```

**③ 重启服务**

```sh
/etc/init.d/wol-autowake restart
```

> LuCI 界面里改完配置会自动重启服务，命令行方式需要手动执行第 ③ 步。

---

## 排查

| 现象 | 检查 |
|---|---|
| 状态页显示"未运行" | `logread \| grep wol-autowake` 看退出原因 |
| 有连接但没触发 | 端口转发规则的**日志**没打开（`uci show firewall \| grep log`） |
| 触发了但没唤醒 | `command -v etherwake` 是否装了；电脑本身的 WOL 是否可用 |
| 唤醒成功但连不上 | 正常现象 —— 开机要 20~40 秒，**再点一次**即可。若电脑改成"睡眠"，唤醒只要 2~3 秒，客户端会自动重传 SYN，体验无缝 |
| LuCI 菜单里看不到 | `rm -f /tmp/luci-indexcache; /etc/init.d/rpcd restart; /etc/init.d/uhttpd restart` |

**手动验证链路**：

```sh
wol-wake 3389                      # 手动发包，确认电脑能被叫醒
logread | grep 'DPT=3389' | tail   # 确认防火墙日志有输出
```

---

## 安全说明

- 唤醒**不开放任何服务**，最坏情况是被"恶意开机"骚扰
- 已有防护：每设备 60 秒节流 + 防火墙日志限速（`log_limit 2/minute`）
- 如果连"被唤醒"都不想被外人触发，可以把触发端口改成非常用端口，或只在 Tailscale 内暴露

---

## 文件清单

```
root/etc/config/wol_autowake                           UCI 默认配置
root/etc/init.d/wol-autowake                           procd 服务
root/usr/libexec/wol-autowake.sh                       守护进程（读 UCI）
root/usr/libexec/wol-fw.sh                             防火墙转发操作公共库
root/usr/bin/wol-wake                                  手动唤醒 CLI
root/usr/bin/wol-status                                状态 JSON（供界面读取）
root/usr/bin/wol-logclean                              系统日志定期清理（cron 每小时调用）
root/www/cgi-bin/wol-status                            CGI：状态
root/www/cgi-bin/wol-ctl                               CGI：动作（wake/sync/logclean/...）
root/www/luci-static/resources/view/wol-autowake/main.js   LuCI 单页界面
root/usr/share/luci/menu.d/luci-app-wol-autowake.json  菜单（单入口）
root/usr/share/rpcd/acl.d/luci-app-wol-autowake.json   ACL 权限
root/usr/lib/lua/luci/...                              Lua 降级版（JS 菜单不存在时才启用）
install.sh                                             通用安装脚本
build-paste-install.py                                 从 root/ 生成粘贴安装脚本
build-ipk.py                                           无 SDK 手工打 .ipk（opkg 系统用）
Makefile                                               SDK 构建用
```

## 构建

```sh
python3 build-ipk.py          # 生成 .ipk 和 .tar.gz
python3 build-ipk.py --list   # 只看会打包哪些文件
```

---

> ### ⚠️ 建议更换默认端口
>
> 上面的示例都用了 **3389**（远程桌面标准端口），因为这是最常见、最好理解的场景。
>
> 但 **3389 是全网扫描最密集的端口之一**。如果直接把 3389 暴露到公网：
>
> - 会收到大量爆破尝试（每秒几十次很常见）
> - 就算有本插件的「忽略国外 IP + 扫描器黑名单」挡着，日志也会被刷爆
>
> **建议把它换成一个高位端口**，比如 `21389`、`32412` 这类不常见的值，然后在
> 路由器的**端口转发**里做 `外部高位端口 → 内网 3389` 的映射：
>
> ```
> 手机连  mypc.example.com:21389
>    → 路由器把 21389 转到 192.168.1.10:3389
> ```
>
> 这样既能正常用远程桌面，又能把绝大部分扫描挡在门外。

---

## 联系方式

- **邮箱**：**msrjcl@163.com**

有问题、建议或 bug 反馈，欢迎邮件联系。

也可以在 GitHub 上直接提 [Issue](https://github.com/MOMOSOFAT/luci-app-wol-autowake/issues)，这样别人也能看到你的问题。
