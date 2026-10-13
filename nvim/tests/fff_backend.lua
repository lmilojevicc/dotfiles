-- Run: nvim --headless -u NONE -l nvim/tests/fff_backend.lua
-- Also exercise the real Snacks finder: SNACKS_RTP=/path/to/snacks.nvim <same command>
local root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h")
local snacks = dofile(root .. "/lua/plugins/snacks.lua")
local specs = dofile(root .. "/lua/plugins/snacks-fff.lua")

local function equal(expected, actual, label)
  assert(vim.deep_equal(expected, actual), label .. ": expected " .. vim.inspect(expected) .. ", got " .. vim.inspect(actual))
end

local calls = {}
local function record(name)
  return function(...)
    calls[#calls + 1] = { name = name, args = { ... } }
  end
end
_G.Snacks = {
  picker = setmetatable({}, {
    __index = function(_, name)
      return record("snacks." .. name)
    end,
  }),
}
local function key(lhs)
  for _, mapping in ipairs(snacks.keys) do
    if mapping[1] == lhs then
      return mapping
    end
  end
  error("Missing mapping: " .. lhs)
end
local function routes(callback, destination)
  calls = {}
  callback()
  equal({ { name = destination, args = {} } }, calls, "callback route")
end
local dashboard_keys = {}
for _, entry in ipairs(snacks.opts.dashboard.preset.keys) do
  dashboard_keys[entry.key] = true
  if entry.key == "f" or entry.key == "g" then
    routes(entry.action, entry.key == "f" and "snacks.fff_files" or "snacks.fff_grep")
  end
end
assert(dashboard_keys.f and dashboard_keys.g, "dashboard f/g must exist")
routes(key("<leader>ff")[2], "snacks.fff_files")
routes(key("<leader>fg")[2], "snacks.fff_grep")
equal({ "n", "v" }, key("<leader>fw").mode, "grep word modes")
routes(key("<leader>fw")[2], "snacks.fff_grep_word")
routes(key("<leader>fG")[2], "snacks.grep_buffers")
routes(key("<leader>fb")[2], "snacks.buffers")

equal(2, #specs, "only backend and Snacks specs")
local backend, integration = specs[1], specs[2]
equal("dmtrKovalenko/fff", backend[1], "upstream backend")
equal("fff", backend.main, "backend setup module")
equal(false, backend.lazy, "backend eager setup")
equal({}, backend.opts, "backend setup opts")
assert(not backend.dependencies and not integration.dependencies, "no adapter dependencies")
package.loaded["fff.download"] = { download_or_build_binary = record("fff.download") }
routes(backend.build, "fff.download")
equal("folke/snacks.nvim", integration[1], "native Snacks hook")
assert(vim.fn.filereadable(root .. "/lua/plugins/fff.lua") == 0, "obsolete adapter spec removed")
for _, file in ipairs({ "snacks.lua", "snacks-fff.lua" }) do
  local text = table.concat(vim.fn.readfile(root .. "/lua/plugins/" .. file), "\n")
  assert(not text:find("fff-snacks", 1, true) and not text:find("so1ve", 1, true), "no adapter module or repo")
end

local opts = vim.deepcopy(snacks.opts)
local original = vim.deepcopy(opts)
local picker, existing_sources = opts.picker, opts.picker.sources
integration.opts(nil, opts)
assert(picker == opts.picker, "picker table identity preserved")
assert(existing_sources == opts.picker.sources, "sources table identity preserved")
local sources = opts.picker.sources
for _, name in ipairs({ "fff_files", "fff_grep", "fff_grep_word" }) do
  equal(false, sources[name].matcher.sort, name .. " backend ranking")
  equal(math.huge, sources[name].limit_live, name .. " no inherited live result cap")
  equal({ "idx" }, sources[name].sort.fields, name .. " stable order")
  equal("file", sources[name].format, name .. " standard format")
  equal("file", sources[name].preview, name .. " standard preview")
  equal("jump", sources[name].confirm, name .. " standard action")
end
local unchanged = vim.deepcopy(opts)
for _, name in ipairs({ "fff_files", "fff_grep", "fff_grep_word" }) do
  unchanged.picker.sources[name] = nil
end
equal(original, unchanged, "source registration preserves all other opts")
local empty_opts = {}
integration.opts(nil, empty_opts)
assert(empty_opts.picker.sources.fff_files, "registration without existing picker opts")
equal(false, sources.fff_grep_word.live, "word picker matches non-live Snacks default")
for _, selection in ipairs({ "cursor_word", ".foo+", "[a](b)\\c^$|?*{}", "two words" }) do
  equal(selection, sources.fff_grep_word.search({ word = function() return selection end }), "original input word/selection")
end

local scheduled, bootstrap_count, api_calls = false, 0, {}
local file_search, content_search
package.loaded["fff.file_picker"] = { setup = function()
  assert(scheduled, "bootstrap scheduled on main thread")
  bootstrap_count = bootstrap_count + 1
end }
package.loaded.fff = {
  file_search = function(query, search_opts)
    assert(scheduled, "file API scheduled on main thread")
    api_calls[#api_calls + 1] = { query = query, opts = search_opts }
    return file_search(query, search_opts)
  end,
  content_search = function(query, search_opts)
    assert(scheduled, "grep API scheduled on main thread")
    api_calls[#api_calls + 1] = { query = query, opts = search_opts }
    return content_search(query, search_opts)
  end,
}
local function run(name, query, control)
  control = control or {}
  api_calls = {}
  local items, schedules, aborted = {}, 0, control.aborted or false
  local ctx = {
    filter = { search = query },
    cwd = function() return "/fixture" end,
    async = {
      aborted = function() return aborted end,
      schedule = function(_, fn)
        schedules = schedules + 1
        if control.before == schedules then aborted = true end
        scheduled = true
        local result = fn()
        scheduled = false
        if control.after == schedules then aborted = true end
        return result
      end,
    },
  }
  local stream = sources[name].finder(sources[name], ctx)
  equal("function", type(stream), name .. " async streaming finder")
  equal({}, api_calls, "finder defers API until streaming")
  stream(function(item)
    items[#items + 1] = item
    if #items == control.emissions then aborted = true end
  end)
  return items
end

local file_total = 128077
file_search = function(query, search_opts)
  equal(0, search_opts.max_results, "unlimited file results")
  equal(0, search_opts.page, "single initial file page")
  equal(10000, search_opts.wait_for_index_ms, "bounded file initial/cwd scan wait")
  equal("/fixture", search_opts.cwd, "file index cwd")
  if query == "fresh" then
    return { items = { { relative_path = "fresh.lua" } }, total_matched = 1 }
  end
  local items = {}
  for i = 1, file_total do
    items[i] = { relative_path = (file_total + 1 - i) .. ".lua", name = "unused" }
  end
  return { items = items, total_matched = file_total, location = { line = 8, col = 4 } }
end
local files = run("fff_files", "lua:8:4")
equal(file_total, #files, "complete file result vector emitted")
for i, item in ipairs(files) do
  assert(item.file == (file_total + 1 - i) .. ".lua", "exact backend file order")
  assert(item.text == item.file, "file searchable text")
  assert(item.pos[1] == 8 and item.pos[2] == 3, "file location coordinates")
  assert(item.cwd == "/fixture", "relative path base")
end
equal(1, #api_calls, "large file query invokes backend once")
equal("lua:8:4", api_calls[1].query, "file query passed to backend")
equal(1, bootstrap_count, "one-time scan bootstrap")
equal(0, #run("fff_files", "", { aborted = true }), "already cancelled")
equal(0, #api_calls, "already cancelled query skips API")
equal(0, #run("fff_files", "", { before = 1 }), "cancel before scheduled callback")
equal(0, #api_calls, "no stale API call")
equal(0, #run("fff_files", "", { after = 1 }), "cancel after scheduling")
equal(1, #api_calls, "cancel after scheduling invokes backend once")
equal(101, #run("fff_files", "", { emissions = 101 }), "cancel during file emission")
equal(1, #api_calls, "no further file calls after cancellation")
local fresh = run("fff_files", "fresh")
equal(1, #fresh, "fresh query does not reuse previous results")
equal("fresh.lua", fresh[1].file, "fresh backend result")
equal(1, #api_calls, "fresh query invokes backend once")
equal("fresh", api_calls[1].query, "fresh query passed to backend")
for _, total_matched in ipairs({ 0, 10 }) do
  file_search = function()
    return { items = { { relative_path = "only.lua" } }, total_matched = total_matched }
  end
  equal(1, #run("fff_files", "inconsistent"), "file emission ignores inconsistent metadata")
  equal(1, #api_calls, "inconsistent metadata does not retry file query")
end
file_search = function() return { items = {}, total_matched = 10 } end
equal(0, #run("fff_files", "none"), "empty file result terminates")
equal(1, #api_calls, "no endless empty file paging")

local function match(i)
  return {
    relative_path = "same.lua", name = "same.lua", line_number = i,
    line_content = "  foo foo", col = 2, match_ranges = { { 2, 5 }, { 6, 9 } },
  }
end
content_search = function(query, search_opts)
  equal("foo.*", query, "workspace query stays regex")
  equal("regex", search_opts.mode, "regex workspace mode")
  equal(50, search_opts.page_size, "grep page size")
  equal(0, search_opts.max_matches_per_file, "no single-file match cap")
  equal(false, search_opts.trim_whitespace, "keep original coordinates")
  equal(10000, search_opts.wait_for_index_ms, "bounded grep initial/cwd scan wait")
  equal(25, search_opts.time_budget_ms, "bounded grep page time")
  equal(true, search_opts.enforce_time_budget, "allow advancing empty pages")
  equal("/fixture", search_opts.cwd, "grep index cwd")
  if search_opts.file_offset == 0 then
    local items = {}
    for i = 1, 320 do items[i] = match(i) end
    return { items = items, next_file_offset = 1 }
  elseif search_opts.file_offset == 1 then
    return { items = {}, next_file_offset = 7 }
  end
  equal(7, search_opts.file_offset, "continue after empty page")
  return { items = { match(321) }, next_file_offset = 0 }
end
local matches = run("fff_grep", "foo.*")
equal(321, #matches, "all grep pages, including >page_size from one file")
equal({ 0, 1, 7 }, vim.tbl_map(function(call) return call.opts.file_offset end, api_calls), "file-offset grep pagination")
for i, item in ipairs(matches) do
  equal({ i, 2 }, item.pos, "exact backend grep order and coordinates")
  equal("  foo foo", item.line, "preserve leading whitespace")
  equal({ 3, 4, 5, 7, 8, 9 }, item.positions, "all half-open byte range highlights")
  equal("same.lua:" .. i .. ":3:  foo foo", item.text, "grep searchable text")
end
equal(0, #run("fff_grep", ""), "empty grep skips backend")
equal(0, #api_calls, "no empty grep request")
equal(0, #run("fff_grep", "foo.*", { after = 1 }), "cancel scheduled grep results")
equal(51, #run("fff_grep", "foo.*", { emissions = 51 }), "cancel grep emissions")
equal(1, #api_calls, "no subsequent grep pages after cancellation")
content_search = function() return { items = {}, next_file_offset = 4 } end
equal(0, #run("fff_grep", "none"), "non-progress grep offset guard")
equal(2, #api_calls, "repeated offset terminates")
content_search = function(_, search_opts)
  return { items = {}, next_file_offset = search_opts.file_offset == 0 and 4 or 2 }
end
run("fff_grep", "none")
equal(2, #api_calls, "backwards offset terminates")
content_search = function() return { items = {}, next_file_offset = 0 } end
run("fff_grep_word", ".foo+[a](b)\\c^$|?*{} two words")
equal("\\b{start-half}\\.foo\\+\\[a\\]\\(b\\)\\\\c\\^\\$\\|\\?\\*\\{\\}\\x20two\\x20words\\b{end-half}", api_calls[1].query,
  "literal Rust escaping and punctuation-safe whole-word boundaries")
equal("regex", api_calls[1].opts.mode, "literal boundaries use regex backend only")
for _, case in ipairs({
  { "foo  bar", "foo\\x20\\x20bar", "foo bar" },
  { "foo\tbar", "foo\\x09bar", "foo bar" },
  { "foo /src/ bar", "foo\\x20/src/\\x20bar", "foo bar" },
  { "{a,b}", "\\{a\\x2cb\\}", "{axb}" },
  { "foo, bar", "foo\\x2c\\x20bar", "foo bar" },
}) do
  local input = sources.fff_grep_word.search({ word = function() return case[1] end })
  equal(case[1], input, "selection input remains original")
  run("fff_grep_word", input)
  local escaped = api_calls[1].query
  equal("\\b{start-half}" .. case[2] .. "\\b{end-half}", escaped, "parser-safe literal selection")
  assert(not escaped:find("%s"), "no parser whitespace tokens")
  run("fff_grep_word", case[3])
  assert(escaped ~= api_calls[1].query, "near-match selection is not normalized to the same regex")
end
equal(1, bootstrap_count, "bootstrap never repeated across queries and sources")
-- Keep the shared Snacks UI, including the custom telescope layout.
equal("folke/snacks.nvim", snacks[1], "Snacks repository")
equal(false, snacks.lazy, "Snacks eager loading")
equal({ preset = "telescope" }, snacks.opts.picker.layout, "layout preset")
equal({
  telescope = {
    reverse = false,
    layout = {
      box = "horizontal",
      backdrop = false,
      height = 0.8,
      width = 0.9,
      border = "none",
      {
        box = "vertical",
        {
          win = "input",
          height = 1,
          border = "rounded",
          title = "{title} {live} {flags}",
          title_pos = "center",
        },
        { win = "list", title = " Results ", title_pos = "center", border = "rounded" },
      },
      {
        win = "preview",
        title = "{preview:Preview}",
        width = 0.51,
        border = "rounded",
        title_pos = "center",
      },
    },
  },
}, snacks.opts.picker.layouts, "custom layouts")
equal({ enabled = false, replace_netrw = true, auto_close = true }, snacks.opts.explorer, "explorer settings")
equal(true, snacks.opts.picker.sources.explorer.hidden, "Snacks explorer hidden files")

if vim.env.SNACKS_RTP then
  vim.opt.rtp:append(vim.env.SNACKS_RTP)
  _G.Snacks = require("snacks")
  Snacks.setup({ picker = { sources = sources } })
  local total, backend_calls = 10005, 0
  package.loaded.fff.file_search = function(_, search_opts)
    backend_calls = backend_calls + 1
    equal(0, search_opts.max_results, "real Snacks unlimited file results")
    equal(0, search_opts.page, "real Snacks single initial file page")
    local items = {}
    for i = 1, total do
      items[i] = { relative_path = i .. ".lua" }
    end
    return { items = items, total_matched = total }
  end
  local resolved = Snacks.picker.config.get({ source = "fff_files" })
  equal(math.huge, resolved.limit_live, "resolved config overrides Snacks default cap")
  local real_picker = Snacks.picker.fff_files({ layout = { preset = "select", preview = false } })
  assert(vim.wait(15000, function()
    return not real_picker.finder:running() and not real_picker.matcher:running()
  end, 10), "real Snacks finder timed out")
  equal(total, #real_picker:items(), "real Snacks finder streams more than 10000 items")
  equal(1, backend_calls, "real Snacks file query invokes backend once")
  real_picker:close()
  print("fff real Snacks finder regression: OK (10005 items)")
end
print("fff backend regression: OK")
