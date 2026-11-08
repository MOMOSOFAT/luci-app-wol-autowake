-- luci-app-wol-autowake : 设备列表（Lua 降级版）
-- 正常情况下由 JS 版接管；仅当 /usr/share/luci/menu.d/ 里的 JS 菜单不存在时才会启用本页
local m, s, o

m = Map("wol_autowake",
	translate("自动唤醒 - 设备"),
	translate("当有人在外部连接某个「外部端口」时，如果对应设备不在线，就自动发送魔术包唤醒它。"))

s = m:section(TypedSection, "device", translate("设备列表"))
s.anonymous = true
s.addremove = true
s.template = "cbi/tblsection"
s.sortable = false

o = s:option(Flag, "enabled", translate("启用"))
o.default = "1"
o.rmempty = false
o.width = "5%"

o = s:option(Value, "name", translate("名称"))
o.placeholder = "我的电脑"
o.width = "15%"

o = s:option(Value, "port", translate("外部端口"))
o.datatype = "port"
o.rmempty = false
o.placeholder = "3389"
o.width = "10%"
o.description = translate("设备的触发标识；也是端口转发的对外端口")

o = s:option(Value, "ip", translate("内网 IP"))
o.datatype = "ip4addr"
o.rmempty = false
o.placeholder = "192.168.1.10"
o.width = "13%"
o.description = translate("用于 ping 判断是否在线；也是端口转发的目标地址")

o = s:option(Value, "mac", translate("MAC 地址"))
o.datatype = "macaddr"
o.rmempty = false
o.placeholder = "aa:bb:cc:dd:ee:ff"
o.width = "17%"

-- ---- 端口转发（全在这台设备的设置里，集中）----

o = s:option(ListValue, "fw_mode", translate("端口转发"))
o:value("off",      translate("不使用"))
o:value("prepared", translate("配置好，先停用"))
o:value("on",       translate("启用转发"))
o.default = "off"
o.width = "12%"
o.description = translate("保存后由 wol-ctl?q=sync 同步到防火墙；「先停用」不开放任何端口")

o = s:option(Value, "dest_port", translate("内网端口"))
o.datatype = "port"
o.placeholder = "3389"
o.width = "9%"
o.description = translate("转发目标端口，留空则与外部端口相同")

o = s:option(ListValue, "proto", translate("转发协议"))
o:value("tcp", "TCP")
o:value("udp", "UDP")
o:value("tcp udp", "TCP + UDP")
o.default = "tcp"
o.width = "9%"

return m
