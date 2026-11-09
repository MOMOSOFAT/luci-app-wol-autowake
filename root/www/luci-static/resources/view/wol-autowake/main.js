'use strict';
'require view';
'require form';
'require ui';
'require poll';

/*
 * luci-app-wol-autowake : LuCI 单页界面（v2 重写版）
 *
 * 界面与之前完全一致，但结构重写为「表驱动 + 单一来源」：
 *
 *   ① api         —— 只有两个请求入口：api.status() / api.ctl()
 *   ② Model       —— 统一计算「在线 / 转发」的文案与颜色，表格和卡片共用
 *   ③ *_FIELDS    —— 所有字段只在这里定义一次（标题/类型/必填/弹窗/说明）
 *   ④ addField()  —— 把字段定义变成 LuCI option，唯一一处实现
 *   ⑤ decorate()  —— 渲染后按【列名】找单元格（不靠索引），插唤醒按钮
 *
 * 与旧版的差别（全是 bug 修正）：
 *   · 不再使用 o.editable —— 它与 o.modalonly 互斥，
 *     会让「启用 / 启用转发」的勾选状态显示错误（旧版就栽在这上面）
 *   · 「在线 / 端口转发」只由 Model 计算一次
 *   · 列位置按表头文字匹配，不再硬编码 tds[3] / tds[4]
 */

var STATUS_URL = '/cgi-bin/wol-status';
var CTL_URL    = '/cgi-bin/wol-ctl';
var POLL_SEC   = 10;

/* 所有信息弹窗 5 秒后自动淡出 */
var _addNotification = ui.addNotification.bind(ui);
ui.addNotification = function () {
	var msg = _addNotification.apply(ui, arguments);
	if (msg) {
		setTimeout(function () {
			if (!msg.parentNode) return;
			msg.classList.add('fade-out');
			msg.classList.remove('fade-in');
			setTimeout(function () {
				if (msg.parentNode) msg.parentNode.removeChild(msg);
			}, 250);
		}, 5000);
	}
	return msg;
};

/* ==================================================================
 * ① 请求层
 * ================================================================== */
var api = {
	status: function (fresh) {
		return fetch(STATUS_URL + (fresh ? '?fresh=1' : ''), { cache: 'no-store' })
			.then(function (r) { return r.json(); })
			.catch(function (e) { return { error: String(e) }; });
	},
	ctl: function (q) {
		return fetch(CTL_URL + '?q=' + encodeURIComponent(q), { cache: 'no-store' })
			.then(function (r) { return r.json(); })
			.then(function (j) { return { ok: !!(j && j.ok), result: (j && j.result) || '' }; })
			.catch(function (e) { return { ok: false, result: String(e) }; });
	}
};

/* ==================================================================
 * ② 状态模型（单一来源）
 * ================================================================== */
var Model = {
	raw: null,
	bySec: {},
	byPort: {},

	load: function (st) {
		this.raw    = st || {};
		this.bySec  = {};
		this.byPort = {};
		var list = this.raw.devices || [];
		for (var i = 0; i < list.length; i++) {
			var d = list[i];
			if (d.sec)  this.bySec[d.sec] = d;
			if (d.port) this.byPort[String(d.port)] = d;
		}
		return this;
	},

	devices:   function ()  { return (this.raw && this.raw.devices) ? this.raw.devices : []; },
	error:     function ()  { return this.raw ? this.raw.error : null; },
	bySection: function (s) { return this.bySec[s] || null; },
	byPortKey: function (p) { return this.byPort[String(p)] || null; },

	/* ---- 「在线」 ---- */
	onlineText:  function (d) { return d ? (d.online ? _('在线') : _('离线')) : ''; },
	onlineColor: function (d) { return d ? (d.online ? '#0a7a0a' : '#999') : ''; },

	/* ---- 单元格取值（按 kind 统一分发）----
	   开关列（fw4/fw6）返回空：它们由 decorate() 注入的勾选框呈现 */
	cellText: function (d, kind) {
		if (kind === 'online') return this.onlineText(d);
		return '';
	},

	/* ---- 状态卡片汇总 ---- */
	summary: function () {
		var devs = this.devices();
		var total = devs.length, nOn = 0, fwPend = 0, fwNoLog = 0;

		for (var i = 0; i < devs.length; i++) {
			var d = devs[i];
			if (d.online) nOn++;
			if (d.fw_on && !d.fw_exists) fwPend++;
			if (d.fw_on && d.fw_exists && d.fw_enabled && !d.fw_log) fwNoLog++;
		}

		return {
			total: total, online: nOn,
			fwPending: fwPend, fwNoLog: fwNoLog,
			svcOk:  !!this.raw.running,
			depOk:  !!this.raw.etherwake,
			trigOk: this.raw.logread ? (fwPend === 0 && fwNoLog === 0) : true,
			iface:    this.raw.iface    || 'br-lan',
			throttle: this.raw.throttle || '60',
			logread:  !!this.raw.logread
		};
	}
};

/* ==================================================================
 * ③ 字段定义（单一来源：加字段只改这里）
 *    column = true → 进表格列；modal = true → 进「编辑」弹窗；type=Status → 只读状态列
 * ================================================================== */
var DEVICE_FIELDS = [
	{ key: 'enabled', type: 'Flag', title: _('启用'), column: true,
	  def: '1', required: true },

	{ key: 'name', type: 'Value', title: _('名称'), column: true,
	  placeholder: '我的电脑' },

	{ key: 'port', type: 'Value', title: _('外部端口'), column: true,
	  datatype: 'port', required: true, placeholder: '3389' },

	/* 目标端口也放进表格列：一眼能看清「外部端口 → 目标端口」
	   说明文字不放这里（表格里会显得很乱），统一放在状态卡片里 */
	{ key: 'dest_port', type: 'Value', title: _('目标端口'),
	  datatype: 'port', placeholder: '3389' },

	{ key: '_online', type: 'Status', title: _('在线'), column: true, kind: 'online' },
	{ key: '_fw4', type: 'Status', title: _('IPv4 端口转发'), column: true, kind: 'fw4' },
	{ key: '_fw6', type: 'Status', title: _('IPv6 放行'),     column: true, kind: 'fw6' },

	/* ---- 以下只出现在「编辑」弹窗 ---- */
	{ key: 'ip', type: 'Value', title: _('内网 IP'), modal: true,
	  datatype: 'ip4addr', required: true, placeholder: '192.168.1.10',
	  desc: _('用于 ping 判断是否在线；也是端口转发的目标地址') },

	{ key: 'mac', type: 'Value', title: _('MAC 地址'), modal: true,
	  datatype: 'macaddr', required: true, placeholder: 'aa:bb:cc:dd:ee:ff' },

	/* 注意：「启用转发」不在表单里 —— 它由表格中的「转发开 / 转发关」按钮
	   直接调用 CGI（setfw）实现，绕开 LuCI 的表单保存，行为确定可靠。 */

	{ key: 'proto', type: 'ListValue', title: _('转发协议'), modal: true, def: 'tcp',
	  values: [['tcp', 'TCP'], ['udp', 'UDP'], ['tcp udp', 'TCP + UDP']] },

	{ key: 'ipv6_allow', type: 'Flag', title: _('创建 IPv6 放行'), modal: true, def: '0',
	  required: true,
	  desc: _('打开后自动建一条 IPv6 放行规则（WOLAUTO-<外部端口>-V6）。' +
		'IPv6 没有 NAT，不需要端口转发，只需要在防火墙上放行这个端口。') +
		'<br />' +
		_('关掉会删除本应用建的 IPv6 规则（手工建的规则不动）。' +
		'这条规则也带日志，所以 IPv6 访问同样能触发自动唤醒') }
];

var GLOBAL_FIELDS = [
	{ key: 'enabled', type: 'Flag', title: _('启用服务'), def: '1', required: true },

	{ key: 'iface', type: 'Value', title: _('发包接口'), def: 'br-lan', required: true },

	{ key: 'throttle', type: 'Value', title: _('每设备节流（秒）'), def: '60',
	  datatype: 'uinteger', required: true,
	  desc: _('同一设备这段时间内只唤醒一次') },

	{ key: 'scan_mode', type: 'ListValue', title: _('在线检测方式'), def: 'ping', required: true,
	  values: [
		['ping',   _('自适应 ping（推荐）')],
		['hybrid', _('组合：先查邻居表，没有再 ping')],
		['arp',    _('纯被动：只读邻居表（零发包）')]
	  ],
	  desc: _('只影响界面显示，唤醒判断始终是实时 ping') },

	{ key: 'scan_interval', type: 'Value', title: _('扫描间隔（秒）'), def: '10',
	  datatype: 'uinteger', required: true },

	{ key: 'scan_online_sec', type: 'Value', title: _('在线设备扫描间隔（秒）'), def: '60',
	  datatype: 'uinteger', required: true,
	  desc: _('离线设备每轮都查，只有在线设备按这个间隔复查') },

	{ key: 'geo_enabled', type: 'Flag', title: _('归属地查询'), def: '1', required: true,
	  desc: _('查询来源 IP 的国家 / 省 / 市，显示在「最近唤醒记录」和「可疑来源 IP」里。' +
		'关闭后不再联网查询，也不显示已缓存的归属地。') },

	{ key: 'geo_source', type: 'ListValue', title: _('归属地查询方式'), def: 'online',
	  values: [
		['online', _('在线查询（国家 / 省 / 市）')],
		['local',  _('本地查询（不联网）')]
	  ],
	  desc: _('在线查询用 ip-api.com；本地查询默认只判断国内 / 国外。' +
		'勾选下面的「本地精确查询」并下载本地库后，可离线显示国家 / 省 / 市。') },

	{ key: 'geo_precise', type: 'Flag', title: _('本地精确查询'), def: '0',
	  depends: ['geo_source', 'local'],
	  desc: _('需要下载约 7MB 的 ip2region 本地库；只覆盖 IPv4，IPv6 只能判断国内 / 国外。') },

	{ key: 'ignore_foreign', type: 'Flag', title: _('忽略国外 IP'), def: '0', required: true,
	  desc: _('只唤醒中国大陆来源，国外来源只记日志') },

	{ key: 'cn_source', type: 'ListValue', title: _('国内 IP 数据来源'), def: 'openclash',
	  values: [
		['openclash', _('用 OpenClash 的数据文件（推荐）')],
		['download',  _('自己下载')]
	  ] },

	{ key: 'ignore_ipv6', type: 'Flag', title: _('忽略 IPv6 来源'), def: '1', required: true },

	{ key: 'wake_hairpin', type: 'Flag', title: _('内网走公网也能触发唤醒'), def: '0', required: true,
	  desc: _('在家用公网地址访问设备时也能触发') },

	{ key: 'blacklist_preset', type: 'Flag', title: _('使用国内扫描器预设黑名单'), def: '1', required: true,
	  desc: _('内置 18 段常见扫描器网段。如果你自己用云主机远程，可能会被挡') },

	{ key: 'autobl_enabled', type: 'Flag', title: _('启用自动黑名单'), def: '1', required: true,
	  desc: _('同一来源每分钟忽略次数或累计忽略次数达到阈值时，自动加入黑名单。' +
		'只对白名单以外的外网 IPv4 生效。') },

	{ key: 'autobl_per_min', type: 'Value', title: _('每分钟忽略次数'), def: '20',
	  datatype: 'uinteger', required: true,
	  desc: _('同一来源一分钟内被忽略达到这个次数就自动加入黑名单') },

	{ key: 'autobl_total', type: 'Value', title: _('总忽略次数'), def: '100',
	  datatype: 'uinteger', required: false,
	  desc: _('同一来源累计被忽略达到这个次数也加入黑名单；0 或留空表示不启用') },

	{ key: 'autobl_expire', type: 'Value', title: _('自动解封（小时）'), def: '',
	  datatype: 'uinteger', required: false,
	  desc: _('自动加入的条目到期后移除；留空或填 0 表示永久，只能手动解封') },

	{ key: 'blacklist_fw', type: 'Flag', title: _('黑名单加入防火墙规则'), def: '0', required: true,
	  desc: _('开启后把黑名单 IPv4 同时写入防火墙：WAN 入站和端口转发都 DROP。' +
		'关闭则只忽略唤醒，不拦截连接。') }
];

var LOGCLEAN_FIELDS = [
	{ key: 'logclean_enabled', type: 'Flag', title: _('启用定期清理'), def: '1', required: true },

	{ key: 'logclean_interval', type: 'Value', title: _('检查间隔（小时）'), def: '6',
	  datatype: 'uinteger', required: true },

	{ key: 'logclean_maxkb', type: 'Value', title: _('日志阈值（KB）'), def: '256',
	  datatype: 'uinteger', required: true,
	  desc: _('超过这个大小才清理') }
];

/* ==================================================================
 * ④ 构建器（唯一一处把定义变成 option 的逻辑）
 * ================================================================== */
function addStatusOption(section, def) {
	var o = section.option(form.Value, def.key, def.title);
	o.readonly = true;
	o.rmempty  = true;
	o.write    = function () { return Promise.resolve(); };
	o.remove   = function () { return Promise.resolve(); };
	o.cfgvalue = function (section_id) {
		return Model.cellText(Model.bySection(section_id), def.kind);
	};
	return o;
}

function addField(section, def) {
	if (def.type === 'Status') return addStatusOption(section, def);

	var o = section.option(form[def.type], def.key, def.title);

	/* ★ 不要给 Flag 覆写 cfgvalue
	   本固件的 LuCI 用的是 CBI 框架，CBIFlagValue 的 renderWidget 用
	   `new ui.Checkbox(cfgvalue != null ? cfgvalue : this.default, ...)` 渲染，
	   而 parse() 里只要 rmempty=false 就一定会 write()。
	   之前为了"避免值等于 default 被跳过写入"给 Flag 加了 cfgvalue 覆盖，
	   但该覆盖里 this.super('cfgvalue', ...) 在这个框架下取不到父实现，
	   导致 cfgvalue 永远返回默认值 —— 勾选框每次重绘都弹回，看起来"按了没反应"。
	   结论：Flag 只设 default + rmempty=false，其余交给框架。 */
	if (def.def !== undefined) o.default = def.def;

	if (def.required)          o.rmempty     = false;
	if (def.placeholder)       o.placeholder = def.placeholder;
	if (def.datatype)          o.datatype    = def.datatype;
	if (def.desc)              o.description = def.desc;
	if (def.rows)              o.rows        = def.rows;
	if (def.modal)             o.modalonly   = true;
	if (def.depends)           o.depends(def.depends[0], def.depends[1]);
	if (def.values)            def.values.forEach(function (v) { o.value(v[0], v[1]); });

	/* 这里【绝不】设 o.editable —— 它与 o.modalonly 互斥，
	   会让「启用 / 启用转发」的勾选状态显示错误（旧版就栽在这上面） */
	return o;
}

/*
 * 高级设置里的字段仍然写回 wol_autowake.settings（不新增 UCI section 类型），
 * 这样后端 config_get settings 完全不用改。
 */
function addAdvancedField(section, def) {
	var o = addField(section, def);
	if (!o) return o;
	o.cfgvalue = function () {
		return this.map.data.get('wol_autowake', 'settings', def.key);
	};
	o.write = function (section_id) {
		var v = this.formvalue(section_id);
		if (v != null)
			this.map.data.set('wol_autowake', 'settings', def.key, v);
		return Promise.resolve();
	};
	o.remove = function () {
		this.map.data.set('wol_autowake', 'settings', def.key, '');
		return Promise.resolve();
	};

	return o;
}

function parseTagList(v) {
	var out = [], seen = {};
	String(v || '').split(/[\s,;]+/).forEach(function (x) {
		x = x.trim();
		if (!x || seen[x]) return;
		seen[x] = 1;
		out.push(x);
	});
	return out;
}

/* 只读输入框：让归属地/来源/次数/过期时间也显示成原生输入框的样子 */
function roBox(v) {
	return E('input', {
		type: 'text',
		class: 'cbi-input-text wo-ro',
		value: (v == null ? '' : String(v)),
		readonly: 'readonly',
		tabindex: '-1'
	});
}

/* 填入 IP 后自动查归属地（防抖 500ms） */
var geoLookupTimer = null;
function lookupGeo(ip, box, onResult) {
	if (!ip || !/^[0-9a-fA-F:.]+$/.test(ip)) return;
	if (geoLookupTimer) clearTimeout(geoLookupTimer);
	geoLookupTimer = setTimeout(function () {
		api.ctl('geo:' + ip).then(function (r) {
			if (r && r.ok && r.result) {
				box.value = r.result;
				if (onResult) onResult(ip, r.result);
			}
		});
	}, 500);
}

/* 让字段行占满整行，减少左边标题列留下的空白 */
function markWide(root) {
	function apply() {
		try {
			var v = root.closest ? root.closest('.cbi-value') : null;
			if (v) v.classList.add('wo-wide');
		} catch (e) { /* 忽略 */ }
	}
	if (typeof requestAnimationFrame === 'function')
		requestAnimationFrame(apply);
	else
		setTimeout(apply, 0);
}

/* 白名单：表格，一条一行，可增删、上下移动 */
function renderWhitelistEditor(o, section_id, cfgvalue, st) {
	var manual = parseTagList(cfgvalue);
	var LIST_KEY = 'whitelist';
	var geoMap = {}, counts = {};
	WOL_LISTS.whitelist = manual;
	WOL_LISTS.whitelistReady = true;
	var hidden = E('input', {
		type: 'hidden',
		id: o.cbid(section_id),
		value: manual.join(' ')
	});
	var tbody = E('tbody', {});
	var table = E('table', { class: 'table cbi-section-table' }, [
		E('colgroup', {}, [
			E('col', { style: 'width:16%' }),
			E('col', { style: 'width:16%' }),
			E('col', { style: 'width:16%' }),
			E('col', { style: 'width:16%' }),
			E('col', { style: 'width:16%' }),
			E('col', { style: 'width:20%' })
		]),
		E('thead', {}, E('tr', {}, [
			E('th', {}, _('IP 地址')),
			E('th', {}, _('归属地')),
			E('th', {}, _('来源')),
			E('th', {}, _('访问次数')),
			E('th', {}, _('过期时间')),
			E('th', {}, _('操作'))
		])),
		tbody
	]);

	function sync() {
		hidden.value = manual.join(' ');
	}


	function paint() {
		while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
		manual.forEach(function (ip, idx) {
			var ipInput = E('input', {
				type: 'text',
				class: 'cbi-input-text',
				value: ip,
				readonly: 'readonly',
				style: 'width:100%'
			});
			var geoBox = roBox(geoMap[ip] || '');
			ipInput.addEventListener('input', function () {
				manual[idx] = ipInput.value.trim();
				geoBox.value = '';
				sync();
				lookupGeo(manual[idx], geoBox, function (ip2, text) {
					geoMap[ip2] = text;
				});
			});
			var edit = E('button', { type: 'button', class: 'btn cbi-button' }, _('编辑'));
			edit.addEventListener('click', function (ev) {
				ev.preventDefault();
				ipInput.readOnly = false;
				ipInput.focus();
				ipInput.select();
			});
			var del = E('button', { type: 'button', class: 'btn cbi-button cbi-button-remove' }, _('删除'));
			del.addEventListener('click', function (ev) {
				ev.preventDefault();
				manual.splice(idx, 1);
				sync();
				paint();
				api.ctl('setlist:' + LIST_KEY + ':' + manual.join(' ')).then(function (r) {
					ui.addNotification(null, E('p', {}, r.result));
				});
			});
			var save = E('button', { type: 'button', class: 'btn cbi-button cbi-button-action' }, _('保存'));
			save.addEventListener('click', function (ev) {
				ev.preventDefault();
				ipInput.readOnly = true;
				sync();
				api.ctl('setlist:' + LIST_KEY + ':' + manual.join(' ')).then(function (r) {
					ui.addNotification(null, E('p', {}, r.result));
				});
			});
			tbody.appendChild(E('tr', {}, [
				E('td', {}, ipInput),
				E('td', {}, geoBox),
				E('td', {}, roBox(_('手动'))),
				E('td', {}, roBox(counts[ip] != null ? counts[ip] : 0)),
				E('td', {}, roBox(_('永久'))),
				E('td', { class: 'cbi-section-table-cell nowrap wo-bl-ops' }, [edit, del, save])
			]));
		});
		/* 固定保留一行空白输入框（新增用） */
		tbody.appendChild(E('tr', { class: 'wo-bl-addrow' }, [
			E('td', {}, input),
			E('td', {}, blankGeo),
			E('td', {}, roBox(_('手动'))),
			E('td', {}, roBox('')),
			E('td', {}, roBox(_('永久'))),
			E('td', { class: 'cbi-section-table-cell nowrap wo-bl-ops' })
		]));
	}

	var input = E('input', {
		type: 'text',
		class: 'cbi-input-text',
		placeholder: _('IP 或 CIDR，回车添加')
	});
	var blankGeo = roBox('');
	var addBtn = E('button', { type: 'button', class: 'btn cbi-button cbi-button-add' }, _('添加'));

	function add() {
		var raw = (input.value || '').trim();
		if (!raw) return;
		if (!/^[0-9a-fA-F:.]+(\/[0-9]{1,3})?$/.test(raw)) {
			ui.addNotification(null, E('p', {}, _('格式不对：请输入 IPv4 / IPv6 或 CIDR')));
			return;
		}
		if (manual.indexOf(raw) < 0) manual.push(raw);
		lookupGeo(raw, blankGeo, function (ip2, text) {
			geoMap[ip2] = text;
			paint();
		});
		input.value = '';
		blankGeo.value = '';
		sync();
		paint();
		api.ctl('setlist:whitelist:' + manual.join(' ')).then(function (r) {
			ui.addNotification(null, E('p', {}, r.result));
		});
		input.focus();
	}

	addBtn.addEventListener('click', function (ev) { ev.preventDefault(); add(); });
	input.addEventListener('input', function () {
		blankGeo.value = '';
		lookupGeo(input.value.trim(), blankGeo, function (ip2, text) {
			geoMap[ip2] = text;
		});
	});
	input.addEventListener('keydown', function (ev) {
		if (ev.key === 'Enter') { ev.preventDefault(); add(); }
	});

	paint();
	sync();

	if (st) {
		geoMap = (st.geo) || {};
		counts = {};
		(st.seen || []).forEach(function (x) { counts[x.ip] = x.n; });
		paint();
	}

	var root = E('div', { class: 'wo-bl-editor' }, [
		hidden,
		table,
		E('div', { class: 'cbi-section-create cbi-tblsection-create' }, [addBtn])
	]);
	markWide(root);
	return root;
}

function renderBlacklistEditor(o, section_id, cfgvalue, st) {
	var manual = parseTagList(cfgvalue);
	var manualExp = {};
	var auto = [];
	if (st && st.blacklist && st.blacklist.length) {
		manual = [];
		auto = [];
		st.blacklist.forEach(function (e) {
			if (e.source === 'auto') auto.push({ ip: e.ip, expire: Number(e.expire) || 0 });
			else { manual.push(e.ip); manualExp[e.ip] = Number(e.expire) || 0; }
		});
	}
	var geoMap = {}, counts = {};
	WOL_LISTS.blacklist = manual;
	WOL_LISTS.blacklistReady = true;
	var hidden = E('input', {
		type: 'hidden',
		id: o.cbid(section_id),
		value: manual.join(' ')
	});
	var tbody = E('tbody', {});
	var table = E('table', { class: 'table cbi-section-table' }, [
		E('colgroup', {}, [
			E('col', { style: 'width:16%' }),
			E('col', { style: 'width:16%' }),
			E('col', { style: 'width:16%' }),
			E('col', { style: 'width:16%' }),
			E('col', { style: 'width:16%' }),
			E('col', { style: 'width:20%' })
		]),
		E('thead', {}, E('tr', {}, [
			E('th', {}, _('IP 地址')),
			E('th', {}, _('归属地')),
			E('th', {}, _('来源')),
			E('th', {}, _('访问次数')),
			E('th', {}, _('过期时间')),
			E('th', {}, _('操作'))
		])),
		tbody
	]);

	function sync() {
		hidden.value = manual.join(' ');
	}

	function fmtExpire(exp) {
		if (!exp) return '';
		var d = new Date(exp * 1000);
		function p(n) { return (n < 10 ? '0' : '') + n; }
		return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
			' ' + p(d.getHours()) + ':' + p(d.getMinutes());
	}

	function hoursOf(exp) {
		if (!exp) return '';
		var h = Math.round((exp - Date.now() / 1000) / 3600);
		return h > 0 ? String(h) : '';
	}

	function saveAll() {
		sync();
		var lines = manual.map(function (ip) {
			return ip + '|' + (manualExp[ip] || 0) + '|manual';
		}).concat(auto.filter(function (it) {
			return manual.indexOf(it.ip) < 0;
		}).map(function (it) {
			return it.ip + '|' + (it.expire || 0) + '|auto';
		}));
		return api.ctl('setblacklist:' + lines.join(';')).then(function (r) {
			ui.addNotification(null, E('p', {}, r.result));
		});
	}


	function paint() {
		while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

		manual.forEach(function (ip, idx) {
			var ipInput = E('input', {
				type: 'text',
				class: 'cbi-input-text',
				value: ip,
				readonly: 'readonly',
				style: 'width:100%'
			});
			var geoBox = roBox(geoMap[ip] || '');
			var expInput = E('input', {
				type: 'text',
				class: 'cbi-input-text',
				value: fmtExpire(manualExp[ip] || 0),
				placeholder: _('永久'),
				readonly: 'readonly',
				style: 'width:100%'
			});
			ipInput.addEventListener('input', function () {
				manual[idx] = ipInput.value.trim();
				geoBox.value = '';
				sync();
				lookupGeo(manual[idx], geoBox, function (ip2, text) {
					geoMap[ip2] = text;
				});
			});
			var edit = E('button', { type: 'button', class: 'btn cbi-button' }, _('编辑'));
			edit.addEventListener('click', function (ev) {
				ev.preventDefault();
				ipInput.readOnly = false;
				expInput.readOnly = false;
				expInput.value = hoursOf(manualExp[ip] || 0);
				ipInput.focus();
				ipInput.select();
			});
			var del = E('button', { type: 'button', class: 'btn cbi-button cbi-button-remove' }, _('删除'));
			del.addEventListener('click', function (ev) {
				ev.preventDefault();
				manual.splice(idx, 1);
				sync();
				paint();
				saveAll();
			});
			var save = E('button', { type: 'button', class: 'btn cbi-button cbi-button-action' }, _('保存'));
			save.addEventListener('click', function (ev) {
				ev.preventDefault();
				var h = Number(expInput.value);
				if (!isFinite(h) || h < 0) h = 0;
				manualExp[ip] = h > 0 ? Math.floor(Date.now() / 1000 + h * 3600) : 0;
				ipInput.readOnly = true;
				expInput.readOnly = true;
				saveAll();
				paint();
			});
			tbody.appendChild(E('tr', {}, [
				E('td', {}, ipInput),
				E('td', {}, geoBox),
				E('td', {}, roBox(_('手动'))),
				E('td', {}, roBox(counts[ip] != null ? counts[ip] : 0)),
				E('td', {}, expInput),
				E('td', { class: 'cbi-section-table-cell nowrap wo-bl-ops' }, [edit, del, save])
			]));
		});

		auto.forEach(function (it, idx) {
			if (manual.indexOf(it.ip) >= 0) return;
			var aip = E('input', {
				type: 'text', class: 'cbi-input-text', value: it.ip,
				readonly: 'readonly', style: 'width:100%'
			});
			var ageo = roBox(geoMap[it.ip] || '');
			var aexp = E('input', {
				type: 'text', class: 'cbi-input-text', value: fmtExpire(it.expire),
				placeholder: _('永久'), readonly: 'readonly', style: 'width:100%'
			});
			var edit = E('button', { type: 'button', class: 'btn cbi-button' }, _('编辑'));
			edit.addEventListener('click', function (ev) {
				ev.preventDefault();
				aip.readOnly = false;
				aexp.readOnly = false;
				aexp.value = hoursOf(it.expire);
				aip.focus();
				aip.select();
			});
			var del = E('button', { type: 'button', class: 'btn cbi-button cbi-button-remove' }, _('删除'));
			del.addEventListener('click', function (ev) {
				ev.preventDefault();
				auto.splice(idx, 1);
				saveAll();
				paint();
			});
			var save = E('button', { type: 'button', class: 'btn cbi-button cbi-button-action' }, _('保存'));
			save.addEventListener('click', function (ev) {
				ev.preventDefault();
				var h = Number(aexp.value);
				if (!isFinite(h) || h < 0) h = 0;
				it.ip = aip.value.trim();
				it.expire = h > 0 ? Math.floor(Date.now() / 1000 + h * 3600) : 0;
				aip.readOnly = true;
				aexp.readOnly = true;
				saveAll();
				paint();
			});
			tbody.appendChild(E('tr', {}, [
				E('td', {}, aip),
				E('td', {}, ageo),
				E('td', {}, roBox(_('自动'))),
				E('td', {}, roBox(counts[it.ip] != null ? counts[it.ip] : 0)),
				E('td', {}, aexp),
				E('td', { class: 'cbi-section-table-cell nowrap wo-bl-ops' }, [edit, del, save])
			]));
		});

		/* 固定保留一行空白输入框（新增用） */
		tbody.appendChild(E('tr', { class: 'wo-bl-addrow' }, [
			E('td', {}, input),
			E('td', {}, blankGeo),
			E('td', {}, roBox(_('手动'))),
			E('td', {}, roBox('')),
			E('td', {}, inputExp),
			E('td', { class: 'cbi-section-table-cell nowrap wo-bl-ops' })
		]));
	}

	var input = E('input', {
		type: 'text',
		class: 'cbi-input-text',
		placeholder: _('IP 或 CIDR，回车添加')
	});
	var blankGeo = roBox('');
	var inputExp = E('input', {
		type: 'text',
		class: 'cbi-input-text',
		placeholder: _('永久')
	});
	var addBtn = E('button', { type: 'button', class: 'btn cbi-button cbi-button-add' }, _('添加'));

	function add() {
		var raw = (input.value || '').trim();
		if (!raw) return;
		if (!/^[0-9a-fA-F:.]+(\/[0-9]{1,3})?$/.test(raw)) {
			ui.addNotification(null, E('p', {}, _('格式不对：请输入 IPv4 / IPv6 或 CIDR')));
			return;
		}
		if (auto.some(function (x) { return x.ip === raw; })) {
			ui.addNotification(null, E('p', {}, _('这个 IP 已经在自动黑名单里')));
			return;
		}
		if (manual.indexOf(raw) < 0) manual.push(raw);
		var h = Number(inputExp.value);
		if (!isFinite(h) || h < 0) h = 0;
		manualExp[raw] = h > 0 ? Math.floor(Date.now() / 1000 + h * 3600) : 0;
		lookupGeo(raw, blankGeo, function (ip2, text) {
			geoMap[ip2] = text;
			paint();
		});
		input.value = '';
		blankGeo.value = '';
		inputExp.value = '';
		sync();
		saveAll();
		paint();
		input.focus();
	}

	addBtn.addEventListener('click', function (ev) { ev.preventDefault(); add(); });
	input.addEventListener('input', function () {
		blankGeo.value = '';
		lookupGeo(input.value.trim(), blankGeo, function (ip2, text) {
			geoMap[ip2] = text;
		});
	});
	input.addEventListener('keydown', function (ev) {
		if (ev.key === 'Enter') { ev.preventDefault(); add(); }
	});

	paint();
	sync();

	if (st) {
		if (!(st.blacklist && st.blacklist.length)) auto = (st.autobl) || [];
		geoMap = (st.geo) || {};
		counts = {};
		(st.seen || []).forEach(function (x) { counts[x.ip] = x.n; });
		paint();
	}

	var root = E('div', { class: 'wo-bl-editor' }, [
		hidden,
		table,
		E('div', { class: 'cbi-section-create cbi-tblsection-create' }, [addBtn])
	]);
	markWide(root);
	return root;
}

/* ==================================================================
 * ⑤ 渲染后修饰：按【列名】定位单元格，接管状态格 + 插唤醒按钮
 * ================================================================== */
var LIVE = [];   /* [{el, port, kind}] —— 轮询时就地刷新 */
var WOL_LISTS = window.__wolLists = window.__wolLists || {
	whitelist: [], blacklist: [],
	whitelistReady: false, blacklistReady: false
};

function columnIndex(table, title) {
	var ths = table.querySelectorAll('thead th');
	for (var i = 0; i < ths.length; i++) {
		if ((ths[i].textContent || '').trim() === title) return i;
	}
	return -1;
}

function paintLive() {
	LIVE.forEach(function (it) {
		if (!it || !it.el) return;
		var d = Model.byPortKey(it.port);
		try {
			if (it.cb) {
				/* 开关列：只同步勾选状态 */
				if (it.kind === 'fw4') it.cb.checked = !!(d && d.fw_on);
				else                   it.cb.checked = !!(d && d.fw6_exists && d.fw6_enabled);
				it.cb.disabled = false;
			} else if (it.kind === 'online') {
				var txt = Model.onlineText(d);
				var col = Model.onlineColor(d);
				var inp = it.el.querySelector ? it.el.querySelector('input') : null;
				if (inp) { inp.value = txt; inp.style.color = col; }
				else     { it.el.textContent = txt; it.el.style.color = col; }
			}
		} catch (e) { /* 忽略 */ }
	});
}

function decorate(formNode, onWoke) {
	LIVE = [];
	try {
		var tables = formNode.querySelectorAll('table.cbi-section-table');

		Array.prototype.forEach.call(tables, function (tb) {
			var iPort   = columnIndex(tb, _('外部端口'));
			var iOnline = columnIndex(tb, _('在线'));
			var iFw4    = columnIndex(tb, _('IPv4 端口转发'));
			var iFw6    = columnIndex(tb, _('IPv6 放行'));

			var rows = tb.querySelectorAll('tbody > tr');
			if (!rows || !rows.length) rows = tb.querySelectorAll('tr');

			Array.prototype.forEach.call(rows, function (tr) {
				var tds = tr.querySelectorAll('td');
				if (!tds || tds.length < 3) return;      /* 表头是 th，天然跳过 */

				var port = '';
				if (iPort >= 0 && tds[iPort])
					port = (tds[iPort].textContent || '').trim().split(/[\s→]/)[0];
				if (!port) return;

				if (iOnline >= 0 && tds[iOnline])
					LIVE.push({ el: tds[iOnline], port: port, kind: 'online' });

				/* 两个开关列做成勾选框：勾 = 启用，不勾 = 关闭 */
				function mkToggle(idx, kind, action, title) {
					if (idx < 0 || !tds[idx]) return;
					var cell = tds[idx];
					var cb = cell.querySelector('input.wo-cb');
					if (!cb) {
						/* 清掉原来的只读文本框，只留一个居中复选框 */
						while (cell.firstChild) cell.removeChild(cell.firstChild);
						cb = E('input', {
							type: 'checkbox',
							class: 'wo-cb',
							style: 'width:16px;height:16px;cursor:pointer;margin:0;display:inline-block;vertical-align:middle'
						});
						cb.addEventListener('change', function (ev) {
							if (ev && ev.stopPropagation) ev.stopPropagation();
							cb.disabled = true;
							api.ctl(action + ':' + port + ':' + (cb.checked ? '1' : '0'))
								.then(function (r) {
									ui.addNotification(null, E('p', {}, r.result));
									if (typeof onWoke === 'function') return onWoke();
								})
								.then(function () { cb.disabled = false; },
								      function () { cb.disabled = false; });
						});
						/* 居中：单元格 + 表头都设成 center，并用一层 100% 宽的居中容器包住勾选框 */
						cell.style.textAlign = 'center';
						cell.style.verticalAlign = 'middle';
						cell.style.paddingLeft = '0';
						cell.style.paddingRight = '0';
						var cbWrap = E('div', { style: 'text-align:center;width:100%;line-height:1;margin:0;padding:0' }, cb);
						cell.appendChild(cbWrap);
						try {
							/* 从 td 往上找到 table（td -> tr -> tbody -> table） */
							var node = cell;
							while (node && node.tagName && node.tagName.toLowerCase() !== 'table') node = node.parentNode;
							var ths = node ? node.querySelectorAll('thead th') : null;
							if (ths && ths[idx]) {
								ths[idx].style.textAlign = 'center';
								ths[idx].style.paddingLeft = '0';
								ths[idx].style.paddingRight = '0';
							}
						} catch (e2) { /* 忽略 */ }
					}
					cb.title = title;
					LIVE.push({ el: cell, cb: cb, port: port, kind: kind });
				}

				mkToggle(iFw4, 'fw4', 'setfw', _('勾选 = 放行 IPv4（端口转发生效）；取消 = 关闭（规则保留但停用）'));
				mkToggle(iFw6, 'fw6', 'setv6', _('勾选 = 放行 IPv6；取消 = 移除 IPv6 放行规则'));

				/* 动作格：只留「唤醒」（编辑/删除是 LuCI 自带的） */
				var cell = tds[tds.length - 1];
				if (cell) {
					/* 别压宽度！之前设 width:1% 把「删除」按钮挤到文字溢出 */
					cell.style.whiteSpace  = 'nowrap';
					cell.style.paddingLeft = '6px';
					cell.style.paddingRight = '10px';
					cell.style.textAlign   = 'right';
				}
				if (cell && !cell.querySelector('.wo-wake')) {
					var wbtn = E('button', {
						class: 'cbi-button cbi-button-action wo-wake',
						/* 不加自定义 padding/字号 —— 完全跟 LuCI 的「编辑」「删除」一致 */
						style: 'margin-right:6px;white-space:nowrap',
						title: _('唤醒这台设备')
					}, _('唤醒'));

					wbtn.addEventListener('click', function (ev) {
						if (ev && ev.stopPropagation) ev.stopPropagation();
						if (ev && ev.preventDefault)   ev.preventDefault();
						api.ctl('wake:' + port).then(function (r) {
							ui.addNotification(null, E('p', {},
								_('端口 %s：%s').format(port, r.result)));
							if (typeof onWoke === 'function') return onWoke();
						});
					});

					cell.insertBefore(wbtn, cell.firstChild);
				}
			});
		});
	} catch (e) { /* 修饰失败不影响其他功能 */ }

	paintLive();
}

/* ==================================================================
 * 页面
 * ================================================================== */
	/* 同一视图服务两个菜单入口：/wol-autowake = 设备页，/wol-autowake/cfg = 设置页 */
	return view.extend({
	load: function () {
		return api.status().then(function (st) { Model.load(st); return st; });
	},

	render: function (initial) {
		var self = this;

		/* ---------------- 通用小控件 ---------------- */
		function badge(ok, text) {
			return E('span', {
				style: 'display:inline-block;padding:2px 10px;margin-right:8px;border-radius:11px;' +
					'font-size:92%;font-weight:bold;white-space:nowrap;background:' +
					(ok ? 'rgba(0,150,0,.15)' : 'rgba(217,119,6,.18)') +
					';color:' + (ok ? '#0a7a0a' : '#b45309')
			}, text);
		}

		function infoRow(label, value, ok) {
			return E('div', { class: 'wo-kv' }, [
				E('span', { class: 'k' }, label),
				E('span', { class: 'v' + (ok === false ? ' bad' : '') }, value)
			]);
		}

		/* 状态标签：ok 绿色 / 否则灰色 */
		function pill(ok, text, tone) {
			var tones = {
				ok:   ['rgba(10,150,60,.12)',  '#0a7a3a', 'rgba(10,150,60,.30)'],
				info: ['rgba(43,108,176,.12)', '#2b6cb0', 'rgba(43,108,176,.30)'],
				warn: ['rgba(190,120,0,.14)',  '#a86400', 'rgba(190,120,0,.30)'],
				bad:  ['rgba(200,0,0,.10)',    '#c00',    'rgba(200,0,0,.28)'],
				off:  ['rgba(128,128,128,.12)','#777',    'rgba(128,128,128,.24)']
			};
			var t = tone || (ok ? 'ok' : 'off');
			var c = tones[t] || tones.off;
			return E('span', {
				class: 'wo-pill',
				style: 'background:' + c[0] + ';color:' + c[1] + ';border-color:' + c[2]
			}, [
				E('span', { class: 'wo-pill-dot', style: 'background:' + c[1] }),
				text
			]);
		}/* ---------------- 状态卡片 ---------------- */
		var statusBox = E('div', { style: 'padding:0' }, E('em', {}, _('正在读取状态…')));

		function paintStatus(st) {
			Model.load(st);

			while (statusBox.firstChild) statusBox.removeChild(statusBox.firstChild);

			if (!st || st.error) {
				statusBox.appendChild(E('div', { class: 'alert-message error' }, [
					E('strong', {}, _('无法读取状态')),
					E('pre', { style: 'white-space:pre-wrap;margin:6px 0 0' },
						(st && st.error) ? st.error : _('GET /cgi-bin/wol-status 未返回有效 JSON'))
				]));
				return;
			}

			var s = Model.summary();
			var svcOk = s.svcOk, depOk = s.depOk, trigOk = s.trigOk;
			var ready = svcOk && depOk && trigOk;
			var f = st.filter || {};

			/* ---- 顶部：结论 + 全部唤醒 ---- */
			statusBox.appendChild(E('div', {
				style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px'
			}, [
				badge(ready, ready ? _('● 就绪') : _('⚠️ 有 %d 项待处理').format(
					(svcOk ? 0 : 1) + (depOk ? 0 : 1) + (trigOk ? 0 : 1))),
				E('span', { style: 'flex:1' }),
				E('button', {
					class: 'cbi-button cbi-button-action',
					click: ui.createHandlerFn(self, function () {
						return api.ctl('wakeall').then(function (r) {
							ui.addNotification(null, E('p', {}, r.result));
							return refreshAll();
						});
					})
				}, _('全部唤醒'))
			]));

			/* ---- 四个数字块 ---- */
			function tile(n, label, color) {
				return E('div', { class: 'wo-stat' }, [
					E('div', { class: 'n', style: color ? 'color:' + color : '' }, String(n)),
					E('div', { class: 'l' }, label)
				]);
			}
			statusBox.appendChild(E('div', { class: 'wo-stats' }, [
				tile(s.total, _('设备总数')),
				tile(s.online, _('当前在线'), s.online > 0 ? '#0a7a0a' : ''),
				tile(Number(f.ign) || 0, _('今日忽略')),
				tile(Number(f.woke) || 0, _('今日唤醒'), '#0a7a0a'),
				tile(Number(f.bl_today) || 0, _('今日黑名单'))
			]));

			/* ---- 三个状态标签 ---- */
			var pills = E('div', { class: 'wo-pills' }, [
				pill(svcOk, svcOk ? _('服务运行中') : _('服务未运行'), svcOk ? 'ok' : 'bad'),
				pill(depOk, depOk ? _('etherwake 已装') : _('缺 etherwake'), depOk ? 'ok' : 'bad'),
				pill(trigOk, trigOk ? _('转发日志正常') : _('转发日志异常'), trigOk ? 'ok' : 'warn')
			]);
			statusBox.appendChild(pills);

			/* ---- 过滤状态行 ---- */
			var frow = E('div', { class: 'wo-filter-row' }, [
				E('span', { class: 'wo-filter-item' }, [
					E('span', { class: 'wo-label' }, _('过滤')),
					pill(f.on, f.on ? _('忽略国外') : _('国外放行'), f.on ? 'ok' : 'info')
				])
			]);
			if (f.on) {
				frow.appendChild(E('span', { class: 'wo-filter-item' }, [
					E('span', { class: 'wo-label' }, _('数据')),
					E('b', {}, (f.src === 'download' ? _('自建下载') : _('OpenClash'))
						+ ' · ' + (Number(f.cn) || 0) + _(' 条'))
				]));
			}
			frow.appendChild(E('span', { class: 'wo-filter-item' }, [
				E('span', { class: 'wo-label' }, _('IPv6')),
				pill(f.ipv6, f.ipv6 ? _('忽略') : _('放行'), f.ipv6 ? 'ok' : 'info')
			]));
			statusBox.appendChild(frow);

			/* ---- 目标端口说明 ---- */

			if (!trigOk)
				statusBox.appendChild(E('div', { class: 'alert-message warning', style: 'margin:10px 0 0' },
					_('「端口转发」或「日志」没同步好时，自动唤醒不会触发。到上面的设备列表检查对应设备，保存一次即可自动修好。')));

			/* 过滤开了但国内 IP 表不可用 —— 必须提示，否则会以为在挡其实没挡 */
			if (f.on && !f.cn_ok)
				statusBox.appendChild(E('div', { class: 'alert-message error', style: 'margin:10px 0 0' },
					_('「忽略国外 IP」已打开，但国内 IP 表不可用（0 条）—— 过滤当前不生效！' +
						'到全局设置点「重建国内 IP 表」，或检查 OpenClash 的数据文件是否存在。')));

			/* 目标端口是 3389（含留空默认成 3389）—— 安全提醒 */
			var risky = [];
			(Model.devices() || []).forEach(function (d) {
				if (String(d.dest_port) === '3389') risky.push(d.name || d.mac || d.port);
			});
			if (risky.length) {
				statusBox.appendChild(E('div', { class: 'alert-message warning', style: 'margin:10px 0 0' }, [
					E('strong', {}, _('⚠️ 目标端口为默认端口，存在暴露风险')),
					E('br'),
					E('span', {}, _('设备 %s 的目标端口为默认端口（3389），防止暴露风险，' +
						'请尽快修改本机远程桌面服务端口。').format(risky.join('、'))),
					E('br'),
					E('span', { style: 'opacity:.75;font-size:92%' },
						_('改完本机端口后，到这里把该设备的「目标端口」改成同样的端口即可（外部端口不必改）'))
				]));
			}
		}


			/* 渲染后用 DOM 强制居中：主题 CSS 和内联属性都可能被覆盖，这里直接改元素 */
			function forceCenter(tbl) {
				if (!tbl || !tbl.querySelectorAll) return;
				var cells = tbl.querySelectorAll('th, td');
				for (var i = 0; i < cells.length; i++) {
					cells[i].style.textAlign = 'center';
				}
			}

			/*
			 * 设置页：把字段按功能装进独立小卡片
			 *   逐个遍历 .cbi-value 行，遇到某组第一个字段时新建一张卡片，
			 *   后续行搬进卡片，直到遇到下一组的第一个字段。
			 */
		/* ---------------- 可疑来源 IP ---------------- */
		var seenBox = E('div', {});
		var seenExpanded = false;
		var seenLast = null;          /* 记住最后一次状态，展开/收起时复用 */

		function paintSeen(st) {
			if (st) seenLast = st;
			var src = seenLast;
			while (seenBox.firstChild) seenBox.removeChild(seenBox.firstChild);

			var list = (src && src.seen) || [];
			var geoMap = (src && src.geo) || {};
			if (!list.length) {
				seenBox.appendChild(E('em', {}, _('(日志里还没有出现过外部来源。设备关机后被外部连接一次，这里就会出现)')));
				return;
			}

			/* 折叠：默认只显示前 10 条，展开后最多显示全部（后端已限制 50 条） */
			var LIMIT = 10;
			var shown = seenExpanded ? list : list.slice(0, LIMIT);

			var tbody = E('tbody', {});
			shown.forEach(function (it) {
				var isV6 = String(it.ip).indexOf(':') >= 0;
				var geoText = geoMap[it.ip] || '';
				var locTxt = geoText || (isV6 ? _('IPv6') : (it.cn ? _('国内') : _('国外')));
				var locCol = geoText ? '#333' : (isV6 ? '#666' : (it.cn ? '#0a7a0a' : '#c00'));

				var opCell;
				if (it.bl) {
					opCell = E('span', {}, [
						E('span', { style: 'color:#999;margin-right:8px' }, _('已在黑名单')),
						E('button', {
							type: 'button',
							class: 'cbi-button',
							click: ui.createHandlerFn(self, function () {
								return api.ctl('unblock:' + it.ip).then(function (r) {
									ui.addNotification(null, E('p', {}, r.result));
									return refreshAll();
								});
							})
						}, _('移出'))
					]);
				} else {
					opCell = E('button', {
						type: 'button',
						class: 'cbi-button cbi-button-action',
						click: ui.createHandlerFn(self, function () {
							return api.ctl('block:' + it.ip).then(function (r) {
								ui.addNotification(null, E('p', {}, r.result));
								return refreshAll();
							});
						})
					}, _('加入黑名单'));
				}

				tbody.appendChild(E('tr', {}, [
					E('td', { style: 'text-align:center !important' }, it.last || ''),
					E('td', { class: 'wo-dev' , style: 'text-align:center !important' }, it.dev || '-'),
					E('td', { class: 'wo-ip' , style: 'text-align:center !important' }, it.ip),
					E('td', { style: 'text-align:center !important;font-weight:bold' + (geoText ? '' : ';color:' + locCol) }, locTxt),
					E('td', { style: 'text-align:center !important;font-weight:bold' }, String(it.n)),
					E('td', { style: 'text-align:center !important' }, it.kind || ''),
					E('td', { style: 'text-align:center !important' }, opCell)
				]));
			});

			var tb = E('table', { class: 'table wo-seen' }, [
				E('colgroup', {}, [
					E('col', { style: 'width:17%' }),
					E('col', { style: 'width:14%' }),
					E('col', { style: 'width:18%' }),
					E('col', { style: 'width:17%' }),
					E('col', { style: 'width:8%' }),
					E('col', { style: 'width:10%' }),
					E('col', { style: 'width:16%' })
				]),
				E('thead', {}, E('tr', {}, [
					E('th', { style: 'text-align:center !important' }, _('最近')),
					E('th', { class: 'wo-dev' , style: 'text-align:center !important' }, _('设备')),
					E('th', { class: 'wo-ip' , style: 'text-align:center !important' }, _('来源 IP')),
					E('th', { style: 'text-align:center !important' }, _('归属地')),
					E('th', { style: 'text-align:center !important' }, _('次数')),
					E('th', { style: 'text-align:center !important' }, _('上次结果')),
					E('th', { style: 'text-align:center !important' }, _('操作'))
				])),
				tbody
			]);
			seenBox.appendChild(tb);

			/* 折叠控制条：默认只列最近 10 条，其余折叠；这里明确写出总数，避免误以为“显示不全” */
			if (list.length > LIMIT) {
				var hidden = list.length - LIMIT;
				seenBox.appendChild(E('div', {
					style: 'margin-top:8px;display:flex;flex-direction:column;align-items:center;gap:6px;color:#777;font-size:92%'
				}, [
					E('span', {}, seenExpanded
						? _('已展开全部 %d 个可疑来源').format(list.length)
						: _('共 %d 个可疑来源，当前显示最近 %d 个').format(list.length, LIMIT)),
					E('button', {
						class: 'cbi-button cbi-button-action',
						style: 'margin:0',
						click: ui.createHandlerFn(self, function () {
							seenExpanded = !seenExpanded;
							paintSeen(null);
							return Promise.resolve();
						})
					}, seenExpanded
						? _('收起其余 %d 个').format(hidden)
						: _('展开其余 %d 个').format(hidden))
				]));
			}
		}

		/* ---------------- 最近唤醒记录（成功唤醒 / 忽略记录，可切换）---------------- */
		var evBox = E('div', {});
		var evKind = '唤醒';          /* 当前查看：唤醒 = 成功唤醒记录，忽略 = 忽略记录 */
		var evExpanded = false;
		var evLast = null;

		/* 来源 IP 是否属于内网 / 回环 / 链路本地 —— 用于区分“本地唤醒 / 远程唤醒” */
		function isLocalSource(ip) {
			return /^(10\.|192\.168\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|fc|fd|fe8|fe9|fea|feb)/.test(String(ip || ''));
		}

		function paintEvents(st) {
			if (st) evLast = st;
			while (evBox.firstChild) evBox.removeChild(evBox.firstChild);

			var all = (evLast && evLast.events) || [];
			var list = all.filter(function (e) { return e.kind === evKind; });
			var geoMap = (evLast && evLast.geo) || {};
			var blSrc = {};
			((evLast && evLast.blacklist) || []).forEach(function (b) { blSrc[b.ip] = b.source; });

			/* 同 IP + 同设备折叠成一条，只显示次数 */
			var groups = [], gmap = {};
			list.forEach(function (e) {
				var key = String(e.ip) + '|' + String(e.dev);
				if (!gmap[key]) {
					gmap[key] = { e: e, count: 0 };
					groups.push(gmap[key]);
				}
				gmap[key].count += (Number(e.n) || 1);
			});
			list = groups.map(function (g) {
				g.e._count = g.count;
				return g.e;
			});

			function switchKind(k) {
				if (evKind === k) return;
				evKind = k;
				evExpanded = false;
				paintEvents(null);
			}

			/* 切换条：成功唤醒 / 忽略记录 */
			evBox.appendChild(E('div', {
				style: 'margin:0 0 10px;display:flex;gap:8px;flex-wrap:wrap'
			}, [
				E('button', {
					class: 'cbi-button' + (evKind === '唤醒' ? ' cbi-button-action' : ''),
					click: ui.createHandlerFn(self, function () { switchKind('唤醒'); return Promise.resolve(); })
				}, _('成功唤醒')),
				E('button', {
					class: 'cbi-button' + (evKind === '忽略' ? ' cbi-button-action' : ''),
					click: ui.createHandlerFn(self, function () { switchKind('忽略'); return Promise.resolve(); })
				}, _('忽略记录'))
			]));

			if (!list.length) {
				evBox.appendChild(E('em', {}, evKind === '唤醒'
					? _('(暂无成功唤醒记录)')
					: _('(暂无忽略记录)')));
				return;
			}

			/* 默认只显示最近 5 条，其余折叠 */
			var LIMIT = 5;
			var shown = evExpanded ? list : list.slice(0, LIMIT);

			var tbody = E('tbody', {});
			shown.forEach(function (e) {
				var isWake = (e.kind === '唤醒');
				var egeo = geoMap[e.ip] || '';
				var ipText = (e.ip && e.ip !== '手动') ? e.ip : '—';
				var whyText = e.why || '';
				if (isWake) {
					if (e.why === '手动唤醒') whyText = _('手动唤醒');
					else whyText = isLocalSource(e.ip) ? _('本地唤醒') : _('远程唤醒');
				}
				else if (/黑名单/.test(whyText)) {
					if (blSrc[e.ip] === 'auto') whyText = _('在自动黑名单中');
					else if (blSrc[e.ip] === 'manual') whyText = _('在手动黑名单中');
				}
				tbody.appendChild(E('tr', {}, [
					E('td', { class: 'wo-ip', style: 'text-align:center !important' }, e.ts || ''),
					E('td', { class: 'wo-dev' , style: 'text-align:center !important' }, e.dev || ''),
					E('td', { class: 'wo-ip' , style: 'text-align:center !important' }, ipText),
					E('td', { class: 'wo-geo' , style: 'text-align:center !important' }, egeo || '—'),
					E('td', { style: 'text-align:center !important;font-weight:bold' }, String(e._count || 1)),
					E('td', { style: 'text-align:center !important' }, e.port || '-'),
					E('td', { class: 'wo-dev' , style: 'text-align:center !important' }, whyText)
				]));
			});

			var evTbl = E('table', { class: 'table wo-seen' }, [
				E('colgroup', {}, [
					E('col', { style: 'width:17%' }),
					E('col', { style: 'width:14%' }),
					E('col', { style: 'width:18%' }),
					E('col', { style: 'width:17%' }),
					E('col', { style: 'width:8%' }),
					E('col', { style: 'width:10%' }),
					E('col', { style: 'width:16%' })
				]),
				E('thead', {}, E('tr', {}, [
					E('th', { class: 'wo-ip' , style: 'text-align:center !important' }, _('时间')),
					E('th', { class: 'wo-dev' , style: 'text-align:center !important' }, _('设备')),
					E('th', { class: 'wo-ip' , style: 'text-align:center !important' }, _('来源 IP')),
					E('th', { class: 'wo-geo' , style: 'text-align:center !important' }, _('归属地')),
					E('th', { style: 'text-align:center !important' }, _('次数')),
					E('th', { style: 'text-align:center !important' }, _('端口')),
					E('th', { class: 'wo-dev' , style: 'text-align:center !important' }, _('说明'))
				])),
				tbody
			]);
			evBox.appendChild(evTbl);
			forceCenter(evTbl);

			/* 折叠控制条：默认最近 10 条，其余折叠 */
			if (list.length > LIMIT) {
				var hidden = list.length - LIMIT;
				evBox.appendChild(E('div', {
					style: 'margin-top:8px;display:flex;flex-direction:column;align-items:center;gap:6px;color:#777;font-size:92%'
				}, [
					E('span', {}, evExpanded
						? _('已展开全部 %d 条记录').format(list.length)
						: _('共 %d 条记录，当前显示最近 %d 条').format(list.length, LIMIT)),
					E('button', {
						class: 'cbi-button cbi-button-action',
						style: 'margin:0',
						click: ui.createHandlerFn(self, function () {
							evExpanded = !evExpanded;
							paintEvents(null);
							return Promise.resolve();
						})
					}, evExpanded
						? _('收起其余 %d 条').format(hidden)
						: _('展开其余 %d 条').format(hidden))
				]));
			}
		}

		/* ---------------- 一次请求刷新所有 ---------------- */
		function refreshAll(fresh) {
			return api.status(fresh !== false).then(function (st) {
				Model.load(st);
				paintStatus(st);
				paintSeen(st);
				paintEvents(st);
				return st;
			});
		}

		/* ==================== 表单 ==================== */
		var m, s;

		/* 用表单自带的标题 + 描述 —— LuCI 原生样式（白色标题块） */
		m = new form.Map('wol_autowake',
			_('自动唤醒'),
			_('有人从外部连接某台设备的外部端口时，如果它不在线，就自动发魔术包唤醒它。'));

		/*
		 * 不做标签页，改用【多个原生 section】分组 —— 每个 section 自带白色标题块，
		 * 这才是 LuCI 里真正的「分组」，比在字段之间插分隔线清爽得多。
		 *   ┌ 设备        ┐ 状态卡 + 设备列表 + 最近唤醒 + 可疑来源
		 *   ┌ 服务        ┐ 启用 / 发包接口 / 节流
		 *   ┌ 扫描        ┐ 检测方式 / 扫描间隔 / 在线设备扫描间隔
		 *   ┌ 来源过滤    ┐ 日志触发 / 国内国外 / IPv6 / 黑名单
		 *   ┌ 日志清理    ┐ 三个参数 + 立即清理
		 *   ┌ 维护操作    ┐ 重启服务 / 重建国内 IP 表
		 */

		/* 每个 section 变成一个标签页（设备 / 服务 / 扫描 / 来源过滤 / 日志清理 / 维护操作） */
		m.tabbed = true;

		/* ---- ① 设备 ---- */
		s = m.section(form.GridSection, 'device', _('设备'));
		s.addremove   = true;
		s.anonymous   = true;
		s.sortable    = false;
		s.description = _('「在线」「IPv4 端口转发」「IPv6 放行」都是实时状态；两个勾选框点一下立即生效。' +
			'点「编辑」可以配置目标端口和转发协议。');

		DEVICE_FIELDS.forEach(function (def) { addField(s, def); });

		/* 工具：按 key 列表挑字段 */
		function pickFields(list, keys) {
			return list.filter(function (d) { return keys.indexOf(d.key) >= 0; });
		}

		/* ---- ② 设置（一个标签页装下全部设置项）---- */
		s = m.section(form.TypedSection, 'settings', _('设置'));
		s.anonymous   = true;
		s.description = _('顺序：服务 → 扫描 → 来源过滤。' +
			'白名单、黑名单在本页；日志清理和维护操作在「高级设置」标签页。' +
			'改完点页面底部「保存并应用」，会自动同步防火墙并重启服务。');

		/* 服务 */
		pickFields(GLOBAL_FIELDS, ['enabled', 'iface', 'throttle'])
			.forEach(function (def) { addField(s, def); });

		/* 扫描 */
		pickFields(GLOBAL_FIELDS, ['scan_mode', 'scan_interval', 'scan_online_sec'])
			.forEach(function (def) { addField(s, def); });

		/* 来源过滤（基础） */
		pickFields(GLOBAL_FIELDS, ['geo_enabled', 'geo_source', 'geo_precise', 'ignore_foreign', 'cn_source',
			'ignore_ipv6'])
			.forEach(function (def) { addField(s, def); });

		/* ---- ③ 高级设置 ---- */
		s = m.section(form.TypedSection, 'advanced', _('高级设置'));
		s.anonymous = true;
		s.description = _('黑名单、自动黑名单、日志清理和维护操作。' +
			'这些字段仍然写回原设置，不需要单独保存。');

		/* 黑名单 / 自动黑名单 / 防火墙 */
		pickFields(GLOBAL_FIELDS, ['blacklist_preset', 'wake_hairpin',
			'autobl_enabled', 'autobl_per_min', 'autobl_total', 'autobl_expire', 'blacklist_fw'])
			.forEach(function (def) { addAdvancedField(s, def); });

		/* 日志清理 */
		LOGCLEAN_FIELDS.forEach(function (def) { addAdvancedField(s, def); });

		var oClean = s.option(form.Button, '_logclean', _('手动操作'));
		oClean.inputtitle = _('立即清理一次');
		oClean.inputstyle = 'action';
		oClean.onclick = function () {
			return api.ctl('logclean').then(function (r) {
				ui.addNotification(null, E('p', {}, r.result));
				return refreshAll();
			});
		};

		var oBackup = s.option(form.Button, '_logbackup', _('日志备份'));
		oBackup.inputtitle = _('备份当前日志');
		oBackup.inputstyle = 'action';
		oBackup.onclick = function () {
			return api.ctl('logbackup').then(function (r) {
				ui.addNotification(null, E('p', {}, r.result));
				return Promise.resolve();
			});
		};

		var oExport = s.option(form.Button, '_logexport', _('日志导出'));
		oExport.inputtitle = _('导出日志文件');
		oExport.inputstyle = 'action';
		oExport.onclick = function () {
			window.location.href = '/cgi-bin/wol-log';
			return Promise.resolve();
		};

		/* ---- 维护操作（并入「高级设置」标签页）---- */
		var oRestart = s.option(form.Button, '_restart', _('服务'));
		oRestart.inputtitle = _('重启服务');
		oRestart.inputstyle = 'apply';
		oRestart.onclick = function () {
			return api.ctl('restart').then(function (r) {
				ui.addNotification(null, E('p', {}, r.result));
				return refreshAll();
			});
		};

		var oCn = s.option(form.Button, '_cnlist', _('国内 IP 表'));
		oCn.inputtitle = _('重建国内 IP 表');
		oCn.inputstyle = 'action';
		oCn.onclick = function () {
			return api.ctl('cnlist').then(function (r) {
				ui.addNotification(null, E('p', {}, r.result));
				return refreshAll();
			});
		};
		oCn.description = _('从 OpenClash 的数据文件重新提取国内 IP 段，重建 ipset。' +
			'每周一凌晨 4:20 会自动检查一次（只有 OpenClash 的文件更新了才重建）。' +
			'平时不需要手动点 —— 除非你刚更新了 OpenClash 的列表想立刻生效');

		/* ---- 本地归属地库（仅「本地查询 + 本地精确查询」需要）---- */
		var oGeo = s.option(form.Button, '_geodl', _('本地归属地库'));
		oGeo.inputtitle = _('下载 / 更新本地库');
		oGeo.inputstyle = 'action';
		oGeo.description = _('仅「本地查询 + 本地精确查询」需要；约 7MB。' +
			'下载完成后离线显示国家 / 省 / 市（IPv6 只能判断国内 / 国外）。');
		oGeo.onclick = function () {
			ui.addNotification(null, E('p', {}, _('正在下载本地归属地库（约 7MB），请稍候...')));
			return api.ctl('geodl:force').then(function (r) {
				ui.addNotification(null, E('p', {}, r.result));
				return refreshAll();
			});
		};

		/* ---- 保存后：同步防火墙 + 重启服务让设置立刻生效（黑名单/节流/扫描方式等）---- */
		var origSave = m.save.bind(m);
		m.save = function () {
			return Promise.resolve(origSave()).then(function (res) {
				return api.ctl('sync').then(function (r) {
					ui.addNotification(null, E('p', {}, _('已同步到防火墙设置') + '：' + r.result));
					return api.ctl('restart').then(function () {
						ui.addNotification(null, E('p', {}, _('服务已重启，新设置已生效')));
						return api.ctl('geodl:check').then(function (chk) {
							if (chk && chk.result === 'need') {
								ui.addNotification(null, E('p', {},
									_('检测到已启用本地精确查询，正在下载本地库（约 7MB）...')));
								return api.ctl('geodl').then(function (g) {
									ui.addNotification(null, E('p', {}, g.result));
								});
							}
							return null;
						}).then(function () {
							return refreshAll().then(function () { return res; });
						});
					});
				});
			});
		};

		/* ==================== 组装 ==================== */
		return m.render().then(function (formNode) {
			var activePane = formNode.querySelector('[data-tab-active="true"][data-tab]');
			var activeName = activePane ? activePane.getAttribute('data-tab') : 'device';
			function tabActive(name) { return activeName === name ? 'true' : 'false'; }

			var seenCard = E('div', { class: 'cbi-section cbi-tblsection wo-list-card', 'data-wol-tab': 'device' }, [
				E('h3', {}, _('可疑来源 IP')),
				E('p', { style: 'margin:0 0 10px;color:#777;font-size:92%' },
					_('国外来源全部列出；国内来源只列访问次数 ≥ 3 的（偶发访问多半是误报）。' +
						'点「加入黑名单」后，这个来源再也不会触发唤醒（优先级最高）')),
				E('div', { class: 'cbi-section-node' }, [seenBox])
			]);

			var evCard = E('div', { class: 'cbi-section cbi-tblsection wo-list-card', 'data-wol-tab': 'device' }, [
				E('h3', {}, _('最近唤醒记录')),
				E('p', { style: 'margin:0 0 10px;color:#777;font-size:92%' },
					_('可切换「成功唤醒」和「忽略记录」；每类默认显示最近 5 条，其余折叠。')),
				E('div', { class: 'cbi-section-node' }, [evBox])
			]);

			var statusCard = E('div', { class: 'cbi-section cbi-tblsection wo-list-card', 'data-wol-tab': 'device' }, [
				E('h3', {}, _('状态')),
				E('div', { class: 'cbi-section-node' }, [statusBox])
			]);

			/*
			 * 把「状态卡 / 最近唤醒 / 可疑来源 IP」塞进【设备 section 自己】里
			 *   —— 必须是 section 内部（devSec.appendChild），
			 *      不能挂到父容器，否则两个标签页都会显示。
			 */
			try {
				var allSecs = formNode.querySelectorAll('.cbi-section');
				/* 设备是第 1 个 section（标签顺序：设备 → 设置） */
				var devSec  = allSecs.length ? allSecs[0] : null;

				if (devSec) {
					/* 独立卡片：和 section 同级，带 data-tab，交给 LuCI 原生分页显示/隐藏 */
					var devParent = devSec.parentNode || formNode;
					devParent.insertBefore(statusCard, devSec);
					devParent.appendChild(evCard);
					devParent.appendChild(seenCard);
				} else {
					formNode.appendChild(statusCard);
					formNode.appendChild(evCard);
					formNode.appendChild(seenCard);
				}

				/* 白名单 / 自定义黑名单：放进「设置」标签页 */
				var cfgSec = allSecs.length > 1 ? allSecs[1] : null;
				if (cfgSec) {
					var wlStub = { cbid: function () { return 'wol-wl-list'; } };
					var blStub = { cbid: function () { return 'wol-bl-list'; } };
					var wlRoot = renderWhitelistEditor(wlStub, '',
						m.data.get('wol_autowake', 'settings', 'whitelist'), initial);
					var blRoot = renderBlacklistEditor(blStub, '',
						m.data.get('wol_autowake', 'settings', 'blacklist'), initial);
					var cardParent = cfgSec.parentNode || formNode;
					cardParent.appendChild(E('div', { class: 'cbi-section cbi-tblsection wo-list-card', 'data-wol-tab': 'settings' }, [
						E('h3', {}, _('白名单')),
						E('div', { class: 'cbi-section-node' }, [wlRoot])
					]));
					cardParent.appendChild(E('div', { class: 'cbi-section cbi-tblsection wo-list-card', 'data-wol-tab': 'settings' }, [
						E('h3', {}, _('自定义黑名单')),
						E('div', { class: 'cbi-section-node' }, [blRoot])
					]));
				}

				/* 卡片是渲染后追加的，监听原生标签页的 data-tab-active 变化来显隐 */
				var cardEls = formNode.querySelectorAll('[data-wol-tab]');
				var applyCards = function () {
					var active = formNode.querySelector('[data-tab-active="true"][data-tab]');
					var name = active ? active.getAttribute('data-tab') : 'device';
					cardEls.forEach(function (el) {
						el.style.display = (el.getAttribute('data-wol-tab') === name) ? '' : 'none';
					});
				};
				try {
					new MutationObserver(applyCards).observe(formNode, {
						subtree: true,
						attributes: true,
						attributeFilter: ['data-tab-active']
					});
				} catch (e) { /* 忽略 */ }
				setTimeout(applyCards, 0);
			} catch (e) {
				try {
					formNode.appendChild(statusCard);
					formNode.appendChild(evCard);
					formNode.appendChild(seenCard);
				} catch (e2) { /* 忽略 */ }
			}

			/* 默认停在「设备」标签页（标签顺序是 设置 → 设备，但默认看设备） */
			try {
				var tabBtns = formNode.querySelectorAll('.cbi-tab');
				for (var ti = 0; ti < tabBtns.length; ti++) {
					if ((tabBtns[ti].textContent || '').trim() === _('设备')) {
						tabBtns[ti].click();
						break;
					}
				}
			} catch (e) { /* 忽略 */ }

			/* 首屏先用缓存，页面出来后立刻在后台拿一次实时状态 */
			if (initial) {
				paintStatus(initial);
				paintSeen(initial);
				paintEvents(initial);
			}
			refreshAll();

			decorate(formNode, refreshAll);

			poll.add(function () {
				return refreshAll().then(function () {
					decorate(formNode, refreshAll);
				});
			}, POLL_SEC);

			return E('div', { class: 'wol-autowake' }, [
				E('style', {}, [
					/* ---- 状态卡片 ---- */
					'.wol-autowake .wo-card{',
					'background:linear-gradient(180deg,rgba(128,128,128,.10),rgba(128,128,128,.03));',
					'border:1px solid rgba(128,128,128,.22);border-radius:10px;',
					'padding:16px 22px 18px;margin:0 0 22px;',
					'box-shadow:0 2px 6px rgba(0,0,0,.06);}',
					'.wol-autowake .wo-card h3{margin:0 0 12px;font-size:108%;',
					'letter-spacing:.5px;font-weight:600;}',
					/* 两列信息网格（旧布局，保留兼容） */
					'.wol-autowake .wo-grid{display:grid;',
					'grid-template-columns:repeat(2,minmax(0,1fr));gap:5px 32px;}',
					/* ---- 新状态卡片 ---- */
					'.wol-autowake .wo-card{padding:20px 26px 22px;}',
					/* 四个数字：撑满整行，中间细线分隔 */
					'.wol-autowake .wo-pills{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 12px;}',
					'.wol-autowake .wo-pill{display:inline-flex;align-items:center;justify-content:center;gap:6px;',
					'width:124px;height:26px;box-sizing:border-box;padding:0 10px;',
					'border:1px solid;border-radius:999px;',
					'font-size:86%;font-weight:600;line-height:1;white-space:nowrap;}',
					'.wol-autowake .wo-pill-dot{width:7px;height:7px;border-radius:50%;flex:none;}',
					'.wol-autowake .wo-filter-row{display:flex;flex-wrap:wrap;align-items:center;',
					'gap:10px 18px;margin:2px 0 12px;}',
					'.wol-autowake .wo-filter-item{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;}',
					'.wol-autowake .wo-label{font-size:92%;opacity:.6;}',
					'.wol-autowake .wo-stats{display:flex;border:1px solid rgba(128,128,128,.18);',
					'border-radius:11px;overflow:hidden;margin:0 0 20px;background:rgba(128,128,128,.035);}',
					'.wol-autowake .wo-stat{flex:1;min-width:0;padding:20px 12px;text-align:center;',
					'border-right:1px solid rgba(128,128,128,.13);}',
					'.wol-autowake .wo-stat:last-child{border-right:none;}',
					'.wol-autowake .wo-stat .n{font-size:31px;font-weight:700;line-height:1.15;',
					'font-variant-numeric:tabular-nums;}',
					'.wol-autowake .wo-stat .l{font-size:84%;opacity:.55;margin-top:6px;letter-spacing:.6px;}',
					'@media (max-width:620px){.wol-autowake .wo-stat .n{font-size:22px;}',
					'.wol-autowake .wo-stat{padding:14px 6px;}',
					'.wol-autowake .wo-stat .l{font-size:76%;}}',
					'.wol-autowake .wo-meta{font-size:93%;line-height:2.3;opacity:.9;',
					'margin-top:4px;word-spacing:.5px;}',
					'.wol-autowake .wo-meta b{font-weight:600;}',
					'.wol-autowake .wo-hint{font-size:84%;opacity:.5;margin-top:14px;line-height:1.75;}',
					'font-size:95%;cursor:pointer;border-radius:7px 7px 0 0;color:#666;font-weight:500;}',
					'font-weight:600;box-shadow:inset 0 -2px 0 #2b6cb0;}',
					'.wol-autowake .wo-kv{display:flex;align-items:baseline;min-width:0;padding:2px 0;}',
					'.wol-autowake .wo-kv .k{flex:none;width:58px;opacity:.55;font-size:92%;}',
					'.wol-autowake .wo-kv .v{flex:1;min-width:0;font-size:95%;word-break:break-all;}',
					'.wol-autowake .wo-kv .v.bad{color:#c00;}',
					'@media (max-width:760px){.wol-autowake .wo-grid{grid-template-columns:1fr;}}',
					/* 设备表格：只收紧内边距，宽度仍铺满 */
					'.wol-autowake .cbi-section-table th,.wol-autowake .cbi-section-table td{padding:5px 10px;}',
					'.wol-autowake .cbi-section-table td{white-space:nowrap;}',
					'.wol-autowake .cbi-section-table .cbi-section-actions{white-space:nowrap;}',
					'.wol-autowake .cbi-section-table .cbi-button{padding:3px 10px;}',
					/* 可疑来源表 / 最近唤醒表：固定列宽，全部居中，允许换行不溢出 */
					'.wol-autowake table.wo-seen{table-layout:fixed;width:100%;}',
										/* !important：主题对首列/单元格有更高优先级的 text-align，必须压过去 */
					'.wol-autowake table.wo-seen th,.wol-autowake table.wo-seen td{',
					'text-align:center !important;vertical-align:middle;padding:9px 6px;',
					'white-space:normal;word-break:break-all;overflow-wrap:anywhere;}',
					'.wol-autowake table.wo-seen td{height:61px;box-sizing:border-box;}',
					'.wol-autowake table.wo-seen th:first-child,',
					'.wol-autowake table.wo-seen td:first-child{text-align:center !important;}',
					'.wol-autowake table.wo-seen td.wo-ip code{',
					'font-size:105%;font-weight:700;letter-spacing:.2px;background:none;padding:0;',
					'display:inline-block;text-align:center;}',
					'.wol-autowake table.wo-seen tbody tr:nth-child(even){background:rgba(128,128,128,.045);}',
					'.wol-autowake table.wo-seen td:last-child{white-space:normal;}',
					'.wol-autowake [data-tab][data-tab-active="false"]{display:none !important;}',
					'.wol-autowake .wo-bl-editor{display:flex;flex-direction:column;gap:10px;}',
					'.wol-autowake .wo-ro{width:100%;box-sizing:border-box;}',
					'.wol-autowake .wo-list-card table.cbi-section-table{',
					'table-layout:fixed;width:100%;}',
					'.wol-autowake .wo-list-card table.cbi-section-table th,',
					'.wol-autowake .wo-list-card table.cbi-section-table td{',
					'text-align:center !important;}',
					'.wol-autowake .wo-list-card table.cbi-section-table td .cbi-input-text{',
					'text-align:center !important;}',
					'.wol-autowake .wo-list-card table.cbi-section-table td.wo-bl-ops{',
					'display:table-cell !important;text-align:center !important;vertical-align:middle;}',
					'.wol-autowake .wo-list-card table.cbi-section-table td.wo-bl-ops .btn{',
					'float:none !important;display:inline-block !important;margin:0 3px !important;}',
					'.wol-autowake .cbi-section-table td .cbi-input-text{width:100%;box-sizing:border-box;}',
					/* 黑白名单独立卡片：上下间隔 + 内边距 + 圆角 */
					'.wol-autowake .cbi-section.wo-list-card{',
					'margin:18px 0;padding:14px 16px 16px;border-radius:12px;overflow:hidden;}',
					'.wol-autowake .cbi-section.wo-list-card .cbi-section-node{padding:0;}',
					'.wol-autowake .cbi-section.wo-list-card > h3{',
					'margin:0 0 12px;padding:0;border-radius:0;}',
					'.wol-autowake .cbi-section.wo-list-card .cbi-section-create{',
					'margin-top:12px;}',
					/* 自定义表格字段占满整行，去掉左侧标题列的大片留白 */
					'.wol-autowake .cbi-value.wo-wide{display:block !important;padding-left:0 !important;}',
					'.wol-autowake .cbi-value.wo-wide > .cbi-value-title{',
					'float:none !important;width:auto !important;display:block;margin:0 0 6px;}',
					'.wol-autowake .cbi-value.wo-wide > .cbi-value-field{',
					'margin-left:0 !important;width:auto !important;}',
					/* 设置页功能卡片 */
					'padding:14px 20px 8px;margin:0 0 16px;background:rgba(128,128,128,.03);}',
					/* ★ 纯 CSS 卡片：每个字段行加边框，保证一定能看到效果 */
					'}',
					/* ★ 功能区卡片：用 body 前缀提高优先级，压过主题 CSS */
					,
					,
					,
					,
					,
					,
					,
					,
					/* 设备表格：勾选框列居中，动作列不换行 */
					'.wol-autowake .cbi-section-table th,.wol-autowake .cbi-section-table td{',
					'text-align:center;}',
					'.wol-autowake .cbi-section-table input[type=checkbox]{margin:0 auto;display:block;}',
					''
				].join('')),
				formNode
			]);
		});
	}
});
