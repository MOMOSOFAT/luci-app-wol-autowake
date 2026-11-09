-- Minimal bit32 compatibility for Lua 5.1 (only what Ip2region.lua needs)
local M = {}
local MOD = 4294967296

local function norm(x)
	x = x % MOD
	if x < 0 then x = x + MOD end
	return x
end

function M.band(a, b)
	a = norm(a); b = norm(b)
	local r, bit = 0, 1
	for _ = 1, 32 do
		local x, y = a % 2, b % 2
		if x == 1 and y == 1 then r = r + bit end
		a = (a - x) / 2
		b = (b - y) / 2
		bit = bit * 2
	end
	return r
end

function M.bor(a, b)
	a = norm(a); b = norm(b)
	local r, bit = 0, 1
	for _ = 1, 32 do
		local x, y = a % 2, b % 2
		if x == 1 or y == 1 then r = r + bit end
		a = (a - x) / 2
		b = (b - y) / 2
		bit = bit * 2
	end
	return r
end

function M.lshift(a, n)
	return norm(norm(a) * (2 ^ n))
end

function M.rshift(a, n)
	return math.floor(norm(a) / (2 ^ n))
end

_G.bit32 = M
return M
