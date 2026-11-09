#!/bin/sh
# ==============================================================================
#  luci-app-wol-autowake 安装脚本（apk 系统 / opkg 系统通用）
#
#  用法（路由器上，先解包）:
#      tar -xzf luci-app-wol-autowake-1.0.0.tar.gz -C /tmp
#      sh /tmp/luci-app-wol-autowake/install.sh
#
#  参数:
#      --enable-log    给所有端口转发规则打开日志（自动唤醒的触发来源）
#      --force-config  覆盖已有的 /etc/config/wol_autowake
#      --build-only    只构建 .apk 不安装
#      --no-apk        跳过 apk mkpkg，直接拷贝文件安装
#
#  说明:
#      apk v3 的包容器是 ADB 格式，不适合手工构造。
#      本脚本优先调用路由器自带的 `apk mkpkg` 生成【原生 .apk】再安装，
#      这样包会被正确登记到 apk 数据库（升级/卸载都正常）。
#      如果你的 apk 没有 mkpkg 子命令，则退化为直接拷贝文件安装。
# ==============================================================================

PKG="luci-app-wol-autowake"
VER="1.0.0"
REL="0"

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT="$SELF_DIR/root"
ENABLE_LOG=0
FORCE_CONFIG=0
BUILD_ONLY=0
NO_APK=0
FORCE_ARCH=""

while [ $# -gt 0 ]; do
	case "$1" in
		--enable-log)   ENABLE_LOG=1 ;;
		--force-config) FORCE_CONFIG=1 ;;
		--build-only)   BUILD_ONLY=1 ;;
		--no-apk)       NO_APK=1 ;;
		--arch)         FORCE_ARCH="$2"; shift ;;
		--arch=*)       FORCE_ARCH="${1#*=}" ;;
	esac
	shift
done

echo "===================================================="
echo " $PKG $VER  安装"
echo " 包目录: $ROOT"
echo "===================================================="
[ -d "$ROOT" ] || { echo "!! 找不到 root/ 目录，请在解包后的目录里执行"; exit 1; }

# ------------------------------------------------------------------
# 0. 环境探测
# ------------------------------------------------------------------
HAS_APK=0
HAS_MKPKG=0
if command -v apk >/dev/null 2>&1; then
	HAS_APK=1
	if apk mkpkg --help >/dev/null 2>&1; then
		HAS_MKPKG=1
	fi
fi
echo "→ 包管理器: $([ "$HAS_APK" = 1 ] && echo apk || echo opkg)   apk mkpkg: $([ "$HAS_MKPKG" = 1 ] && echo 可用 || echo 不可用)"

# ------------------------------------------------------------------
# 1. 依赖 etherwake
# ------------------------------------------------------------------
if command -v etherwake >/dev/null 2>&1; then
	echo "→ etherwake 已存在"
else
	echo "→ 安装 etherwake ..."
	apk add etherwake >/dev/null 2>&1 || opkg install etherwake >/dev/null 2>&1
	command -v etherwake >/dev/null 2>&1 && echo "  OK" || echo "  !! 失败，请手动: apk add etherwake"
fi

# ------------------------------------------------------------------
# 2. 构建原生 .apk（用路由器自带的 apk mkpkg）
# ------------------------------------------------------------------
APK_FILE=""
if [ "$HAS_MKPKG" = 1 ] && [ "$NO_APK" = 0 ]; then
	echo "→ 用 apk mkpkg 构建原生 .apk ..."

	ARCH=""
	# 架构探测，按可靠性排序（apk 对 arch 字段很挑剔，填错就报错）
	# 1) OpenWrt 自己记录的架构
	[ -f /etc/openwrt_release ] && ARCH=$(sed -n "s/^DISTRIB_ARCH='\(.*\)'/\1/p" /etc/openwrt_release 2>/dev/null)
	# 2) apk 自己报告的架构
	[ -z "$ARCH" ] && ARCH=$(apk --print-arch 2>/dev/null | tr -d '\r\n')
	# 3) apk 的 arch 配置文件
	[ -z "$ARCH" ] && ARCH=$(cat /etc/apk/arch 2>/dev/null | tr -d '\r\n')
	# 4) 用户指定优先于以上全部
	[ -n "$FORCE_ARCH" ] && ARCH="$FORCE_ARCH"
	[ -z "$ARCH" ] && ARCH=all
	echo "  本机架构: $ARCH"

	STAGE=$(mktemp -d)
	SCRIPTS=$(mktemp -d)
	cp -a "$ROOT"/. "$STAGE"/ 2>/dev/null

	# 去掉 CRLF，统一 LF（Windows 上传的文件常见问题）
	# 注意：临时文件必须放在 stage 树【外面】，否则会被一起打进包里
	find "$STAGE" -type f | while read -r f; do
		if tr -d '\r' < "$f" > /tmp/.wolstrip.$$ 2>/dev/null; then
			mv /tmp/.wolstrip.$$ "$f"
		fi
	done
	rm -f /tmp/.wolstrip.$$ 2>/dev/null

	# 权限
	chmod 755 "$STAGE/etc/init.d/wol-autowake" "$STAGE/usr/bin/wol-wake" "$STAGE/usr/bin/wol-status" \
		"$STAGE/usr/bin/wol-geo" "$STAGE/usr/bin/wol-geo-lookup" \
		"$STAGE/usr/bin/wol-autoblock" "$STAGE/usr/bin/wol-blfw" \
		"$STAGE/usr/libexec/wol-autowake.sh" \
		"$STAGE/www/cgi-bin/wol-status" "$STAGE/www/cgi-bin/wol-ctl" "$STAGE/www/cgi-bin/wol-log" 2>/dev/null

	# ---- 包内元数据（严格照 OpenWrt include/package-pack.mk 的约定）----
	mkdir -p "$STAGE/lib/apk/packages"

	# 1) 配置文件清单
	echo "/etc/config/wol_autowake" > "$STAGE/lib/apk/packages/${PKG}.conffiles"

	# 2) 配置文件初始校验和（OpenWrt 会写 conffiles_static）
	if command -v sha256sum >/dev/null 2>&1; then
		sum=$(sha256sum "$STAGE/etc/config/wol_autowake" 2>/dev/null | cut -d' ' -f1)
		[ -n "$sum" ] && echo "/etc/config/wol_autowake $sum" \
			> "$STAGE/lib/apk/packages/${PKG}.conffiles_static"
	fi

	# 3) 文件清单（OpenWrt 会写 <name>.list；busybox find 没有 -printf，用 sed 转换）
	( cd "$STAGE" && find . \( -type f -o -type l \) 2>/dev/null | sed 's|^\.|/|' | sort ) \
		> "$STAGE/lib/apk/packages/${PKG}.list" 2>/dev/null

	# maintainer 脚本
	cat > "$SCRIPTS/post-install" <<'EOS'
#!/bin/sh
chmod 755 /etc/init.d/wol-autowake /usr/bin/wol-wake /usr/bin/wol-status /usr/bin/wol-geo /usr/bin/wol-geo-lookup /usr/bin/wol-autoblock /usr/bin/wol-blfw /usr/bin/wol-logclean /usr/bin/wol-online-scan /usr/libexec/wol-autowake.sh 2>/dev/null
chmod 755 /www/cgi-bin/wol-status /www/cgi-bin/wol-ctl /www/cgi-bin/wol-log 2>/dev/null
rm -f /www/luci-static/resources/view/wol-autowake/devices.js \
      /www/luci-static/resources/view/wol-autowake/settings.js \
      /www/luci-static/resources/view/wol-autowake/status.js 2>/dev/null
if [ -d /etc/crontabs ]; then
	CRONF=/etc/crontabs/root
	[ -f "$CRONF" ] || touch "$CRONF"
	sed -i '/^# WOLAUTO-APP --/,/^# WOLAUTO-APP-END$/d' "$CRONF" 2>/dev/null
	echo "" >> "$CRONF"
	echo "# WOLAUTO-APP -- managed by luci-app-wol-autowake" >> "$CRONF"
	echo "20 4 * * 1 /usr/bin/wol-cnlist ensure >/dev/null 2>&1" >> "$CRONF"
	echo "* * * * * /usr/bin/wol-online-scan >/dev/null 2>&1" >> "$CRONF"
	echo "* * * * * /usr/bin/wol-autoblock >/dev/null 2>&1" >> "$CRONF"
	echo "*/5 * * * * /usr/bin/wol-geo >/dev/null 2>&1" >> "$CRONF"
	echo "17 * * * * /usr/bin/wol-logclean >/dev/null 2>&1" >> "$CRONF"
	echo "# WOLAUTO-APP-END" >> "$CRONF"
	/etc/init.d/cron enable  >/dev/null 2>&1
	/etc/init.d/cron restart >/dev/null 2>&1
fi
/etc/init.d/wol-autowake enable  >/dev/null 2>&1
/etc/init.d/wol-autowake restart >/dev/null 2>&1
rm -f /tmp/luci-indexcache 2>/dev/null
rm -rf /tmp/luci-modulecache/* 2>/dev/null
/etc/init.d/rpcd   restart >/dev/null 2>&1
/etc/init.d/uhttpd restart >/dev/null 2>&1
exit 0
EOS
	cat > "$SCRIPTS/pre-deinstall" <<'EOS'
#!/bin/sh
/etc/init.d/wol-autowake stop    >/dev/null 2>&1
/etc/init.d/wol-autowake disable >/dev/null 2>&1
rm -f /tmp/luci-indexcache 2>/dev/null
rm -rf /tmp/luci-modulecache/* 2>/dev/null
/etc/init.d/rpcd   restart >/dev/null 2>&1
/etc/init.d/uhttpd restart >/dev/null 2>&1
exit 0
EOS
	chmod 755 "$SCRIPTS/post-install" "$SCRIPTS/pre-deinstall"

	# post-upgrade / pre-upgrade（OpenWrt 也会带，没有就跳过）
	cat > "$SCRIPTS/post-upgrade" <<'EOS'
#!/bin/sh
/etc/init.d/wol-autowake restart >/dev/null 2>&1
exit 0
EOS
	chmod 755 "$SCRIPTS/post-upgrade"

	APK_FILE="/tmp/${PKG}_${VER}-r${REL}_noarch.apk"
	# 关键: 架构无关的包 arch 必须写 noarch（照 OpenWrt package-pack.mk）
	#       SOURCE_DATE_EPOCH=0 也是 OpenWrt 的做法
	if SOURCE_DATE_EPOCH=0 apk mkpkg \
		--info "name:$PKG" \
		--info "version:${VER}-r${REL}" \
		--info "description:WOL on demand - auto wake LAN devices when a remote connection arrives (LuCI UI)" \
		--info "arch:noarch" \
		--info "license:Apache-2.0" \
		--info "origin:$PKG" \
		--info "maintainer:luci-app-wol-autowake" \
		--info "depends:luci-base" \
		--script "post-install:$SCRIPTS/post-install" \
		--script "pre-deinstall:$SCRIPTS/pre-deinstall" \
		--script "post-upgrade:$SCRIPTS/post-upgrade" \
		--files "$STAGE" \
		--output "$APK_FILE"
	then
		echo "  OK 已生成 $APK_FILE ($(wc -c < "$APK_FILE") bytes)"
	else
		echo "  !! apk mkpkg 失败，改为直接安装文件"
		APK_FILE=""
	fi
	rm -rf "$STAGE" "$SCRIPTS"
fi

# ------------------------------------------------------------------
# 3. 安装
# ------------------------------------------------------------------
INSTALLED_BY_APK=0
if [ -n "$APK_FILE" ] && [ "$BUILD_ONLY" = 0 ]; then
	# 先干跑一次，把 apk 的原始报错完整打出来
	echo "→ 预检 (apk add --simulate) ..."
	SIM_OUT=$(apk add --simulate --allow-untrusted "$APK_FILE" 2>&1)
	SIM_RC=$?
	if [ -n "$SIM_OUT" ]; then echo "$SIM_OUT" | sed 's/^/    /'; fi
	[ "$SIM_RC" -ne 0 ] && echo "  !! 预检失败 rc=$SIM_RC  （包: $APK_FILE, 架构: $ARCH）"

	echo "→ 用 apk 安装 $APK_FILE ..."
	if apk add --allow-untrusted "$APK_FILE"; then
		INSTALLED_BY_APK=1
		echo "  OK 已作为 apk 包安装"
	else
		echo "  !! apk 安装失败（rc=$?），改为直接拷贝文件"
		echo "     如需手工排查，可执行:"
		echo "       apk add --allow-untrusted '$APK_FILE'"
		echo "       sh $0 --no-apk --enable-log          # 保底安装方式"
	fi
fi

if [ "$BUILD_ONLY" = 1 ] && [ -n "$APK_FILE" ]; then
	echo ""
	echo "→ 只构建模式，.apk 已生成: $APK_FILE"
	echo "   安装命令: apk add --allow-untrusted $APK_FILE"
	exit 0
fi

if [ "$INSTALLED_BY_APK" = 0 ]; then
	echo "→ 直接拷贝文件到系统 ..."
	cd "$ROOT" || exit 1
	find . -type f | while read -r f; do
		rel=${f#./}
		dest="/$rel"
		if [ "$rel" = "etc/config/wol_autowake" ] && [ -f "$dest" ] && [ "$FORCE_CONFIG" != "1" ]; then
			echo "   保留已有配置: $dest"
			continue
		fi
		mkdir -p "$(dirname "$dest")"
		tr -d '\r' < "$f" > "$dest" || { echo "   !! 写入失败: $dest"; continue; }
	done

	# 清理旧版（v1.1 及以前是 devices.js / settings.js / status.js 三页，现已合并为 main.js）
	rm -f /www/luci-static/resources/view/wol-autowake/devices.js \
	      /www/luci-static/resources/view/wol-autowake/settings.js \
	      /www/luci-static/resources/view/wol-autowake/status.js 2>/dev/null

	chmod 755 /etc/init.d/wol-autowake /usr/bin/wol-wake /usr/bin/wol-status /usr/bin/wol-geo /usr/bin/wol-geo-lookup /usr/bin/wol-autoblock /usr/bin/wol-blfw /usr/bin/wol-logclean /usr/bin/wol-online-scan /usr/libexec/wol-autowake.sh 2>/dev/null
	chmod 755 /www/cgi-bin/wol-status /www/cgi-bin/wol-ctl /www/cgi-bin/wol-log 2>/dev/null
	chmod 644 /etc/config/wol_autowake /usr/share/rpcd/acl.d/luci-app-wol-autowake.json 2>/dev/null

	# ---- cron 任务：① 每分钟刷一次设备在线状态（兜底）② 每小时检查日志清理 ----
	if [ -d /etc/crontabs ]; then
		CRONF=/etc/crontabs/root
		[ -f "$CRONF" ] || touch "$CRONF"
		sed -i '/^# WOLAUTO-APP --/,/^# WOLAUTO-APP-END$/d' "$CRONF" 2>/dev/null
		{
			echo ""
			echo "# WOLAUTO-APP -- 由 luci-app-wol-autowake 管理，请勿手改下面几行"
			echo "20 4 * * 1 /usr/bin/wol-cnlist ensure >/dev/null 2>&1"
			echo "* * * * * /usr/bin/wol-online-scan >/dev/null 2>&1"
			echo "* * * * * /usr/bin/wol-autoblock >/dev/null 2>&1"
			echo "*/5 * * * * /usr/bin/wol-geo >/dev/null 2>&1"
			echo "17 * * * * /usr/bin/wol-logclean >/dev/null 2>&1"
			echo "# WOLAUTO-APP-END"
		} >> "$CRONF"
		/etc/init.d/cron enable  >/dev/null 2>&1
		/etc/init.d/cron restart >/dev/null 2>&1
		echo "→ 在线扫描 + 日志清理的 cron 任务已装"
	fi

	echo "→ 启用并启动服务 ..."
	/etc/init.d/wol-autowake enable  >/dev/null 2>&1
	/etc/init.d/wol-autowake restart >/dev/null 2>&1
	sleep 2

	echo "→ 刷新 LuCI 缓存 ..."
	rm -f /tmp/luci-indexcache 2>/dev/null
	rm -rf /tmp/luci-modulecache/* 2>/dev/null
	/etc/init.d/rpcd   restart >/dev/null 2>&1
	/etc/init.d/uhttpd restart >/dev/null 2>&1
	sleep 1
fi

# ------------------------------------------------------------------
# 4. 给端口转发规则开日志（可选，但自动唤醒必须要）
# ------------------------------------------------------------------
if [ "$ENABLE_LOG" = "1" ]; then
	echo "→ 给端口转发规则打开日志 ..."
	n=0
	for s in $(uci show firewall 2>/dev/null | sed -n 's/^firewall\.\(@redirect\[[0-9]*\]\)\.name=.*/\1/p'); do
		uci set firewall.$s.log='1'
		uci set firewall.$s.log_limit='6/minute'
		n=$((n + 1))
	done
	uci commit firewall 2>/dev/null
	/etc/init.d/firewall reload >/dev/null 2>&1
	echo "  已处理 $n 条规则"
else
	echo "→ 提醒: 自动唤醒需要「端口转发」规则打开日志"
	echo "   可执行:  sh $0 --enable-log"
fi

# ------------------------------------------------------------------
# 5. 结果
# ------------------------------------------------------------------
echo ""
echo "================ 安装结果 ================"
printf "  安装方式     : %s\n" "$([ "$INSTALLED_BY_APK" = 1 ] && echo 'apk 包（已登记）' || echo '直接拷文件')"
printf "  包文件       : %s\n" "${APK_FILE:-无}"
printf "  etherwake    : %s\n" "$(command -v etherwake || echo '!! 未安装')"
printf "  服务状态     : %s\n" "$(/etc/init.d/wol-autowake status 2>&1 | head -1)"
printf "  守护进程数   : %s\n" "$(ps 2>/dev/null | grep -c '[w]ol-autowake')"
printf "  wol-status   : %s\n" "$([ -x /usr/bin/wol-status ] && echo 'OK' || echo '!! 缺失')"
printf "  JS 菜单      : %s\n" "$([ -f /usr/share/luci/menu.d/luci-app-wol-autowake.json ] && echo 'OK' || echo '!! 缺失')"
printf "  JS 视图      : %s 个  %s\n" "$(ls /www/luci-static/resources/view/wol-autowake/ 2>/dev/null | wc -l)" "$(ls /www/luci-static/resources/view/wol-autowake/ 2>/dev/null | tr '\n' ' ')"
printf "  Lua 控制器   : %s\n" "$([ -f /usr/lib/lua/luci/controller/wol_autowake.lua ] && echo 'OK（降级备用）' || echo '缺失')"
printf "  Lua 视图     : %s 个\n" "$(ls /usr/lib/lua/luci/model/cbi/wol_autowake/ 2>/dev/null | wc -l)"
[ "$INSTALLED_BY_APK" = 1 ] && printf "  apk 登记     : %s\n" "$(apk info -e $PKG 2>/dev/null && echo 已登记 || echo 未登记)"
echo ""
echo "  设备列表:"
/usr/bin/wol-wake 2>/dev/null | sed 's/^/    /'
echo ""
echo "  → 打开界面: LuCI → 服务 → 自动唤醒"
echo "=========================================="
