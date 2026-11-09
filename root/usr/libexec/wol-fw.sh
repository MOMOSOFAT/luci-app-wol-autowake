#!/bin/sh
# ==============================================================================
#  wol-fw.sh  --  防火墙端口转发的公共辅助函数
#
#  被 wol-status / wol-ctl / wol-logclean 共用（. /usr/libexec/wol-fw.sh）
#
#  设计约定（v1.6）:
#    · 本应用创建的规则名字统一：
#        IPv4 端口转发   WOLAUTO-<外部端口>
#        IPv6 放行       WOLAUTO-<外部端口>-V6
#      便于和手工建的规则区分，也便于一键清理
#    · 查找规则按【外部端口】匹配（这是设备的触发标识）
#    · 保存设备时【总是】保证 IPv4 规则存在（默认停用），用户只决定"启不启用"
#    · IPv6 放行由设备的 ipv6_allow 决定：开就建并启用，关就删（只删本应用建的）
#    · 日志【自动补齐】：无论规则是谁建的，都保证 log=1（这是自动唤醒的触发来源）
#        —— IPv4 走 redirect 的日志，IPv6 走 rule 的日志，两条都能触发唤醒
#    · 所有"写"函数只做 uci set/delete + commit，【不 reload】
#      reload 由调用方统一执行一次
# ==============================================================================

FW_PREFIX="WOLAUTO"
FW_LOGLIMIT="2/minute"     # 防火墙日志限速：应用每设备 60 秒才唤醒一次，2/分钟足够

# ---- 列出所有 redirect 的 section 名 ----
#      结果缓存在 FW_SECTIONS_CACHE 里：同一个脚本里多次查规则时只 dump 一次防火墙配置
#      （以前 wol-status 是"每台设备 dump 一次"，白白多花几十毫秒）
fw_sections() {
	if [ -z "$FW_SECTIONS_CACHE" ]; then
		FW_SECTIONS_CACHE=$(uci show firewall 2>/dev/null \
			| sed -n 's/^firewall\.\(@redirect\[[0-9]*\]\)\..*=.*/\1/p' \
			| sort -u)
	fi
	printf '%s\n' "$FW_SECTIONS_CACHE"
}

# ---- 按外部端口找规则，输出 section 名 ----
fw_find_by_port() {
	local s
	[ -z "$1" ] && return 1
	for s in $(fw_sections); do
		[ "$(uci get "firewall.$s.src_dport" 2>/dev/null)" = "$1" ] && { echo "$s"; return 0; }
	done
	return 1
}

fw_has_log() { [ "$(uci get "firewall.$1.log" 2>/dev/null)" = "1" ]; }

fw_is_enabled() {
	case "$(uci get "firewall.$1.enabled" 2>/dev/null)" in
		0|no|off|false|NO|OFF|FALSE) return 1 ;;
		*) return 0 ;;
	esac
}

fw_is_ours() {
	case "$(uci get "firewall.$1.name" 2>/dev/null)" in
		${FW_PREFIX}-*) return 0 ;;
		*) return 1 ;;
	esac
}

# ---- 补齐日志设置（对任何规则都做，只加日志、不开放端口）----
# $1 = section
fw_ensure_log() {
	local changed=0
	if ! fw_has_log "$1"; then
		uci set "firewall.$1.log=1"
		changed=1
	fi
	if [ "$(uci get "firewall.$1.log_limit" 2>/dev/null)" != "$FW_LOGLIMIT" ]; then
		uci set "firewall.$1.log_limit=$FW_LOGLIMIT"
		changed=1
	fi
	return $changed
}

# ---- 确保转发规则存在 + 日志补齐 ----
# $1=外部端口 $2=内网IP $3=内网端口 $4=协议 $5=启用(0/1，只对自建规则生效) $6=名称
# 输出: "<created 0|1>|<section>|<ours 0|1>|<enabled 0|1>"
fw_ensure() {
	local port="$1" ip="$2" dport="$3" proto="$4" en="$5" name="$6" sec created=0 ours=0 nowen=0

	[ -n "$port" ] && [ -n "$ip" ] || return 1
	# 内网端口留空 -> 默认 3389（远程桌面标准端口）。服务端口与外部端口不同时才需要填。
	[ -n "$dport" ] || dport=3389
	[ -n "$proto" ] || proto="tcp"
	[ -n "$en" ]    || en=0
	[ -n "$name" ]  || name="${FW_PREFIX}-$port"

	sec=$(fw_find_by_port "$port")
	if [ -z "$sec" ]; then
		sec=$(uci add firewall redirect 2>/dev/null) || return 1
		[ -n "$sec" ] || return 1
		created=1
		FW_SECTIONS_CACHE=""          # 新建了规则 -> 让 section 缓存失效
		uci set "firewall.$sec.name=$name"
		uci set "firewall.$sec.target=DNAT"
		uci set "firewall.$sec.src=wan"
		uci set "firewall.$sec.src_dport=$port"
		uci set "firewall.$sec.dest=lan"
		uci set "firewall.$sec.dest_ip=$ip"
		uci set "firewall.$sec.dest_port=$dport"
		uci set "firewall.$sec.proto=$proto"
		uci set "firewall.$sec.enabled=$en"
	fi

	# 规则名统一成 WOLAUTO-<外部端口>：新建的和已有的都一致，
	# 这样在「网络 - 防火墙 - 端口转发」里一眼能认出哪些是本应用管的
	local want_name="${FW_PREFIX}-${port}"
	if [ "$(uci get "firewall.$sec.name" 2>/dev/null)" != "$want_name" ]; then
		uci set "firewall.$sec.name=$want_name"
	fi

	# 日志：无论谁建的规则，一律补齐（自动唤醒的触发来源）
	fw_ensure_log "$sec"

	# enabled：所有匹配该端口的规则都按设备的「启用转发」来设
	#   —— 不再区分是不是本应用创建的：界面上的勾选就该在防火墙上生效
	#   安全边界：只改 enabled 这一个开关，绝不删除 / 改端口 / 改目标地址
	uci set "firewall.$sec.enabled=$en"
	fw_is_ours "$sec" && ours=1 || ours=0
	fw_is_enabled "$sec" && nowen=1 || nowen=0

	echo "$created|$sec|$ours|$nowen"
	return 0
}

# ==============================================================================
#  「内网走公网也能触发唤醒」的 nft 规则
#
#  背景：内网设备访问「公网 IP + 端口」时，走的不是外网端口转发规则，
#        而是 fw4 自动生成的反射(DNAT)规则 dstnat_lan —— 那条规则不带日志，
#        所以守护进程收不到触发，唤不醒。
#
#  做法：在 prerouting 早期（早于 DNAT）加一条「只记日志、不改动作」的规则。
#        该规则按本机实际情况动态生成（网段 / 接口 / IPv6 前缀 / 各设备端口），
#        不写死任何值，换到别的设备也能正确适配。
#
#  由设置项 wol_autowake.settings.wake_hairpin 控制（默认 0 = 不加规则）。
# ==============================================================================
HAIRPIN_FILE="/etc/wol-autowake/hairpin.nft"
HAIRPIN_OLD="/etc/nftables.d/90-wolautowake.nft"

# $1=1 生成  $2=0 删除
fw_hairpin() {
	local want="$1" iface subnet subnet6 ports port nft tmp

	if [ "$want" != "1" ]; then
		rm -f "$HAIRPIN_FILE" "$HAIRPIN_OLD"
		# 文件删了还不够，运行中的表也要撤掉，否则规则会一直生效到下次重启
		nft delete table inet wolautowake >/dev/null 2>&1
		return 0
	fi

	mkdir -p /etc/wol-autowake 2>/dev/null
	rm -f "$HAIRPIN_OLD" 2>/dev/null

	# 接口
	iface=$(uci -q get wol_autowake.settings.iface)
	[ -n "$iface" ] || iface="br-lan"

	# IPv4 网段（从接口读，不写死）
	subnet=$(ip -4 addr show dev "$iface" 2>/dev/null \
		| sed -n 's/.*inet \([0-9][0-9.]*\/[0-9][0-9]*\).*/\1/p' | head -1)
	[ -z "$subnet" ] && subnet=$(ip -4 route show dev "$iface" proto kernel 2>/dev/null \
		| sed -n 's/^\([0-9][0-9.]*\/[0-9][0-9]*\).*/\1/p' | head -1)
	# 网段地址（把 .2 之类的主机位归零，取网络号）
	if [ -n "$subnet" ]; then
		local base bits
		base=${subnet%%/*}; bits=${subnet##*/}
		subnet=$(printf '%s\n' "$base" | awk -F. -v b="$bits" '{
			o1=$1; o2=$2; o3=$3; o4=$4;
			if (b >= 24)      printf "%d.%d.%d.0/%d", o1, o2, o3, b;
			else if (b >= 16) printf "%d.%d.0.0/%d", o1, o2, b;
			else if (b >= 8)  printf "%d.0.0.0/%d", o1, b;
			else              printf "0.0.0.0/%d", b;
		}')
	fi
	[ -z "$subnet" ] && subnet="192.168.1.0/24"

	# IPv6 全局前缀（从路由表读；排除 fe80/ULA，也排除带 via 的细分路由）
	subnet6=$(ip -6 route show dev "$iface" 2>/dev/null \
		| grep -v ' via ' \
		| sed -n 's/^\([0-9a-fA-F:][0-9a-fA-F:]*\/[0-9][0-9]*\).*/\1/p' \
		| grep -v '^fd' | grep -v '^fe80' | head -1)

	# 端口列表（来自设备配置）
	ports=""
	for s in $(uci show wol_autowake 2>/dev/null | sed -n 's/^wol_autowake\.\([^.=]*\)\.port=.*/\1/p'); do
		port=$(uci -q get "wol_autowake.$s.port")
		case "$port" in
			''|*[!0-9]*) continue ;;
		esac
		ports="$ports $port"
	done
	ports=$(printf '%s\n' $ports | sort -u | tr '\n' ' ')
	ports="${ports% }"
	[ -n "$ports" ] || return 0

	# 生成规则文件
	{
		printf 'table inet wolautowake {\n'
		printf '\tchain pre {\n'
		printf '\t\ttype filter hook prerouting priority mangle; policy accept;\n'
		for port in $ports; do
			printf '\t\tiifname "%s" ip saddr %s ip daddr != %s tcp dport %s log prefix "WOLAUTO-%s: " level info\n' \
				"$iface" "$subnet" "$subnet" "$port" "$port"
		done
		printf '\t}\n'
		if [ -n "$subnet6" ]; then
			printf '\tchain pre6 {\n'
			printf '\t\ttype filter hook prerouting priority mangle; policy accept;\n'
			printf '\t\tiifname "%s" ip6 saddr %s ip6 daddr != %s tcp dport { %s } log prefix "WOLAUTO-LAN6: " level info\n' \
				"$iface" "$subnet6" "$subnet6" "$(printf '%s' "$ports" | tr ' ' ',')"
			printf '\t}\n'
		fi
		printf '}\n'
	} > "$HAIRPIN_FILE" 2>/dev/null

	# 语法校验：不通过就删掉，避免把防火墙写坏
	if ! nft -c -f "$HAIRPIN_FILE" >/dev/null 2>&1; then
		rm -f "$HAIRPIN_FILE"
		return 1
	fi

	# ★ 先删掉旧表再加载，否则每次 sync 都会追加一份、规则越积越多
	nft delete table inet wolautowake >/dev/null 2>&1
	nft -f "$HAIRPIN_FILE" >/dev/null 2>&1
	return 0
}

# ---- 统一提交 + 重载 ----
fw_commit_reload() {
	uci commit firewall 2>/dev/null
	/etc/init.d/firewall reload >/dev/null 2>&1 || /etc/init.d/firewall restart >/dev/null 2>&1
}

# ==============================================================================
#  IPv6 放行（rule 类，不是 redirect）
#
#  IPv6 没有 NAT，所以「放行」就是一条 ACCEPT 规则，不涉及转发目标。
#  命名统一：WOLAUTO-<外部端口>-V6   （以 WOLAUTO- 开头，便于识别与清理）
# ==============================================================================

# ---- 列出所有 rule 的 section 名（缓存）----
fw_rules() {
	if [ -z "$FW_RULES_CACHE" ]; then
		FW_RULES_CACHE=$(uci show firewall 2>/dev/null \
			| sed -n 's/^firewall\.\(@rule\[[0-9]*\]\)\..*=.*/\1/p' \
			| sort -u)
	fi
	printf '%s\n' "$FW_RULES_CACHE"
}

# ---- 按端口找 IPv6 放行规则 ----
fw_find6_by_port() {
	local s
	[ -z "$1" ] && return 1
	for s in $(fw_rules); do
		[ "$(uci get "firewall.$s.family" 2>/dev/null)" = "ipv6" ] || continue
		[ "$(uci get "firewall.$s.dest_port" 2>/dev/null)" = "$1" ] && { echo "$s"; return 0; }
	done
	return 1
}

# ---- 确保 / 移除 IPv6 放行规则 ----
# $1=外部端口  $2=启用(0/1)  $3=是否要这条规则(0/1)
# 输出: "<exists 0|1>|<enabled 0|1>"
fw_ensure6() {
	local port="$1" en="$2" want="$3" sec name=""
	[ -n "$port" ] || return 1
	[ -n "$en" ]   || en=0
	name="${FW_PREFIX}-${port}-V6"

	sec=$(fw_find6_by_port "$port")

	if [ "$want" != "1" ]; then
		# 明确不要：只删除本应用建的（名字以 WOLAUTO- 开头），手工规则不动
		if [ -n "$sec" ]; then
			case "$(uci get "firewall.$sec.name" 2>/dev/null)" in
				${FW_PREFIX}-*)
					uci delete "firewall.$sec" 2>/dev/null
					FW_RULES_CACHE=""
					;;
			esac
		fi
		echo "0|0"
		return 0
	fi

	if [ -z "$sec" ]; then
		sec=$(uci add firewall rule 2>/dev/null) || return 1
		[ -n "$sec" ] || return 1
		FW_RULES_CACHE=""
		uci set "firewall.$sec.family=ipv6"
		uci set "firewall.$sec.proto=tcp"
		uci set "firewall.$sec.dest_port=$port"
		uci set "firewall.$sec.target=ACCEPT"
		uci set "firewall.$sec.src=wan"
		uci set "firewall.$sec.dest=lan"
	fi

	# 名字统一 + 日志（自动唤醒的另一条触发来源）
	uci set "firewall.$sec.name=$name"
	uci set "firewall.$sec.log=1"
	uci set "firewall.$sec.log_limit=$FW_LOGLIMIT"
	uci set "firewall.$sec.enabled=$en"

	fw_is_enabled "$sec" && echo "1|1" || echo "1|0"
	return 0
}
