-- luci-app-wol-autowake : 控制器
module("luci.controller.wol_autowake", package.seeall)

function index()
	if not nixio.fs.access("/etc/config/wol_autowake") then
		return
	end

	-- 如果 JS 版菜单已安装，就让 JS 版接管，避免出现两个同名菜单
	if nixio.fs.access("/usr/share/luci/menu.d/luci-app-wol-autowake.json") then
		return
	end

	local page = entry({"admin", "services", "wol_autowake"},
		alias("admin", "services", "wol_autowake", "devices"),
		_("自动唤醒"), 61)
	page.dependent = true
	page.acl_depends = { "luci-app-wol-autowake" }

	entry({"admin", "services", "wol_autowake", "devices"},
		cbi("wol_autowake/devices"), _("设备"), 10).leaf = true

	entry({"admin", "services", "wol_autowake", "settings"},
		cbi("wol_autowake/settings"), _("设置"), 20).leaf = true

	entry({"admin", "services", "wol_autowake", "status"},
		cbi("wol_autowake/status"), _("状态与日志"), 30).leaf = true

	entry({"admin", "services", "wol_autowake", "wake"},
		call("action_wake")).leaf = true

	entry({"admin", "services", "wol_autowake", "restart"},
		call("action_restart")).leaf = true

	entry({"admin", "services", "wol_autowake", "wakeall"},
		call("action_wakeall")).leaf = true
end

function action_wake()
	local arg = luci.http.formvalue("arg")
	if arg and arg:match("^[%w:%-%._]+$") then
		luci.sys.call("/usr/bin/wol-wake '%s' >/dev/null 2>&1" % arg)
	end
	luci.http.redirect(luci.dispatcher.build_url("admin", "services", "wol_autowake", "status"))
end

function action_wakeall()
	luci.sys.call("/usr/bin/wol-wake --all >/dev/null 2>&1")
	luci.http.redirect(luci.dispatcher.build_url("admin", "services", "wol_autowake", "status"))
end

function action_restart()
	luci.sys.call("/etc/init.d/wol-autowake restart >/dev/null 2>&1")
	luci.http.redirect(luci.dispatcher.build_url("admin", "services", "wol_autowake", "status"))
end
