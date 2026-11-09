-- luci-app-wol-autowake : 全局设置
local m, s, o

m = Map("wol_autowake", translate("自动唤醒 - 设置"))

s = m:section(TypedSection, "settings", translate("全局设置"))
s.anonymous = true

o = s:option(Flag, "enabled", translate("启用服务"))
o.default = "1"
o.rmempty = false
o.description = translate("关闭后守护进程不启动，自动唤醒失效（手动唤醒仍可用）")

o = s:option(Value, "iface", translate("发包接口"))
o.default = "br-lan"
o.rmempty = false
o.description = translate("魔术包从哪个接口广播出去，一般就是 br-lan")

o = s:option(Value, "throttle", translate("每设备节流（秒）"))
o.datatype = "uinteger"
o.default = "60"
o.rmempty = false
o.description = translate("同一台设备在这个时间内只唤醒一次，避免连续连接请求导致重复发包")

return m
