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

equal("fff files", sources.fff_files.title, "exact lowercase file title")
equal(true, sources.fff_files.hidden, "original file hidden default")
for _, name in ipairs({ "fff_files", "fff_grep", "fff_grep_word" }) do
  equal(false, sources[name].ignored, name .. " ignored default")
  equal(math.huge, sources[name].limit, name .. " no non-live cap")
  for _, win in ipairs({ "input", "list" }) do
    local keys = sources[name].win[win].keys
    equal(false, keys["<a-h>"], name .. " no inherited Option-H")
    equal(win == "input" and { "fff_toggle_hidden", mode = { "i", "n" } } or "fff_toggle_hidden",
      keys["<a-e>"], name .. " Option-E " .. win)
    equal(win == "input" and { "fff_toggle_ignored", mode = { "i", "n" } } or "fff_toggle_ignored",
      keys["<a-i>"], name .. " Option-I " .. win)
  end
end
equal(false, sources.fff_grep.hidden, "original workspace grep hidden default")
equal(false, sources.fff_grep_word.hidden, "original word grep hidden default")

local is_git, reopened
local native_configs = {
  files = { finder = "files", matcher = { sort = true }, sort = { fields = { "score:desc" } } },
  grep = { finder = "grep", live = true, matcher = { sort = true }, sort = { fields = { "score:desc" } } },
  grep_word = { finder = "grep", live = false, matcher = { sort = true }, sort = { fields = { "score:desc" } } },
}
Snacks.git = { get_root = function() return is_git and "/fixture" or nil end }
Snacks.picker.config = {
  get = function(config) return vim.deepcopy(native_configs[config.source]) end,
  finder = function()
    return function(fopts, ctx) return { opts = fopts, search = ctx.filter.search } end
  end,
}
local function configure_source(name, overrides)
  local config = vim.tbl_deep_extend("force", vim.deepcopy(sources[name]), {
    source = name, cwd = "/fixture", toggles = { hidden = "h", ignored = "i" },
  }, overrides or {})
  return config.config(config)
end
for _, git in ipairs({ false, true }) do
  is_git = git
  for _, hidden in ipairs({ false, true }) do
    for _, ignored in ipairs({ false, true }) do
      for _, name in ipairs({ "fff_files", "fff_grep", "fff_grep_word" }) do
        local config = configure_source(name, { hidden = hidden, ignored = ignored, search = "typed query" })
        local native = ignored or (hidden and not git)
        equal(native, config.native, name .. " routing matrix")
        equal({ icon = "native" }, config.toggles.native, "honest backend hint")
        equal("h", config.toggles.hidden, "hidden flag reflects actual inclusion")
        equal("i", config.toggles.ignored, "ignored flag reflects actual inclusion")
        equal(native, config.matcher.sort, "native matcher, not backend ranking")
        if name == "fff_files" then
          equal("fff files", config.title, "fallback title stays lowercase")
          equal(not native, config.live, "file live versus fuzzy mode")
          equal(native and "" or "typed query", config.search, "file finder search transition")
          equal(native and "typed query" or nil, config.pattern, "native fuzzy pattern transition")
        elseif name == "fff_grep" and native then
          equal(true, config.regex, "native workspace regex")
        end
      end
    end
  end
end
Snacks.picker.pick = function(name, config)
  reopened = configure_source(name, config)
  return reopened
end
local function toggle(config, flag, query)
  local closed = false
  local picker_stub = {
    opts = config,
    init_opts = { layout = { preset = "telescope" }, arbitrary = "retained" },
    input = {
      filter = { cwd = "/fixture/subdir", pattern = config.pattern or "", search = config.search or "" },
      get = function() return query end,
    },
    current_win = function() return "list" end,
    close = function() closed = true end,
  }
  config.actions["fff_toggle_" .. flag](picker_stub)
  assert(closed, "toggle closes old backend")
  equal("/fixture/subdir", reopened.cwd, "toggle preserves actual cwd")
  equal({ preset = "telescope" }, reopened.layout, "toggle preserves layout")
  equal("retained", reopened.arbitrary, "toggle preserves invocation options")
  equal("list", reopened.focus, "toggle preserves focused window")
  return reopened
end
is_git = true
local toggled = configure_source("fff_files", { search = "old debounced query" })
toggled = toggle(toggled, "ignored", "fresh query")
equal(true, toggled.ignored, "ignored on")
equal(true, toggled.native, "ignored on uses native")
equal("fresh query", toggled.pattern, "fresh input becomes native fuzzy pattern")
toggled = toggle(toggled, "ignored", "changed fuzzy query")
equal(false, toggled.ignored, "ignored off")
equal(false, toggled.native, "ignored off returns to fff in Git")
equal("changed fuzzy query", toggled.search, "native pattern becomes fff search")
is_git = false
toggled = toggle(toggled, "hidden", "keep query")
equal(false, toggled.native, "non-Git hidden off permits fff")
toggled = toggle(toggled, "hidden", "keep query")
equal(true, toggled.native, "non-Git hidden on requires native")
equal("keep query", toggled.pattern, "hidden toggle retains query")
local word_native = configure_source("fff_grep_word", { ignored = true })
local cloneable = {}
function cloneable:clone() return setmetatable({}, { __index = self }) end
local native_word = word_native.finder(word_native, setmetatable({
  filter = setmetatable({ search = "two -- words {a,b}" }, { __index = cloneable }),
}, { __index = cloneable }))
equal("\\b{start-half}two\\x20--\\x20words\\x20\\{a\\x2cb\\}\\b{end-half}", native_word.search,
  "native word selection escapes literals and prevents Snacks argument parsing")
equal(true, native_word.opts.regex, "native word literal-boundary regex")
equal({}, native_word.opts.args, "no conflicting native word-regexp boundaries")
local empty_native_word = word_native.finder(word_native, setmetatable({
  filter = setmetatable({ search = "" }, { __index = cloneable }),
}, { __index = cloneable }))
equal("", empty_native_word.search, "native empty word search remains empty")

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
  local finder_opts = vim.deepcopy(sources[name])
  if control.hidden ~= nil then finder_opts.hidden = control.hidden end
  local stream = sources[name].finder(finder_opts, ctx)
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

file_search = function()
  return { items = {
    { relative_path = ".env" }, { relative_path = ".config/nvim/init.lua" },
    { relative_path = "src/.cache/file.lua" }, { relative_path = "src/visible.lua" },
    { relative_path = "./visible.lua" }, { relative_path = "some.name/file.lua" },
  } }
end
equal(6, #run("fff_files", "", { hidden = true }), "Git hidden-on emits indexed hidden files")
local visible = run("fff_files", "", { hidden = false })
equal({ "src/visible.lua", "./visible.lua", "some.name/file.lua" },
  vim.tbl_map(function(item) return item.file end, visible), "hidden-off filters every dot-prefixed component")
equal(1, #api_calls, "hidden filtering retains one-call file API")

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
content_search = function()
  local items = {}
  for i, path in ipairs({ ".env", "src/.cache/file.lua", "src/visible.lua" }) do
    local item = match(i)
    item.relative_path = path
    items[#items + 1] = item
  end
  return { items = items, next_file_offset = 0 }
end
equal(1, #run("fff_grep", "foo"), "workspace default excludes hidden indexed matches")
equal(3, #run("fff_grep", "foo", { hidden = true }), "workspace hidden-on includes indexed matches")
equal(1, #run("fff_grep_word", "foo"), "word default excludes hidden indexed matches")
equal(3, #run("fff_grep_word", "foo", { hidden = true }), "word hidden-on includes indexed matches")
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
  Snacks.setup({ picker = opts.picker })
  local fixture_root = "/tmp/nvim-fff-toggle-test.3bBrdc/config-routing"
  local git_cwd, plain_cwd = fixture_root .. "/git", fixture_root .. "/plain"
  vim.fn.mkdir(git_cwd .. "/.git", "p")
  vim.fn.mkdir(plain_cwd, "p")
  for _, cwd in ipairs({ git_cwd, plain_cwd }) do
    for _, hidden in ipairs({ false, true }) do
      for _, ignored in ipairs({ false, true }) do
        for _, name in ipairs({ "fff_files", "fff_grep", "fff_grep_word" }) do
          local config = Snacks.picker.config.get({ source = name, cwd = cwd, hidden = hidden, ignored = ignored })
          equal(ignored or (hidden and cwd == plain_cwd), config.native, "real resolved routing matrix")
          equal(math.huge, config.limit_live, "native and fff live cap disabled")
          equal(math.huge, config.limit, "native and fff non-live cap disabled")
          for _, win in ipairs({ "input", "list" }) do
            local keys = config.win[win].keys
            equal(false, keys[Snacks.util.normkey("<a-h>")], "resolved Option-H disabled")
            for _, mapping in ipairs({ { "<a-e>", "fff_toggle_hidden" }, { "<a-i>", "fff_toggle_ignored" } }) do
              local action = keys[Snacks.util.normkey(mapping[1])]
              equal(mapping[2], type(action) == "table" and action[1] or action, "resolved inclusion binding")
              equal("function", type(config.actions[mapping[2]]), "custom action survives generated Snacks toggles")
            end
            equal("list_down", keys[Snacks.util.normkey("<c-j>")][1] or keys[Snacks.util.normkey("<c-j>")],
              "native fallback preserves default navigation")
          end
          equal("telescope", config.layout.preset, "resolved layout unchanged")
          equal(original.picker.layouts.telescope, config.layouts.telescope, "resolved custom layout unchanged")
          if name == "fff_files" then
            equal("fff files", config.title, "real resolved lowercase title")
            equal(not config.native, config.live, "real resolved file query mode")
          end
        end
      end
    end
  end
  equal(true, Snacks.picker.config.get({ source = "fff_files", cwd = plain_cwd }).native,
    "default hidden-on non-Git/home-style picker chooses native")
  equal(false, Snacks.picker.config.get({ source = "fff_files", cwd = git_cwd }).native,
    "default Git files keeps fff")
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
  local resolved = Snacks.picker.config.get({ source = "fff_files", cwd = git_cwd })
  equal(math.huge, resolved.limit_live, "resolved config overrides Snacks default cap")
  local real_picker = Snacks.picker.fff_files({ cwd = git_cwd, layout = { preset = "select", preview = false } })
  assert(vim.wait(15000, function()
    return not real_picker.finder:running() and not real_picker.matcher:running()
  end, 10), "real Snacks finder timed out")
  equal(total, #real_picker:items(), "real Snacks finder streams more than 10000 items")
  equal(1, backend_calls, "real Snacks file query invokes backend once")
  real_picker:close()
  print("fff real Snacks finder regression: OK (10005 items)")

  -- Exercise the native file source with its fuzzy matcher, without searching home.
  local proc = require("snacks.picker.source.proc")
  local original_proc, native_calls = proc.proc, 0
  proc.proc = function(proc_opts)
    native_calls = native_calls + 1
    equal(proc_opts.hidden, vim.tbl_contains(proc_opts.args, "--hidden"), "native files applies hidden state")
    equal(proc_opts.ignored, vim.tbl_contains(proc_opts.args, "--no-ignore"), "native files applies ignored state")
    -- A fuzzy query must not leak into fd/rg's regex/glob argument list.
    assert(not vim.tbl_contains(proc_opts.args, "fl"), "native fuzzy pattern is not a finder search")
    return function(cb)
      for i = 1, total do
        local item = { text = "file" .. i .. ".lua" }
        proc_opts.transform(item)
        cb(item)
      end
    end
  end
  local show_calls = 0
  local function original_on_show()
    show_calls = show_calls + 1
  end
  local native_picker = Snacks.picker.fff_files({
    cwd = plain_cwd, ignored = true, search = "fl", layout = { preset = "select", preview = false },
    on_show = original_on_show,
  })
  assert(vim.wait(15000, function()
    return not native_picker.finder:running() and not native_picker.matcher:running()
  end, 10), "native Snacks finder timed out")
  equal("fff files", native_picker.title, "native UI exact title")
  equal(true, native_picker.opts.native, "native UI backend hint enabled")
  equal("fl", native_picker.input.filter.pattern, "native UI query uses fuzzy pattern")
  equal("", native_picker.input.filter.search, "native UI finder search empty")
  equal(total, #native_picker:items(), "native fuzzy query has no 10000 result cap")
  equal(1, native_calls, "native files enumerates once")
  equal(1, show_calls, "original on_show runs once on initial picker")
  local function real_toggle(current, flag, native, hidden, ignored)
    current:focus("input")
    vim.cmd.stopinsert()
    vim.api.nvim_win_set_cursor(current.input.win.win, { 1, 0 })
    local previous_show_calls = show_calls
    local callback = current.opts.on_show
    local next_picker = current.opts.actions["fff_toggle_" .. flag](current)
    assert(current.closed, "real toggle closes previous backend")
    assert(vim.wait(15000, function()
      return not next_picker.finder:running() and not next_picker.matcher:running()
    end, 10), "real toggled picker timed out")
    equal(native, next_picker.opts.native, "real toggled backend")
    equal(hidden, next_picker.opts.hidden, "real toggled hidden state")
    equal(ignored, next_picker.opts.ignored, "real toggled ignored state")
    equal(plain_cwd, next_picker.input.filter.cwd, "real toggle preserves cwd")
    equal("fl", native and next_picker.input.filter.pattern or next_picker.input.filter.search,
      "real toggle preserves query across live/pattern transitions")
    equal(native and "" or "fl", next_picker.input.filter.search, "real file finder query mode")
    equal("fff files", next_picker.title, "real toggle preserves exact title")
    assert(vim.wait(1000, function()
      return vim.fn.mode():sub(1, 1) == "n"
        and vim.deep_equal({ 1, 0 }, vim.api.nvim_win_get_cursor(next_picker.input.win.win))
    end, 10), "real toggle preserves input normal mode and caret")
    equal("input", next_picker:current_win(), "real toggle preserves input focus")
    equal(callback, next_picker.opts.on_show, "one-shot on_show wrapper removed")
    equal(callback, next_picker.init_opts.on_show, "original on_show retained without wrapper accumulation")
    equal(previous_show_calls + (callback and 1 or 0), show_calls, "original on_show runs exactly once per replacement")
    return next_picker
  end
  native_picker = real_toggle(native_picker, "ignored", true, true, false)
  native_picker = real_toggle(native_picker, "hidden", false, false, false)
  native_picker = real_toggle(native_picker, "ignored", true, false, true)
  native_picker = real_toggle(native_picker, "ignored", false, false, false)
  native_picker = real_toggle(native_picker, "hidden", true, true, false)
  native_picker:close()
  local no_callback_picker = Snacks.picker.fff_files({
    cwd = plain_cwd, ignored = true, search = "fl", layout = { preset = "select", preview = false },
  })
  assert(vim.wait(15000, function()
    return not no_callback_picker.finder:running() and not no_callback_picker.matcher:running()
  end, 10), "no-callback picker timed out")
  no_callback_picker = real_toggle(no_callback_picker, "ignored", true, true, false)
  no_callback_picker = real_toggle(no_callback_picker, "hidden", false, false, false)
  no_callback_picker:close()
  proc.proc = original_proc
  print("fff native Snacks regression: OK (routing, actions, fuzzy query, 10005 items)")
end
print("fff backend regression: OK")
