#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-ipk.py -- 无需 OpenWrt SDK，直接把 root/ 打包成 opkg 可安装的 .ipk

原理：OpenWrt 的 .ipk 就是 Debian 风格的 ar 归档，内含三部分：
    debian-binary   文本 "2.0\\n"
    control.tar.gz  控制信息（control / postinst / prerm / conffiles）
    data.tar.gz     实际文件树（./etc/... ./usr/...）
纯 shell/lua 包是 arch=all，不涉及交叉编译，所以可以手工构造。

用法:
    python build-ipk.py                 # 生成 .ipk 和通用 .tar.gz
    python build-ipk.py --list          # 只列出将要打包的文件
"""
import argparse
import io
import os
import stat
import sys
import tarfile
import time

PKG      = "luci-app-wol-autowake"
VERSION  = "1.0.0"
RELEASE  = "1"
ARCH     = "all"
SECTION  = "luci"
LICENSE  = "Apache-2.0"
DESC     = "WOL on demand: automatically wake LAN devices when a remote connection arrives, with LuCI UI"

HERE   = os.path.dirname(os.path.abspath(__file__))
ROOT   = os.path.join(HERE, "root")
MTIME  = int(os.environ.get("SOURCE_DATE_EPOCH", "1730000000"))

EXEC_FILES = {
    "etc/init.d/wol-autowake",
    "usr/bin/wol-wake",
    "usr/bin/wol-status",
    "usr/bin/wol-geo",
    "usr/bin/wol-geo-lookup",
    "usr/bin/wol-autoblock",
    "usr/bin/wol-blfw",
    "usr/bin/wol-logclean",
    "usr/bin/wol-online-scan",
    "usr/libexec/wol-autowake.sh",
    "www/cgi-bin/wol-status",
    "www/cgi-bin/wol-ctl",
    "www/cgi-bin/wol-log",
}


def norm(data: bytes) -> bytes:
    """统一换行符为 LF —— 路由器上 CRLF 会让 shell 脚本炸掉"""
    return data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def collect(base):
    """返回 [(相对路径, 绝对路径, 是否可执行)]"""
    items = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            items.append((rel, full, rel in EXEC_FILES))
    return items


def make_data_tar_gz():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.GNU_FORMAT) as tf:
        # 需要显式建立目录项
        dirs = set()
        for rel, _full, _x in collect(ROOT):
            parts = rel.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                dirs.add("/".join(parts[:i]))
        for d in sorted(dirs):
            ti = tarfile.TarInfo("./" + d + "/")
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            ti.mtime = MTIME
            tf.addfile(ti)
        for rel, full, is_exec in collect(ROOT):
            with open(full, "rb") as f:
                data = norm(f.read())
            ti = tarfile.TarInfo("./" + rel)
            ti.size = len(data)
            ti.mtime = MTIME
            ti.mode = 0o755 if is_exec else 0o644
            tf.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


CONTROL = """Package: {pkg}
Version: {ver}-{rel}
Depends: luci-base
Source: {pkg}
SourceName: {pkg}
License: {lic}
Section: {sec}
SectionName: {sec}
Architecture: {arch}
Installed-Size: {size}
Description: {desc}
"""

POSTINST = """#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {{
\t# 首次安装时初始化配置
\t[ -f /etc/config/wol_autowake ] || {{
\t\tmkdir -p /etc/config
\t\tcat > /etc/config/wol_autowake << 'EOF'
config settings 'settings'
\toption enabled '1'
\toption iface 'br-lan'
\toption throttle '60'
\toption logread '1'
EOF
\t}}

\t# 依赖: etherwake（失败不阻塞安装）
\tcommand -v etherwake >/dev/null 2>&1 || {{
\t\topkg install etherwake >/dev/null 2>&1 || apk add etherwake >/dev/null 2>&1
\t}}

\tchmod 755 /etc/init.d/wol-autowake /usr/bin/wol-wake /usr/bin/wol-status /usr/bin/wol-geo /usr/bin/wol-geo-lookup /usr/bin/wol-autoblock /usr/bin/wol-blfw /usr/bin/wol-logclean /usr/bin/wol-online-scan /usr/libexec/wol-autowake.sh 2>/dev/null
\tchmod 755 /www/cgi-bin/wol-status /www/cgi-bin/wol-ctl /www/cgi-bin/wol-log 2>/dev/null
\t# 清理旧版遗留（v1.1 及以前是三页，现已合并为 main.js）
\trm -f /www/luci-static/resources/view/wol-autowake/devices.js \\
\t      /www/luci-static/resources/view/wol-autowake/settings.js \\
\t      /www/luci-static/resources/view/wol-autowake/status.js 2>/dev/null
\t# 日志清理 cron（每小时调用，脚本内部按配置间隔节流）
\tif [ -d /etc/crontabs ]; then
\t\tCRONF=/etc/crontabs/root
\t\t[ -f "$$CRONF" ] || touch "$$CRONF"
\t\tsed -i '/^# WOLAUTO-APP --/,/^# WOLAUTO-APP-END$$/d' "$$CRONF" 2>/dev/null
\t\techo "" >> "$$CRONF"
\t\techo "# WOLAUTO-APP -- managed by luci-app-wol-autowake" >> "$$CRONF"
\t\techo "20 4 * * 1 /usr/bin/wol-cnlist ensure >/dev/null 2>&1" >> "$$CRONF"
\t\techo "* * * * * /usr/bin/wol-online-scan >/dev/null 2>&1" >> "$$CRONF"
\t\techo "* * * * * /usr/bin/wol-autoblock >/dev/null 2>&1" >> "$$CRONF"
\t\techo "*/5 * * * * /usr/bin/wol-geo >/dev/null 2>&1" >> "$$CRONF"
\t\techo "17 * * * * /usr/bin/wol-logclean >/dev/null 2>&1" >> "$$CRONF"
\t\techo "# WOLAUTO-APP-END" >> "$$CRONF"
\t\t/etc/init.d/cron enable  >/dev/null 2>&1
\t\t/etc/init.d/cron restart >/dev/null 2>&1
\tfi

\t/etc/init.d/wol-autowake enable  >/dev/null 2>&1
\t/etc/init.d/wol-autowake restart >/dev/null 2>&1

\t# 清 LuCI 缓存，让菜单立刻出现
\trm -f /tmp/luci-indexcache 2>/dev/null
\trm -rf /tmp/luci-modulecache/* 2>/dev/null
\t/etc/init.d/rpcd   restart >/dev/null 2>&1
\t/etc/init.d/uhttpd restart >/dev/null 2>&1
}}
exit 0
"""

PRERM = """#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || /etc/init.d/wol-autowake stop >/dev/null 2>&1
exit 0
"""

POSTRM = """#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {{
\t/etc/init.d/wol-autowake disable >/dev/null 2>&1

\t# --- 清掉「内网走公网触发唤醒」的 nft 规则表 ---
\tif [ -f /etc/nftables.d/90-wolautowake.nft ]; then
\t\trm -f /etc/nftables.d/90-wolautowake.nft
\tfi
\tnft delete table inet wolautowake >/dev/null 2>&1

\t# --- 清掉 crontab 里本应用的标记块 ---
\tif [ -f /etc/crontabs/root ]; then
\t\tsed -i '/^# WOLAUTO-APP --/,/^# WOLAUTO-APP-END$/d' /etc/crontabs/root 2>/dev/null
\t\tsed -i '/wol-cnlist/d' /etc/crontabs/root 2>/dev/null
\t\t/etc/init.d/cron restart >/dev/null 2>&1
\tfi

\t# --- 清掉国内的 IP 集合 ---
\tipset destroy wol_cn4 >/dev/null 2>&1
\tipset destroy wol_cn6 >/dev/null 2>&1
\tipset destroy wol_bl4 >/dev/null 2>&1
\tipset destroy wol_wl4 >/dev/null 2>&1

\t# --- 清掉数据缓存 / 运行态 ---
\trm -rf /etc/wol-autowake 2>/dev/null
\trm -f  /tmp/wol-* 2>/dev/null
\trm -f  /root/wol-autowake.log 2>/dev/null

\trm -f /tmp/luci-indexcache 2>/dev/null
\trm -rf /tmp/luci-modulecache/* 2>/dev/null
\t/etc/init.d/rpcd   restart >/dev/null 2>&1
\t/etc/init.d/uhttpd restart >/dev/null 2>&1
}}
exit 0
"""

CONFFILES = "/etc/config/wol_autowake\n"


def make_control_tar_gz(data_size):
    files = {
        "control":   CONTROL.format(pkg=PKG, ver=VERSION, rel=RELEASE, lic=LICENSE,
                                    sec=SECTION, arch=ARCH, size=data_size, desc=DESC),
        "postinst":  POSTINST,
        "prerm":     PRERM,
        "postrm":    POSTRM,
        "conffiles": CONFFILES,
    }
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.GNU_FORMAT) as tf:
        for name in ("control", "conffiles", "postinst", "prerm", "postrm"):
            raw = files[name]
            if name not in ("control", "conffiles"):
                # 维护脚本里写的 {{ }}、$$ 是 Python 字面量转义，这里还原成 { }、$
                raw = raw.replace("{{", "{").replace("}}", "}").replace("$$", "$")
            data = norm(raw.encode("utf-8"))
            ti = tarfile.TarInfo("./" + name)
            ti.size = len(data)
            ti.mtime = MTIME
            ti.mode = 0o644
            tf.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def ar_write(path, members):
    """写 Debian 风格 ar 归档（!<arch> 格式）"""
    with open(path, "wb") as f:
        f.write(b"!<arch>\n")
        for name, data in members:
            hdr = "{:<16}{:<12}{:<6}{:<6}{:<8}{:<10}`\n".format(
                name, MTIME, 0, 0, "100644", len(data)
            ).encode("ascii")
            assert len(hdr) == 60, len(hdr)
            f.write(hdr)
            f.write(data)
            if len(data) % 2:
                f.write(b"\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="只列出文件，不打包")
    args = ap.parse_args()

    if not os.path.isdir(ROOT):
        print("找不到 root/ 目录: " + ROOT, file=sys.stderr)
        return 1

    items = collect(ROOT)
    if args.list:
        for rel, _f, is_exec in items:
            print(("x " if is_exec else "  ") + rel)
        print("%d 个文件" % len(items))
        return 0

    data_tar = make_data_tar_gz()
    control_tar = make_control_tar_gz(len(data_tar))

    ipk = os.path.join(HERE, "%s_%s-%s_%s.ipk" % (PKG, VERSION, RELEASE, ARCH))
    ar_write(ipk, [
        ("debian-binary",  b"2.0\n"),
        ("control.tar.gz", control_tar),
        ("data.tar.gz",    data_tar),
    ])
    print("[OK] 已生成 %s  (%.1f KB)" % (os.path.basename(ipk), os.path.getsize(ipk) / 1024.0))

    # 通用 tar.gz（apk 系统 / 手动安装用）
    targz = os.path.join(HERE, "%s-%s.tar.gz" % (PKG, VERSION))
    top = PKG
    with tarfile.open(targz, "w:gz", format=tarfile.GNU_FORMAT) as tf:
        for extra in ("install.sh", "README.md", "Makefile", "LICENSE"):
            p = os.path.join(HERE, extra)
            if os.path.isfile(p):
                with open(p, "rb") as f:
                    data = norm(f.read())
                ti = tarfile.TarInfo("%s/%s" % (top, extra))
                ti.size = len(data)
                ti.mtime = MTIME
                ti.mode = 0o755 if extra == "install.sh" else 0o644
                tf.addfile(ti, io.BytesIO(data))
        for rel, full, is_exec in items:
            with open(full, "rb") as f:
                data = norm(f.read())
            ti = tarfile.TarInfo("%s/root/%s" % (top, rel))
            ti.size = len(data)
            ti.mtime = MTIME
            ti.mode = 0o755 if is_exec else 0o644
            tf.addfile(ti, io.BytesIO(data))
    print("[OK] 已生成 %s  (%.1f KB)" % (os.path.basename(targz), os.path.getsize(targz) / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
