#!/bin/sh
# ==============================================================================
# wol-autowake.sh  --  监听防火墙日志，有人尝试连接某台设备时自动发魔术包唤醒
# 配置来自 UCI: /etc/config/wol_autowake
#
# 注意: 设备名允许含空格，所以【不能】把设备拼成空格分隔的字符串，
#       必须用 config_foreach 直接遍历（本文件就是这么做的）。
#
# 日志（v3.1 起）:
#   系统日志   logger -t wol-autowake        -> 会被 logread 环形缓冲挤掉
#   持久日志   /root/wol-autowake.log         -> 重启不丢，超过 512KB 自动截断
#   持久日志只记【关键事件】：启动/退出/唤醒决策/发送结果/来源 IP
#   （不记"节流跳过""已在线跳过"，避免被扫描噪音灌满）
# ==============================================================================

. /lib/functions.sh

IFACE="br-lan"
THROTTLE="60"
DO_LOGREAD="1"
STATE_DIR="/tmp"

LOG_FILE="/root/wol-autowake.log"
LOG_MAX=524288        # 512 KB
LOG_KEEP=2000         # 截断后保留最后多少行

# 系统日志（会滚动丢失）
log() { logger -t wol-autowake "$*"; echo "[$(date '+%H:%M:%S')] $*"; }

# 持久日志：只写文件，带日期和体积保护
plog() {
	printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE" 2>/dev/null
	_sz=$(wc -c <"$LOG_FILE" 2>/dev/null)
	if [ -n "$_sz" ] && [ "$_sz" -gt "$LOG_MAX" ]; then
		tail -n "$LOG_KEEP" "$LOG_FILE" >"$LOG_FILE.tmp" 2>/dev/null &&
			mv "$LOG_FILE.tmp" "$LOG_FILE" 2>/dev/null
	fi
	return 0
}

# 关键事件：同时写系统日志和持久日志
logi() { log "$*"; plog "$*"; }

is_up() { ping -c 1 -W 1 "$1" >/dev/null 2>&1; }

# 判断来源 IP 是否"可以唤醒"（v4 查 wol_cn4，v6 查 wol_cn6）
#   ★ 内网/回环地址直接视为可信：自己家里的设备走公网回环访问时，
#     来源会显示成 192.168.x.x，这些地址永远不在国内表里，
#     不特殊处理就会被判成"国外"而永远唤不醒。
#   ★ 只用本地 ipset（数据来自 OpenClash 的数据文件，由 wol-cnlist 灌入）
#   ★ 不使用 OpenClash 的 nft 集合 —— 那个只在 OpenClash 运行时存在，
#     而本功能必须在 OpenClash 关闭时也能工作。
is_cn() {
	local ip="$1"
	[ -n "$ip" ] || return 1

	# 私有 / 回环地址 -> 直接放行
	case "$ip" in
		10.*|192.168.*|127.*)
			return 0 ;;
		172.1[6-9].*|172.2[0-9].*|172.3[01].*)
			return 0 ;;
		*:*)
			case "$ip" in
				fc*|fd*)   return 0 ;;   # ULA
				fe8*|fe9*|fea*|feb*) return 0 ;;   # 链路本地 fe80::/10
				::1)       return 0 ;;   # 回环
			esac
			ipset test wol_cn6 "$ip" >/dev/null 2>&1
			;;
		*)
			ipset test wol_cn4 "$ip" >/dev/null 2>&1
			;;
	esac
}

# 从日志行里提取来源 IP
line_src() { printf '%s' "$1" | sed -n 's/.*SRC=\([0-9a-fA-F.:]*\).*/\1/p'; }

wake_dev() {
	local name="$1" mac="$2" ip="$3" src="$4" dpt="$5"
	local res="成功"
	etherwake -b -i "$IFACE" "$mac" >/dev/null 2>&1 || res="失败"
	logi "唤醒 [$name] 设备离线 -> 已发魔术包($res)  MAC=$mac 端口=$dpt 来源=${src:-未知}"
}

# config_foreach 会以 $1=section, $2=额外参数 调用本函数
check_dev() {
	local s="$1" line="$2"
	local port mac ip name en safe now last src

	config_get port "$s" port
	config_get mac  "$s" mac
	config_get ip   "$s" ip
	config_get name "$s" name
	config_get_bool en "$s" enabled 1

	[ "$en" = "1" ] || return 0
	[ -n "$port" ] && [ -n "$mac" ] && [ -n "$ip" ] || return 0

	# 精确匹配 DPT=<port>（要求前后有空格或行尾），避免前缀误匹配
	echo "$line" | grep -qE "DPT=${port}([^0-9]|$)" || return 0

	src=$(line_src "$line")

	# ---- 来源过滤（放在节流之前：被忽略的连接不消耗节流额度）----

	# ⓪ 白名单（优先级最高）：命中就【无条件唤醒】，跳过下面所有过滤
	WL_HIT=0
	if [ "$WL_OK" = "1" ] && [ -n "$src" ] && in_whitelist "$src"; then
		WL_HIT=1
	fi

	# ① 手动黑名单（优先级最高，配了就一直生效，不受其他开关影响）
	if [ "$WL_HIT" = "0" ] && [ "$BL_OK" = "1" ] && [ -n "$src" ] && in_blacklist "$src"; then
		plog "忽略 [$name] 来源=$src（在手动黑名单中）"
		return 0
	fi

	# ② IPv6 一律忽略（白名单命中则跳过）
	if [ "$WL_HIT" = "0" ] && [ "$IGNORE_IPV6" = "1" ]; then
		case "$src" in
			*:*)
				plog "忽略 [$name] 来源=$src（IPv6，不唤醒）"
				return 0
				;;
		esac
	fi

	if [ "$WL_HIT" = "0" ] && [ "$IGNORE_FOREIGN" = "1" ] && [ -n "$src" ]; then
		case "$src" in
			*:*)
				# IPv6 用 IPv6 国内表判断；没有 v6 表时不判断（交给 ignore_ipv6）
				if [ "$CN6_OK" = "1" ] && ! is_cn "$src"; then
					plog "忽略 [$name] 来源=$src（非中国大陆 IPv6，不唤醒）"
					return 0
				fi
				;;
			*)
				if [ "$CN_OK" = "1" ] && ! is_cn "$src"; then
					plog "忽略 [$name] 来源=$src（非中国大陆，不唤醒）"
					return 0
				fi
				;;
		esac
	fi

	# 每设备节流（跳过时不写持久日志，避免被扫描噪音灌满）
	safe=$(echo "$mac" | tr -d ':' | tr 'A-Z' 'a-z')
	now=$(date +%s)
	last=$(cat "$STATE_DIR/wol-$safe.ts" 2>/dev/null || echo 0)
	[ $((now - last)) -lt "$THROTTLE" ] && return 0
	echo "$now" > "$STATE_DIR/wol-$safe.ts"

	# 已在线就不打扰
	is_up "$ip" && return 0

	if [ "$WL_HIT" = "1" ]; then
		wake_dev "${name:-$mac}（白名单）" "$mac" "$ip" "$src" "$port"
	else
		wake_dev "${name:-$mac}" "$mac" "$ip" "$src" "$port"
	fi
}

handle_line() {
	local line="$1"
	case "$line" in *DPT=*) ;; *) return 0 ;; esac
	config_foreach check_dev device "$line"
	return 0
}

# ---------------- 清理历史残留实例 ----------------
# procd 终止主进程时，管道里的子 shell 可能存活下来变成孤儿（进程数会一直涨）。
# 这里让新实例启动时把老实例清掉，实现自愈。
SELF=$$
for p in $(pgrep -f '[w]ol-autowake.sh' 2>/dev/null); do
	[ "$p" = "$SELF" ] && continue
	kill "$p" 2>/dev/null
done

# ---------------- 装载配置 ----------------
config_load wol_autowake
config_get IFACE settings iface "br-lan"
config_get THROTTLE settings throttle "60"
config_get_bool DO_LOGREAD settings logread 1

# 来源过滤
config_get_bool IGNORE_FOREIGN settings ignore_foreign 0
config_get_bool IGNORE_IPV6    settings ignore_ipv6 1
config_get_bool BL_PRESET      settings blacklist_preset 1
config_get      BLACKLIST      settings blacklist ''
config_get      WHITELIST      settings whitelist ''
CN_OK=0
CN6_OK=0
BL_OK=0
WL_OK=0
WL_HIT=0

DEVCOUNT=0
count_dev() { DEVCOUNT=$((DEVCOUNT + 1)); }
config_foreach count_dev device

# ---- 国内常见扫描器网段预设（可在设置里关掉）----
#   都是日志里实证过的扫描/爆破来源，按 /24 粒度收窄，尽量不误伤普通宽带用户。
#   注意：如果你自己远程访问时用的是云服务器出口，可能会被这些段挡住 ——
#         那就把这个开关关掉，或者把具体 IP 从黑名单里删掉。
BLACKLIST_PRESET="
47.111.94.0/24 139.224.0.0/24 47.96.0.0/24 47.98.0.0/24
106.14.0.0/24 120.24.0.0/24 116.62.0.0/24 121.40.0.0/24
113.200.2.0/24
81.68.0.0/24 129.28.0.0/24 119.29.29.0/24 1.12.0.0/24
49.232.0.0/24 122.152.0.0/24 140.143.0.0/24 175.24.0.0/24
"

# ---- 黑名单：手动 + （可选）国内扫描器预设，命中即忽略（优先级最高）----
build_blacklist() {
	local all="$BLACKLIST"
	if [ "$BL_PRESET" = "1" ]; then
		all="$all $BLACKLIST_PRESET"
	fi

	[ -n "$(printf '%s' "$all" | tr -d ' \t\n')" ] || {
		ipset destroy wol_bl4 2>/dev/null
		return 0
	}
	command -v ipset >/dev/null 2>&1 || return 1

	ipset destroy wol_bl4 2>/dev/null
	ipset create wol_bl4 hash:net family inet hashsize 1024 maxelem 8192 2>/dev/null || return 1

	printf '%s\n' "$all" | tr ' ,;' '\n\n\n' \
		| sed -e 's/[[:space:]]//g' \
		| grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]+)?$' \
		| sed 's/^/add wol_bl4 /' > /tmp/wol-bl4.restore 2>/dev/null

	[ -s /tmp/wol-bl4.restore ] && ipset restore -exist < /tmp/wol-bl4.restore 2>/dev/null
	rm -f /tmp/wol-bl4.restore

	local n
	n=$(ipset list wol_bl4 2>/dev/null | sed -n 's/^Number of entries: //p')
	if [ "$BL_PRESET" = "1" ]; then
		logi "黑名单已加载: ${n:-0} 条（含国内扫描器预设）"
	else
		logi "黑名单已加载: ${n:-0} 条（仅手动）"
	fi
	return 0
}

# 判断来源是否在手动黑名单里
in_blacklist() {
	local ip="$1"
	[ -n "$ip" ] || return 1
	ipset test wol_bl4 "$ip" >/dev/null 2>&1
}

# ---- 白名单：命中就无条件唤醒，跳过所有过滤（优先级最高）----
#   典型用途：把你自己的云服务器 / 公司出口 IP 填进来，
#   这样即使它落在预设黑名单或国外 IP 段里，也照样能唤醒。
build_whitelist() {
	[ -n "$WHITELIST" ] || {
		ipset destroy wol_wl4 2>/dev/null
		return 0
	}
	command -v ipset >/dev/null 2>&1 || return 1

	ipset destroy wol_wl4 2>/dev/null
	ipset create wol_wl4 hash:net family inet hashsize 512 maxelem 2048 2>/dev/null || return 1

	printf '%s\n' "$WHITELIST" | tr ' ,;' '\n\n\n' \
		| sed -e 's/[[:space:]]//g' \
		| grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]+)?$' \
		| sed 's/^/add wol_wl4 /' > /tmp/wol-wl4.restore 2>/dev/null

	[ -s /tmp/wol-wl4.restore ] && ipset restore -exist < /tmp/wol-wl4.restore 2>/dev/null
	rm -f /tmp/wol-wl4.restore

	local n
	n=$(ipset list wol_wl4 2>/dev/null | sed -n 's/^Number of entries: //p')
	logi "白名单已加载: ${n:-0} 条（命中则无条件唤醒）"
	return 0
}

in_whitelist() {
	local ip="$1"
	[ -n "$ip" ] || return 1
	ipset test wol_wl4 "$ip" >/dev/null 2>&1
}

# 检查过滤所需的 ipset 是否就绪（缺失时 fail-open：不过滤，但要警告）
if [ "$IGNORE_FOREIGN" = "1" ]; then
	# 先尝试按需构建（数据取自 OpenClash 的数据文件，与 OpenClash 是否运行无关）
	[ -x /usr/bin/wol-cnlist ] && /usr/bin/wol-cnlist ensure >/dev/null 2>&1

	if ipset list -n 2>/dev/null | grep -qx wol_cn4; then
		CN_OK=1
	else
		logi "警告: ignore_foreign=1 但 ipset wol_cn4 不可用，IPv4 国内过滤不生效（到界面点『重建国内IP表』）"
	fi

	if ipset list -n 2>/dev/null | grep -qx wol_cn6; then
		CN6_OK=1
	else
		logi "提示: ipset wol_cn6 不可用，IPv6 来源不做国内判断（交给『忽略 IPv6 来源』开关）"
	fi
fi

# 黑名单独立于"忽略国外"开关：配了就一直生效；清空了要把旧集合删掉
#   （预设黑名单也算"配了"，所以只要 BL_PRESET=1 就要建）
if [ -n "$BLACKLIST" ] || [ "$BL_PRESET" = "1" ]; then
	build_blacklist && BL_OK=1
	if [ "$BL_OK" != "1" ]; then
		logi "警告: 黑名单配置了但加载失败（检查格式，或 ipset 不可用）"
	fi
else
	# 黑名单被清空 -> 删除旧集合，避免残留的条目继续生效
	ipset destroy wol_bl4 2>/dev/null
fi

# 白名单：配了才建，清空就删
if [ -n "$WHITELIST" ]; then
	build_whitelist && WL_OK=1
else
	ipset destroy wol_wl4 2>/dev/null
fi

# 后台维护"在线状态"缓存：界面的 CGI 只读它，永远不用等 ping（否则每次请求卡 1 秒）
config_get SCAN_SEC settings scan_interval "10"
case "$SCAN_SEC" in ''|*[!0-9]*) SCAN_SEC=10 ;; esac
[ "$SCAN_SEC" -lt 5 ] && SCAN_SEC=5

config_get SCAN_MODE settings scan_mode "ping"

(
	while true; do
		/usr/bin/wol-online-scan >/dev/null 2>&1
		sleep "$SCAN_SEC"
	done
) &

log "在线状态扫描已启动（每 ${SCAN_SEC} 秒，模式=${SCAN_MODE}）"
logi "服务启动: 接口=$IFACE 节流=${THROTTLE}s 设备数=$DEVCOUNT 扫描模式=$SCAN_MODE 扫描间隔=${SCAN_SEC}s"
if [ "$IGNORE_FOREIGN" = "1" ] || [ "$IGNORE_IPV6" = "1" ]; then
	logi "来源过滤: 忽略国外=$([ "$IGNORE_FOREIGN" = "1" ] && echo 开 || echo 关)($( [ "$CN_OK" = "1" ] && echo 就绪 || echo 未就绪 )) 忽略IPv6=$([ "$IGNORE_IPV6" = "1" ] && echo 开 || echo 关)"
fi

if [ "$DO_LOGREAD" != "1" ]; then
	logi "配置中已关闭日志监听，退出（只剩手动唤醒）"
	exit 0
fi

if ! command -v etherwake >/dev/null 2>&1; then
	logi "警告: 未安装 etherwake，唤醒会失败"
fi

logread -f 2>/dev/null | while read -r line; do
	handle_line "$line"
done
