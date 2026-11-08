-- luci-app-wol-autowake : 状态与日志
local sys  = require "luci.sys"
local util = require "luci.util"
local uci  = require "luci.model.uci".cursor()
local disp = require "luci.dispatcher"

local m, s, o

m = Map("wol_autowake", translate("自动唤醒 - 状态与日志"))
m.submit = false
m.reset  = false

-- ---------- 服务状态 ----------
s = m:section(SimpleSection, translate("服务状态"))
o = s:option(DummyValue, "_svc")
o.rawhtml = true

local running = (sys.call("pgrep -f '[w]ol-autowake.sh' >/dev/null 2>&1") == 0)
local status_txt = sys.exec("/etc/init.d/wol-autowake status 2>&1 | head -5")
local nproc = tonumber(sys.exec("pgrep -f '[w]ol-autowake.sh' 2>/dev/null | wc -l")) or 0
local has_tool = (sys.call("command -v etherwake >/dev/null 2>&1") == 0)

o.value = string.format([[
<table class="table">
<tr><td style="width:180px">%s</td><td><b style="color:%s">%s</b></td></tr>
<tr><td>%s</td><td>%d</td></tr>
<tr><td>etherwake</td><td style="color:%s">%s</td></tr>
<tr><td>%s</td><td><a class="btn cbi-button cbi-button-apply" href="%s">%s</a>
    <a class="btn cbi-button cbi-button-action" href="%s">%s</a></td></tr>
</table>
<pre style="white-space:pre-wrap;max-height:150px;overflow:auto;margin-top:8px">%s</pre>
]],
	translate("运行状态"), running and "green" or "red",
	running and translate("运行中") or translate("未运行"),
	translate("守护进程数"), nproc,
	has_tool and "green" or "red",
	has_tool and translate("已安装") or translate("未安装（唤醒会失败）"),
	translate("操作"),
	disp.build_url("admin/services/wol_autowake/restart"), translate("重启服务"),
	disp.build_url("admin/services/wol_autowake/wakeall"), translate("唤醒全部"),
	util.pcdata(status_txt))

-- ---------- 设备状态 ----------
s = m:section(SimpleSection, translate("设备状态"))
o = s:option(DummyValue, "_devs")
o.rawhtml = true

local html = { '<table class="table"><tr>',
	'<th>', translate("名称"), '</th>',
	'<th>', translate("外部端口"), '</th>',
	'<th>', translate("MAC"), '</th>',
	'<th>', translate("内网 IP"), '</th>',
	'<th>', translate("在线"), '</th>',
	'<th>', translate("操作"), '</th></tr>' }

local count = 0
uci:foreach("wol_autowake", "device", function(sec)
	count = count + 1
	local name  = sec.name or sec[".name"]
	local mac   = sec.mac or ""
	local ip    = sec.ip or ""
	local port  = sec.port or ""
	local en    = (sec.enabled ~= "0")

	local online = false
	if ip ~= "" then
		online = (sys.call("ping -c 1 -W 1 %s >/dev/null 2>&1" % ip) == 0)
	end

	local url = disp.build_url("admin/services/wol_autowake/wake") .. "?arg=" .. mac

	html[#html+1] = string.format(
		'<tr><td>%s%s</td><td>%s</td><td>%s</td><td>%s</td><td style="color:%s">%s</td>' ..
		'<td><a class="btn cbi-button cbi-button-action" href="%s">%s</a></td></tr>',
		en and "" or '<span style="color:#999">[停用] </span>',
		util.pcdata(name), util.pcdata(port), util.pcdata(mac), util.pcdata(ip),
		online and "green" or "#999",
		online and translate("在线") or translate("离线"),
		url, translate("立即唤醒"))
end)

if count == 0 then
	html[#html+1] = '<tr><td colspan="6">' .. translate("尚无设备，请到「设备」页添加") .. '</td></tr>'
end
html[#html+1] = '</table>'
o.value = table.concat(html)

-- ---------- 最近日志 ----------
s = m:section(SimpleSection, translate("最近唤醒记录"))
o = s:option(DummyValue, "_log")
o.rawhtml = true
local logtxt = sys.exec("logread 2>/dev/null | grep -iE 'wol-autowake|wol-wake' | tail -n 40")
if not logtxt or logtxt == "" then
	logtxt = translate("(暂无记录。电脑关机后，从外部连接一次对应端口，这里就会出现唤醒日志)")
end
o.value = '<pre style="white-space:pre-wrap;max-height:320px;overflow:auto">' ..
	util.pcdata(logtxt) .. '</pre>'

-- ---------- 提示 ----------
s = m:section(SimpleSection, translate("重要提示"))
o = s:option(DummyValue, "_tip")
o.rawhtml = true
o.value = translate("自动唤醒依赖「端口转发」规则里的日志开关。请到 网络 → 防火墙 → 端口转发，" ..
	"确认对应规则的「记录日志」已勾选。") ..
	' <a class="btn cbi-button" href="' ..
	disp.build_url("admin/network/firewall/redirects") .. '">' ..
	translate("去检查") .. '</a>'

return m
