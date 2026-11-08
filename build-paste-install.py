#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-paste-install.py -- 从 root/ 自动生成自包含的粘贴安装脚本

为什么需要它: 手动维护一份"粘贴版"很容易和 root/ 里的真实文件脱节。
本脚本保证两者永远同步。
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "root")
OUT  = os.path.join(HERE, "paste-install.sh")

KEEP_IF_EXISTS = {"etc/config/wol_autowake"}

HEADER = '''#!/bin/sh
# ==============================================================================
#  luci-app-wol-autowake  --  一键粘贴安装（自动生成，请勿手工编辑）
#
#  生成来源: root/   (改动请改 root/ 后重跑 build-paste-install.py)
#
#  用法:
#    1. 记事本 / VS Code 打开本文件
#    2. Ctrl+A 全选  ->  Ctrl+C 复制
#    3. 粘贴到路由器终端 -> 回车
#
#  特点: 不依赖 apk mkpkg / opkg，纯创建文件，任何 OpenWrt 版本都能用
# ==============================================================================

echo "===================================================="
echo " 安装 luci-app-wol-autowake  (LuCI JS + Lua 双界面)"
echo "===================================================="

if command -v etherwake >/dev/null 2>&1; then
\techo "-> etherwake 已存在"
else
\techo "-> 安装 etherwake ..."
\tapk add etherwake >/dev/null 2>&1 || opkg install etherwake >/dev/null 2>&1
\tcommand -v etherwake >/dev/null 2>&1 && echo "   OK" || echo "   !! 失败，请手动: apk add etherwake"
fi

echo "-> 写入文件 ..."
'''

FOOTER = '''
# ---------------------------------------------------------------- 权限
chmod 755 /etc/init.d/wol-autowake /usr/bin/wol-wake /usr/bin/wol-status /usr/bin/wol-logclean /usr/bin/wol-online-scan /usr/bin/wol-cnlist /usr/libexec/wol-autowake.sh 2>/dev/null
chmod 755 /www/cgi-bin/wol-status /www/cgi-bin/wol-ctl 2>/dev/null
chmod 644 /etc/config/wol_autowake 2>/dev/null
chmod 644 /usr/share/rpcd/acl.d/luci-app-wol-autowake.json 2>/dev/null
chmod 644 /usr/share/luci/menu.d/luci-app-wol-autowake.json 2>/dev/null

# 清理旧版遗留（v1.1 及以前是 devices/settings/status 三页，现已合并为 main.js）
rm -f /www/luci-static/resources/view/wol-autowake/devices.js \\
      /www/luci-static/resources/view/wol-autowake/settings.js \\
      /www/luci-static/resources/view/wol-autowake/status.js 2>/dev/null

# ---------------------------------------------------------------- cron
# ① 每分钟刷一次设备在线状态（兜底；主力是守护进程每 10 秒一次）
# ② 每小时检查一次系统日志清理
if [ -d /etc/crontabs ]; then
\tCRONF=/etc/crontabs/root
\t[ -f "$CRONF" ] || touch "$CRONF"
\tsed -i '/# WOLAUTO-LOGCLEAN/,/# WOLAUTO-END/d' "$CRONF" 2>/dev/null
\techo "" >> "$CRONF"
\techo "# WOLAUTO-LOGCLEAN -- 由 luci-app-wol-autowake 管理，请勿手改下面几行" >> "$CRONF"
\techo "* * * * * /usr/bin/wol-online-scan >/dev/null 2>&1" >> "$CRONF"
\techo "17 * * * * /usr/bin/wol-logclean >/dev/null 2>&1" >> "$CRONF"
\techo "# WOLAUTO-END" >> "$CRONF"
\t/etc/init.d/cron enable  >/dev/null 2>&1
\t/etc/init.d/cron restart >/dev/null 2>&1
\techo "-> 在线扫描 + 日志清理的 cron 任务已装"
fi

# ---------------------------------------------------------------- 服务
echo "-> 启用并启动服务 ..."
/etc/init.d/wol-autowake enable  >/dev/null 2>&1
/etc/init.d/wol-autowake restart >/dev/null 2>&1
sleep 2

# ---------------------------------------------------------------- 刷新 LuCI
echo "-> 刷新 LuCI 缓存 ..."
rm -f /tmp/luci-indexcache 2>/dev/null
rm -rf /tmp/luci-modulecache/* 2>/dev/null
/etc/init.d/rpcd   restart >/dev/null 2>&1
/etc/init.d/uhttpd restart >/dev/null 2>&1
sleep 1

# ---------------------------------------------------------------- 结果
echo ""
echo "================ 安装结果 ================"
printf "  etherwake     : %s\\n" "$(command -v etherwake || echo '!! 未安装')"
printf "  服务状态      : %s\\n" "$(/etc/init.d/wol-autowake status 2>&1 | head -1)"
printf "  守护进程数    : %s\\n" "$(ps 2>/dev/null | grep -c '[w]ol-autowake')"
printf "  wol-status    : %s\\n" "$([ -x /usr/bin/wol-status ] && echo 'OK' || echo '!! 缺失')"
printf "  JS 菜单       : %s\\n" "$([ -f /usr/share/luci/menu.d/luci-app-wol-autowake.json ] && echo 'OK' || echo '!! 缺失')"
printf "  JS 视图       : %s 个\\n" "$(ls /www/luci-static/resources/view/wol-autowake/ 2>/dev/null | wc -l)"
printf "  Lua 视图      : %s 个\\n" "$(ls /usr/lib/lua/luci/model/cbi/wol_autowake/ 2>/dev/null | wc -l)"
echo ""
echo "  --- wol-status 自检（应该是合法 JSON）---"
/usr/bin/wol-status 2>&1 | head -c 400
echo ""
echo ""
echo "  -> 打开界面: LuCI -> 服务 -> 自动唤醒"
echo "  -> 手动唤醒: wol-wake 3389"
echo "=========================================="
'''


def safe_delim(data: str) -> str:
    d = "EOPKG_EOF"
    while d in data:
        d += "_X"
    return d


def main():
    parts = [HEADER]
    count = 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames.sort()
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                data = f.read().replace("\r\n", "\n").replace("\r", "\n")
            target = "/" + rel
            d = safe_delim(data)
            parts.append('\nmkdir -p "%s"' % os.path.dirname(target))
            if rel in KEEP_IF_EXISTS:
                parts.append('if [ -f "%s" ]; then' % target)
                parts.append('\techo "   保留已有配置 %s"' % target)
                parts.append('else')
                parts.append('cat > "%s" << \'%s\'\n%s\n%s\nfi' % (target, d, data.rstrip("\n"), d))
            else:
                parts.append('cat > "%s" << \'%s\'\n%s\n%s' % (target, d, data.rstrip("\n"), d))
            count += 1
    parts.append(FOOTER)
    out = "".join(parts)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    print("[OK] 已生成 %s  (%d bytes, 包含 %d 个文件)" % (os.path.basename(OUT), len(out), count))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
