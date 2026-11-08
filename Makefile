#
# LuCI 应用: WOL on demand —— 远程连接时自动唤醒设备
#
# 放到 OpenWrt SDK / buildroot 的:
#     package/luci-app-wol-autowake/Makefile
# 然后:
#     make package/luci-app-wol-autowake/compile V=s
#
# 注意: 本包是纯脚本（shell + lua），没有编译产物，架构为 all。
#       如果你没有 SDK，也可以用仓库里的 build-ipk.py 直接手工打包 .ipk。
#
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wol-autowake
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=WOL Autowake

LUCI_TITLE:=LuCI app - WOL on demand (remote connect triggers wake-on-LAN)
LUCI_DESCRIPTION:=Monitor the firewall log for incoming connection attempts to configured ports; \
	if the target device is offline, send a Wake-on-LAN magic packet automatically. \
	Supports unlimited devices keyed by external port, with a LuCI configuration UI.
LUCI_DEPENDS:=+luci-base +etherwake
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/conffiles
/etc/config/wol_autowake
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/wol-autowake enable  >/dev/null 2>&1
	/etc/init.d/wol-autowake restart >/dev/null 2>&1
	rm -f /tmp/luci-indexcache 2>/dev/null
	rm -rf /tmp/luci-modulecache/* 2>/dev/null
	/etc/init.d/rpcd   restart >/dev/null 2>&1
	/etc/init.d/uhttpd restart >/dev/null 2>&1
}
exit 0
endef

define Package/$(PKG_NAME)/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/wol-autowake stop >/dev/null 2>&1
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
$(eval $(call BuildPackage,$(PKG_NAME)))
