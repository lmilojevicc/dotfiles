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
      local offset, count = 0, 0
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
            max_results = 100,
            page = offset,
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
          cb(item)
          count = count + 1
        end
        if grep then
          local next_offset = result.next_file_offset
          if not next_offset or next_offset == 0 or next_offset <= offset then
            return
          end
          offset = next_offset
        else
          if #result.items == 0 or count >= result.total_matched then
            return
          end
          offset = offset + 1
        end
      end
    end
  end
end

local function source(grep)
  return {
    finder = finder(grep),
    format = "file",
    preview = "file",
    confirm = "jump",
    live = true,
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
      sources.fff_files = source(false)
      sources.fff_grep = source(true)
      sources.fff_grep_word = source(true)
      sources.fff_grep_word.live = false
      sources.fff_grep_word.fff_whole_word = true
      sources.fff_grep_word.search = function(picker)
        return picker:word()
      end
    end,
  },
}
