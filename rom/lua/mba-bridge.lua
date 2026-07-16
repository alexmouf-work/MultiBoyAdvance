-- MultiBoyAdvance desktop bridge for mGBA (0.10+; dev build recommended).
-- Load via Tools -> Scripting -> Load script, with the netcode ROM running.
--
-- Same job as web/js/bridge/bridge.js, same contracts (docs/PROTOCOL.md):
-- find the mailbox in EWRAM, drain game->host TLVs onto the wire, queue wire
-- messages into the host->game ring. Wire here is JSON lines over mGBA's
-- built-in TCP sockets, to the server's tcp port (default 8485).

-- ---------------------------------------------------------------- CONFIG ---
local function env(k, d)
  local ok, v = pcall(function() return os.getenv(k) end)
  if ok and v and v ~= "" then return v end
  return d
end

local HOST = env("MBA_HOST", "127.0.0.1")
local PORT = tonumber(env("MBA_PORT", "8485"))
local NAME = env("MBA_NAME", "Desktop")
local AUTOJOIN = env("MBA_AUTOJOIN", "0") == "1" -- auto-accept co-op battle offers

-- ------------------------------------------------------------ tiny JSON ---
-- Minimal encoder/decoder, sufficient for the flat wire schema.
local json = {}

local esc = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }

function json.encode(v)
  local t = type(v)
  if v == nil then return "null"
  elseif t == "boolean" then return v and "true" or "false"
  elseif t == "number" then return string.format("%.17g", v)
  elseif t == "string" then return '"' .. v:gsub('[%z\1-\31"\\]', function(c) return esc[c] or string.format('\\u%04x', c:byte()) end) .. '"'
  elseif t == "table" then
    local isArray = true
    local n = 0
    for k in pairs(v) do
      n = n + 1
      if type(k) ~= "number" then isArray = false end
    end
    if isArray and n == #v then
      local parts = {}
      for i = 1, #v do parts[i] = json.encode(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    else
      local parts = {}
      for k, val in pairs(v) do
        parts[#parts + 1] = json.encode(tostring(k)) .. ":" .. json.encode(val)
      end
      return "{" .. table.concat(parts, ",") .. "}"
    end
  end
  return "null"
end

do
  local pos, str

  local function skip()
    pos = str:find("[^ \t\r\n]", pos) or #str + 1
  end

  local parseValue

  local function parseString()
    local out = {}
    pos = pos + 1
    while true do
      local c = str:sub(pos, pos)
      if c == "" then error("eof in string") end
      if c == '"' then pos = pos + 1; return table.concat(out) end
      if c == "\\" then
        local e = str:sub(pos + 1, pos + 1)
        if e == "u" then
          out[#out + 1] = string.char(tonumber(str:sub(pos + 2, pos + 5), 16) % 256)
          pos = pos + 6
        else
          local m = { n = "\n", r = "\r", t = "\t", b = "\b", f = "\f" }
          out[#out + 1] = m[e] or e
          pos = pos + 2
        end
      else
        out[#out + 1] = c
        pos = pos + 1
      end
    end
  end

  parseValue = function()
    skip()
    local c = str:sub(pos, pos)
    if c == '"' then return parseString() end
    if c == "{" then
      local obj = {}
      pos = pos + 1
      skip()
      if str:sub(pos, pos) == "}" then pos = pos + 1; return obj end
      while true do
        skip()
        local key = parseString()
        skip()
        pos = pos + 1 -- ':'
        obj[key] = parseValue()
        skip()
        local d = str:sub(pos, pos)
        pos = pos + 1
        if d == "}" then return obj end
      end
    end
    if c == "[" then
      local arr = {}
      pos = pos + 1
      skip()
      if str:sub(pos, pos) == "]" then pos = pos + 1; return arr end
      while true do
        arr[#arr + 1] = parseValue()
        skip()
        local d = str:sub(pos, pos)
        pos = pos + 1
        if d == "]" then return arr end
      end
    end
    if str:sub(pos, pos + 3) == "true" then pos = pos + 4; return true end
    if str:sub(pos, pos + 4) == "false" then pos = pos + 5; return false end
    if str:sub(pos, pos + 3) == "null" then pos = pos + 4; return nil end
    local numEnd = str:find("[^%d%.eE%+%-]", pos) or #str + 1
    local num = tonumber(str:sub(pos, numEnd - 1))
    pos = numEnd
    return num
  end

  function json.decode(s)
    str, pos = s, 1
    local ok, v = pcall(parseValue)
    if ok then return v end
    return nil
  end
end

-- ------------------------------------------------------------- protocol ---
local T = {
  PRESENCE = 0x01, FLAG_SET = 0x02, VAR_SET = 0x03, PARTY = 0x05, REQUEST = 0x06,
  PARTY_FULL = 0x07, LOG = 0x0F, BATTLE_EVENT = 0x10, SAVED = 0x11, SAVEBLOCKS = 0x12, HELLO = 0x7F,
  GHOST = 0x81, FLAG_APPLY = 0x82, VAR_APPLY = 0x83, WARP = 0x85, ASSIGN = 0x86,
  BATTLE_CMD = 0x90, ADMIN = 0x91,
}
local MON_WIRE_SIZE = 32
local MAGIC = "MBA0\1" -- magic + version byte
local MAILBOX_SIZE = 1048
local RING = 512
local OFF_OUT, OFF_IN = 16, 532
local EWRAM_LEN = 0x40000

local u16 = function(b, i) return b:byte(i + 1) + b:byte(i + 2) * 256 end
local s16 = function(b, i)
  local v = u16(b, i)
  if v >= 0x8000 then v = v - 0x10000 end
  return v
end
local lo = function(v) return v % 256 end
local hi = function(v) return math.floor(v / 256) % 256 end

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function base64(s)
  local out = {}
  for i = 1, #s, 3 do
    local a, b, c = s:byte(i, i + 2)
    local n = a * 65536 + (b or 0) * 256 + (c or 0)
    local i1 = math.floor(n / 262144) % 64
    local i2 = math.floor(n / 4096) % 64
    local i3 = math.floor(n / 64) % 64
    local i4 = n % 64
    out[#out + 1] = B64:sub(i1 + 1, i1 + 1) .. B64:sub(i2 + 1, i2 + 1)
      .. (b and B64:sub(i3 + 1, i3 + 1) or "=")
      .. (c and B64:sub(i4 + 1, i4 + 1) or "=")
  end
  return table.concat(out)
end

-- ---------------------------------------------------------------- state ---
local sock = nil
local rxbuf = ""
local connected = false
local backoff = 0
local base = nil -- mailbox offset within EWRAM
local inQueue = {} -- pending {type, payload-bytes-table} for the in-ring
local sid = nil -- current battle session
local mySlot = nil
local frames = 0

local function log(msg) console:log("[mba] " .. msg) end

-- ------------------------------------------------------------ memory io ---
local function wram()
  return emu.memory.wram
end

local function findMailbox()
  local blob = wram():readRange(0, EWRAM_LEN)
  local at = 1
  while true do
    local i = blob:find(MAGIC, at, true)
    if not i then return nil end
    if (i - 1) % 4 == 0 then return i - 1 end
    at = i + 1
  end
end

local function readMailbox()
  return wram():readRange(base, MAILBOX_SIZE)
end

local function w8(off, v) wram():write8(base + off, v) end
local function w16(off, v)
  w8(off, lo(v))
  w8(off + 1, hi(v))
end

-- Drain game->host TLVs. Reads the snapshot, advances the tail in RAM.
local function drainOut(box)
  local head = u16(box, OFF_OUT)
  local tail = u16(box, OFF_OUT + 2)
  local records = {}
  while tail ~= head do
    local t = box:byte(OFF_OUT + 4 + tail + 1)
    local len = box:byte(OFF_OUT + 4 + ((tail + 1) % RING) + 1)
    local payload = {}
    for i = 0, len - 1 do
      payload[i + 1] = box:byte(OFF_OUT + 4 + ((tail + 2 + i) % RING) + 1)
    end
    tail = (tail + 2 + len) % RING
    records[#records + 1] = { type = t, p = payload }
  end
  w16(OFF_OUT + 2, tail)
  return records
end

-- Append queued host->game TLVs while there is space.
local function flushInQueue(box)
  local head = u16(box, OFF_IN)
  local tail = u16(box, OFF_IN + 2)
  while #inQueue > 0 do
    local rec = inQueue[1]
    local need = 2 + #rec.p
    local free = RING - 1 - ((head - tail + RING) % RING)
    if need > free then break end
    w8(OFF_IN + 4 + head, rec.type)
    w8(OFF_IN + 4 + ((head + 1) % RING), #rec.p)
    for i = 1, #rec.p do
      w8(OFF_IN + 4 + ((head + 1 + i) % RING), rec.p[i])
    end
    head = (head + need) % RING
    w16(OFF_IN, head)
    table.remove(inQueue, 1)
  end
end

local function queueIn(t, p) inQueue[#inQueue + 1] = { type = t, p = p } end

-- --------------------------------------------------------------- socket ---
local function send(obj)
  if connected and sock then
    sock:send(json.encode(obj) .. "\n")
  end
end

local handleWire -- fwd decl

local function onReceived()
  while true do
    local chunk, err = sock:receive(4096)
    if not chunk then break end
    rxbuf = rxbuf .. chunk
  end
  while true do
    local nl = rxbuf:find("\n", 1, true)
    if not nl then break end
    local line = rxbuf:sub(1, nl - 1)
    rxbuf = rxbuf:sub(nl + 1)
    local msg = json.decode(line)
    if msg and msg.t then handleWire(msg) end
  end
end

local function connect()
  local s, err = socket.connect(HOST, PORT)
  if not s then
    backoff = 300 -- ~5s at 60fps
    return
  end
  sock = s
  connected = true
  rxbuf = ""
  sock:add("received", onReceived)
  sock:add("error", function()
    log("socket error; reconnecting")
    connected = false
    sock = nil
    backoff = 300
  end)
  send({ t = "hello", name = NAME, proto = 1 })
  log("connected to " .. HOST .. ":" .. PORT)
end

-- ------------------------------------------------------- TLV -> wire ------
local lastPosKey = nil
local lastPosFrame = -100

local function gameToWire(rec)
  local t, p = rec.type, rec.p
  local b = string.char(table.unpack(p)) -- byte-string view for u16 helpers

  if t == T.HELLO then
    log("game netcode is up (HELLO v" .. (p[1] or 0) .. ")")
  elseif t == T.LOG then
    log("[game] " .. string.char(table.unpack(p)))
  elseif t == T.SAVED then
    log("game saved (desktop mGBA writes the .sav to disk itself)")
  elseif t == T.SAVEBLOCKS then
    -- Freeze-free save sync: read the freshly-synced save blocks and let the
    -- server forge the .sav (works for desktop players too — no HTTP needed).
    local u32 = function(i) return p[i + 1] + p[i + 2] * 256 + p[i + 3] * 65536 + p[i + 4] * 16777216 end
    local EWRAM_BASE = 0x02000000
    local grab = function(ptr, size)
      local off = ptr - EWRAM_BASE
      if size == 0 or size > 0x9000 or off < 0 or off + size > EWRAM_LEN then return nil end
      return wram():readRange(off, size)
    end
    local sb2 = grab(u32(9), u32(13))
    local sb1 = grab(u32(17), u32(21))
    local sto = grab(u32(25), u32(29))
    if sb2 and sb1 and sto then
      send({ t = "save.blocks", counter = u32(4), sector = p[9],
             sb2 = base64(sb2), sb1 = base64(sb1), sto = base64(sto) })
    end
  elseif t == T.PRESENCE then
    local key = table.concat(p, ",")
    if key ~= lastPosKey and frames - lastPosFrame >= 6 then
      lastPosKey = key
      lastPosFrame = frames
      send({ t = "pos", g = p[1], n = p[2], x = s16(b, 2), y = s16(b, 4), f = p[7], s = p[8] })
    end
  elseif t == T.FLAG_SET then
    send({ t = "flag", id = u16(b, 0) })
  elseif t == T.VAR_SET then
    send({ t = "var", id = u16(b, 0), v = u16(b, 2) })
  elseif t == T.PARTY then
    local mons = {}
    for i = 0, (p[1] or 0) - 1 do
      local o = 1 + i * 4
      mons[#mons + 1] = { sp = u16(b, o), lv = p[o + 3], hp = p[o + 4] }
    end
    send({ t = "party", mons = mons })
  elseif t == T.PARTY_FULL then
    local mons = {}
    for i = 0, (p[1] or 0) - 1 do
      local bytes = {}
      for j = 1, MON_WIRE_SIZE do
        bytes[j] = p[1 + i * MON_WIRE_SIZE + j]
      end
      mons[#mons + 1] = { lv = bytes[21], b = bytes } -- level at wire byte 20 (0-based)
    end
    send({ t = "party.full", mons = mons })
  elseif t == T.REQUEST then
    local sub, arg = p[1], p[2]
    if sub == 1 then send({ t = "tp", to = arg })
    elseif sub == 2 then send({ t = "pvp", to = arg })
    elseif sub == 3 then send({ t = "pvp.accept", from = arg })
    elseif sub == 4 then send({ t = "resync" }) end
  elseif t == T.BATTLE_EVENT then
    local sub = p[1]
    if sub == 1 then
      send({ t = "battle.open", kind = p[2], opp = u16(b, 2) })
    elseif sub == 2 and sid then
      send({ t = "battle.input", sid = sid, turn = p[2], a = p[3], move = p[4], tgt = p[5], x = u16(b, 5) })
    elseif sub == 3 and sid then
      send({ t = "battle.end", sid = sid, result = p[2] })
    end
  end
end

-- ------------------------------------------------------- wire -> TLV ------
local function queueWorldState(m)
  for _, id in ipairs(m.flags or {}) do
    queueIn(T.FLAG_APPLY, { lo(id), hi(id) })
  end
  for _, pair in ipairs(m.vars or {}) do
    queueIn(T.VAR_APPLY, { lo(pair[1]), hi(pair[1]), lo(pair[2]), hi(pair[2]) })
  end
end

handleWire = function(m)
  if m.t == "welcome" then
    mySlot = m.slot
    log("joined as P" .. (m.slot + 1) .. " (" .. #(m.flags or {}) .. " world flags)")
    queueIn(T.ASSIGN, { m.slot })
    queueWorldState(m)
  elseif m.t == "sync" then
    queueWorldState(m) -- post-new-game replay (resync request)
  elseif m.t == "ghost" then
    local active = (m.s == 255) and 0 or 1
    queueIn(T.GHOST, { m.slot, active, m.g, m.n, lo(m.x), hi(m.x % 0x10000), lo(m.y), hi(m.y % 0x10000), m.f, m.s })
  elseif m.t == "flag" then
    queueIn(T.FLAG_APPLY, { lo(m.id), hi(m.id) })
  elseif m.t == "var" then
    queueIn(T.VAR_APPLY, { lo(m.id), hi(m.id), lo(m.v), hi(m.v) })
  elseif m.t == "warp" then
    queueIn(T.WARP, { m.g, m.n, lo(m.x), hi(m.x % 0x10000), lo(m.y), hi(m.y % 0x10000) })
  elseif m.t == "battle.offer" then
    log("battle offer " .. m.sid .. " from P" .. (m.from + 1) .. (AUTOJOIN and " — auto-joining" or " — set MBA_AUTOJOIN=1 to join automatically"))
    if AUTOJOIN then
      sid = m.sid
      send({ t = "battle.join", sid = m.sid })
    end
  elseif m.t == "battle.start" then
    sid = m.sid
    local seed = m.seed
    -- Merged party must be staged in the ROM before START lands.
    if m.partyWire and #m.partyWire > 0 then
      local pp = { 4, #m.partyWire }
      for _, mon in ipairs(m.partyWire) do
        for _, byte in ipairs(mon) do
          pp[#pp + 1] = byte
        end
      end
      queueIn(T.BATTLE_CMD, pp)
    end
    queueIn(T.BATTLE_CMD, {
      1,
      seed % 256, math.floor(seed / 0x100) % 256, math.floor(seed / 0x10000) % 256, math.floor(seed / 0x1000000) % 256,
      #m.order,
      m.order[1] or 0xFF, m.order[2] or 0xFF, m.order[3] or 0xFF, m.order[4] or 0xFF,
      (m.mode == "pvp") and 1 or 0,
    })
    log("battle " .. m.sid .. " started, seed " .. seed)
  elseif m.t == "battle.input" then
    queueIn(T.BATTLE_CMD, { 2, m.turn, m.from, m.a, m.move or 0, m.tgt or 0, lo(m.x or 0), hi(m.x or 0) })
  elseif m.t == "battle.end" then
    queueIn(T.BATTLE_CMD, { 3, m.result })
    sid = nil
  elseif m.t == "pvp.req" then
    log("PvP challenge from P" .. (m.from + 1) .. " (" .. (m.name or "?") .. ")" .. (AUTOJOIN and " — auto-accepting" or ""))
    if AUTOJOIN then send({ t = "pvp.accept", from = m.from }) end
  elseif m.t == "tp.req" then
    log("teleport request from P" .. (m.from + 1) .. " (" .. (m.name or "?") .. ")" .. (AUTOJOIN and " — auto-accepting" or " — set MBA_AUTOJOIN=1 to accept automatically"))
    if AUTOJOIN then send({ t = "tp.accept", from = m.from }) end
  elseif m.t == "admin" then
    -- Console/admin command; field layout mirrors net_admin.c / mailbox.js.
    local p = nil
    if m.sub == "give_item" then
      p = { 1, lo(m.item), hi(m.item), lo(m.qty), hi(m.qty) }
    elseif m.sub == "take_item" then
      p = { 2, lo(m.item), hi(m.item), lo(m.qty), hi(m.qty) }
    elseif m.sub == "give_mon" then
      p = { 3, lo(m.species), hi(m.species), m.level }
    elseif m.sub == "set_level" then
      p = { 4, m.slot, m.level }
    elseif m.sub == "give_xp" then
      p = { 5, m.slot, m.xp % 256, math.floor(m.xp / 0x100) % 256, math.floor(m.xp / 0x10000) % 256, math.floor(m.xp / 0x1000000) % 256 }
    elseif m.sub == "wild_battle" then
      p = { 6, lo(m.species), hi(m.species), m.level }
    elseif m.sub == "reset_trainer" then
      p = { 7, lo(m.trainer), hi(m.trainer) }
    elseif m.sub == "set_name" then
      p = { 8 }
      for i, byte in ipairs(m.name or {}) do
        if i > 8 then break end
        p[#p + 1] = byte
      end
    end
    if p then queueIn(T.ADMIN, p) end
  elseif m.t == "trade.recv" then
    log((m.name or "?") .. " sent you item " .. m.item .. " x" .. m.qty)
  elseif m.t == "cmd.result" then
    log("cmd: " .. (m.msg or ""))
  elseif m.t == "error" then
    log("server error: " .. (m.msg or "?"))
  end
end

-- ------------------------------------------------------------ frame loop ---
local function frame()
  frames = frames + 1

  if not connected then
    if backoff > 0 then
      backoff = backoff - 1
    else
      connect()
    end
    return
  end

  if not base then
    if frames % 60 ~= 0 then return end
    base = findMailbox()
    if base then
      log(string.format("mailbox found @ 0x%08X", 0x02000000 + base))
      w8(9, 1) -- hostAttached
    end
    return
  end

  local box = readMailbox()
  if box:sub(1, 5) ~= MAGIC then
    log("mailbox lost (reset?); rescanning")
    base = nil
    return
  end

  for _, rec in ipairs(drainOut(box)) do
    gameToWire(rec)
  end
  flushInQueue(readMailbox())
end

callbacks:add("frame", frame)
log("bridge loaded — server " .. HOST .. ":" .. PORT .. ", player '" .. NAME .. "'")
