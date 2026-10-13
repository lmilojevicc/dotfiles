local bootstrapped = false

local function whole_word(query)
  local literal = query:gsub("[\\.^$|?*+()%[%]{}]", "\\%0")
  -- Keep fff's query parser from splitting selections or recognizing brace globs.
  literal = literal:gsub("[%s,]", function(char)
    return string.format("\\x%02x", char:byte())
  end)
  -- Half boundaries also handle literal selections with punctuation at either edge.
  return "\\b{start-half}" .. literal .. "\\b{end-half}"
end

local function hidden_path(path)
  for component in path:gmatch("[^/\\]+") do
    if component:sub(1, 1) == "." and component ~= "." and component ~= ".." then
      return true
    end
  end
  return false
end

local function finder(grep)
  return function(opts, ctx)
    local query = ctx.filter.search
    local cwd = ctx:cwd()
    if grep and query == "" then
      return function() end
    end
    if opts.fff_whole_word then
      query = whole_word(query)
    end
    return function(cb)
      local offset = 0
      while not ctx.async:aborted() do
        local result = ctx.async:schedule(function()
          if ctx.async:aborted() then
            return
          end
          local fff = require("fff")
          -- Upstream's public API scan waits require this one-time bootstrap.
          if not bootstrapped then
            require("fff.file_picker").setup()
            bootstrapped = true
          end
          if grep then
            return fff.content_search(query, {
              cwd = cwd,
              mode = "regex",
              page_size = 50,
              file_offset = offset,
              wait_for_index_ms = 10000,
              max_matches_per_file = 0,
              time_budget_ms = 25,
              enforce_time_budget = true,
              trim_whitespace = false,
            })
          end
          return fff.file_search(query, {
            cwd = cwd,
            -- Zero requests all ranked files without rescoring the index per page.
            max_results = 0,
            page = 0,
            wait_for_index_ms = 10000,
          })
        end)
        if ctx.async:aborted() then
          return
        end
        for _, match in ipairs(result.items) do
          if ctx.async:aborted() then
            return
          end
          local item = { file = match.relative_path, cwd = cwd, text = match.relative_path }
          if grep then
            local ranges = match.match_ranges or {}
            local col = match.col or (ranges[1] and ranges[1][1]) or 0
            item.pos = { match.line_number, col }
            item.line = match.line_content
            item.text = item.file .. ":" .. match.line_number .. ":" .. (col + 1) .. ":" .. item.line
            item.positions = {}
            for _, range in ipairs(ranges) do
              for byte = range[1] + 1, range[2] do
                item.positions[#item.positions + 1] = byte
              end
            end
          elseif result.location then
            item.pos = { result.location.line, math.max(0, (result.location.col or 1) - 1) }
          end
          if opts.hidden or not hidden_path(item.file) then
            cb(item)
          end
        end
        if grep then
          local next_offset = result.next_file_offset
          if not next_offset or next_offset == 0 or next_offset <= offset then
            return
          end
          offset = next_offset
        else
          return
        end
      end
    end
  end
end

local function native_required(opts)
  -- fff indexes hidden files in Git, but excludes them from non-Git scans.
  return opts.ignored or (opts.hidden and not Snacks.git.get_root(opts.cwd or vim.fn.getcwd()))
end

local function inclusion_toggle(flag, files)
  return function(picker)
    local opts = vim.deepcopy(picker.init_opts or {})
    opts.cwd = picker.input.filter.cwd
    opts.hidden, opts.ignored = picker.opts.hidden, picker.opts.ignored
    opts[flag] = not opts[flag]
    opts.pattern, opts.search = picker.input.filter.pattern, picker.input.filter.search
    -- Read the input buffer too: the debounced filter may not yet have caught up.
    if picker.opts.live then
      opts.search = picker.input:get()
    else
      opts.pattern = picker.input:get()
    end
    if files then
      opts.search = picker.opts.live and opts.search or opts.pattern
      opts.pattern = ""
    end
    opts.focus = picker:current_win() or picker.opts.focus
    if picker:current_win() == "input" then
      local mode = vim.fn.mode():sub(1, 1)
      local cursor = vim.api.nvim_win_get_cursor(picker.input.win.win)
      local on_show = picker.opts.on_show
      opts.on_show = function(replacement)
        -- This is a one-shot restore, not a wrapper to carry into future toggles.
        replacement.init_opts.on_show = on_show
        replacement.opts.on_show = on_show
        if on_show then
          on_show(replacement)
        end
        vim.schedule(function()
          if replacement.closed or replacement:current_win() ~= "input" then
            return
          end
          vim.cmd.stopinsert()
          vim.api.nvim_win_set_cursor(replacement.input.win.win, cursor)
          if mode == "i" then
            -- Normal-mode cursor placement clamps an insertion caret at end of line.
            vim.cmd(cursor[2] >= #replacement.input:get() and "startinsert!" or "startinsert")
          end
        end)
      end
    end
    local name = picker.opts.source
    picker:close()
    return Snacks.picker.pick(name, opts)
  end
end

local function configure(native_source)
  local files = native_source == "files"
  return function(opts)
    opts.actions.fff_toggle_hidden = inclusion_toggle("hidden", files)
    opts.actions.fff_toggle_ignored = inclusion_toggle("ignored", files)
    opts.toggles.native = { icon = "native" }
    opts.native = not not native_required(opts)
    if not opts.native then
      return opts
    end
    -- Resolve the public native source, retaining our source identity and shared UI.
    -- In particular, native files needs its normal fuzzy matcher, not fff ranking.
    local native = Snacks.picker.config.get({ source = native_source })
    opts.finder, opts.matcher, opts.sort = native.finder, native.matcher, native.sort
    if files then
      -- Config hooks can run more than once; convert only while still in live mode.
      if opts.live then
        opts.pattern, opts.search = opts.search or opts.pattern, ""
      end
    elseif native_source == "grep_word" then
      -- Use the same literal boundaries as fff, without Snacks parsing selection args.
      opts.regex, opts.args = true, {}
      local native_finder = Snacks.picker.config.finder(native.finder)
      opts.finder = function(fopts, ctx)
        ctx = ctx:clone()
        ctx.filter = ctx.filter:clone()
        if ctx.filter.search ~= "" then
          ctx.filter.search = whole_word(ctx.filter.search)
        end
        return native_finder(fopts, ctx)
      end
    else
      opts.regex = true
    end
    opts.live = native.live or false
    return opts
  end
end

local function source(grep, native_source)
  return {
    title = not grep and "fff files" or nil,
    hidden = not grep,
    ignored = false,
    config = configure(native_source),
    actions = {},
    win = {
      input = {
        keys = {
          ["<a-h>"] = false,
          ["<a-e>"] = { "fff_toggle_hidden", mode = { "i", "n" } },
          ["<a-i>"] = { "fff_toggle_ignored", mode = { "i", "n" } },
        },
      },
      list = {
        keys = {
          ["<a-h>"] = false,
          ["<a-e>"] = "fff_toggle_hidden",
          ["<a-i>"] = "fff_toggle_ignored",
        },
      },
    },
    finder = finder(grep),
    format = "file",
    preview = "file",
    confirm = "jump",
    live = true,
    limit = math.huge,
    limit_live = math.huge,
    supports_live = true,
    show_empty = true,
    matcher = { sort = false },
    sort = { fields = { "idx" } },
  }
end

return {
  {
    "dmtrKovalenko/fff",
    main = "fff",
    lazy = false,
    build = function()
      require("fff.download").download_or_build_binary()
    end,
    opts = {},
  },
  {
    "folke/snacks.nvim",
    opts = function(_, opts)
      opts.picker = opts.picker or {}
      opts.picker.sources = opts.picker.sources or {}
      local sources = opts.picker.sources
      sources.fff_files = source(false, "files")
      sources.fff_grep = source(true, "grep")
      sources.fff_grep_word = source(true, "grep_word")
      sources.fff_grep_word.live = false
      sources.fff_grep_word.fff_whole_word = true
      sources.fff_grep_word.search = function(picker)
        return picker:word()
      end
    end,
  },
}
