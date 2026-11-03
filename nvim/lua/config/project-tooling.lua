-- Pick formatters and linters from the project's own config files, falling back
-- to my defaults when a project configures none: the oxc tools (oxfmt, oxlint)
-- for JS/TS, my Mason tools for everything else.
--
-- The nearest config file to the buffer wins, so a package in a monorepo can use
-- a different formatter from the repository root.

local M = {}

local configs = {
  oxfmt = { ".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.ts" },
  biome = { "biome.json", "biome.jsonc" },
  prettier = {
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.json5",
    ".prettierrc.yaml",
    ".prettierrc.yml",
    ".prettierrc.toml",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.mjs",
    ".prettierrc.ts",
    ".prettierrc.cts",
    ".prettierrc.mts",
    "prettier.config.js",
    "prettier.config.cjs",
    "prettier.config.mjs",
    "prettier.config.ts",
    "prettier.config.cts",
    "prettier.config.mts",
  },
  oxlint = { ".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts" },
  eslint = {
    "eslint.config.js",
    "eslint.config.cjs",
    "eslint.config.mjs",
    "eslint.config.ts",
    "eslint.config.cts",
    "eslint.config.mts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml",
  },
}

-- File types each formatter handles. oxfmt and Biome cannot format Svelte or Astro.
local supports = {
  oxfmt = {
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact",
    "json",
    "jsonc",
    "json5",
    "css",
    "scss",
    "less",
    "html",
    "vue",
    "graphql",
    "markdown",
    "yaml",
    "toml",
  },
  biome = {
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact",
    "json",
    "jsonc",
    "css",
    "graphql",
  },
  prettier = {
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact",
    "json",
    "jsonc",
    "json5",
    "css",
    "scss",
    "less",
    "html",
    "vue",
    "svelte",
    "astro",
    "graphql",
    "markdown",
    "yaml",
  },
}

local function buf_path(bufnr)
  local name = vim.api.nvim_buf_get_name(bufnr)
  return name ~= "" and name or vim.fn.getcwd() .. "/_"
end

local function levels(dir)
  return select(2, dir:gsub("/", ""))
end

--- Distance (in directories) from `path` up to the nearest file in `names`.
---@return integer|nil depth, string|nil dir
local function nearest(names, path)
  local start = vim.fs.dirname(path)
  local found = vim.fs.find(names, { path = start, upward = true, limit = 1 })[1]
  if not found then
    return nil
  end
  local dir = vim.fs.dirname(found)
  return levels(start) - levels(dir), dir
end

--- Prettier can also be configured with a "prettier" key in package.json.
---@return integer|nil depth
local function package_json_prettier(path)
  local depth, dir = nearest({ "package.json" }, path)
  if not dir then
    return nil
  end
  local ok, data = pcall(function()
    return vim.json.decode(table.concat(vim.fn.readfile(dir .. "/package.json"), "\n"))
  end)
  if ok and type(data) == "table" and data.prettier ~= nil then
    return depth
  end
end

--- The formatter the project configures for this buffer: "oxfmt", "biome",
--- "prettier", or nil when it configures none. Ties go to oxfmt, then Biome.
---@return string|nil
function M.project_formatter(bufnr)
  local path = buf_path(bufnr)
  local best, best_depth
  for _, tool in ipairs({ "oxfmt", "biome", "prettier" }) do
    local depth = nearest(configs[tool], path)
    if tool == "prettier" then
      local pkg_depth = package_json_prettier(path)
      if pkg_depth and (not depth or pkg_depth < depth) then
        depth = pkg_depth
      end
    end
    if depth and (not best_depth or depth < best_depth) then
      best, best_depth = tool, depth
    end
  end
  return best
end

local conform_names = {
  oxfmt = { "oxfmt" },
  biome = { "biome" },
  prettier = { "prettierd", "prettier", stop_after_first = true },
}

--- A conform `formatters_by_ft` entry: the project's formatter when it handles
--- this file type, otherwise `fallback` (oxfmt unless given).
---@param fallback? table conform formatter list for projects without a formatter for this type
function M.formatters(fallback)
  fallback = fallback or { "oxfmt" }
  return function(bufnr)
    local tool = M.project_formatter(bufnr)
    if tool and vim.tbl_contains(supports[tool], vim.bo[bufnr].filetype) then
      return conform_names[tool]
    end
    return fallback
  end
end

--- Root for the oxlint language server, or nil to skip this buffer.
--- Projects with an oxlint config get it there. Projects that configure ESLint or
--- Biome instead are left to those servers. Anything else gets oxlint's defaults.
---@return string|nil
function M.oxlint_root(bufnr)
  local path = buf_path(bufnr)
  local _, oxlint_dir = nearest(configs.oxlint, path)
  if oxlint_dir then
    return oxlint_dir
  end
  if nearest(configs.eslint, path) or nearest(configs.biome, path) then
    return nil
  end
  return vim.fs.root(bufnr, {
    { "package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock" },
    ".git",
  }) or vim.fs.dirname(path)
end

-- Other languages, same rule: a tool the project configures wins (nearest config
-- first, ties in list order); otherwise my default from Mason. Each candidate is
-- detected by config files, a pyproject.toml table, or a golangci formatters block.

local function read(file)
  local ok, lines = pcall(vim.fn.readfile, file)
  return ok and table.concat(lines, "\n") or ""
end

local golangci_configs = { ".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json" }

--- The project's golangci-lint config file, if any.
---@return string|nil
function M.golangci_config(bufnr)
  return vim.fs.find(golangci_configs, { path = vim.fs.dirname(buf_path(bufnr)), upward = true, limit = 1 })[1]
end

local function golangci_formats(cfg)
  local text = read(cfg)
  return text:find("^formatters:")
    or text:find("\nformatters:")
    or text:find("%[formatters")
    or text:find('"formatters"')
end

--- Depth of the nearest evidence that the project uses a candidate, or nil.
local function detect(candidate, path)
  local best
  local function take(depth)
    if depth and (not best or depth < best) then
      best = depth
    end
  end
  if candidate.files then
    take((nearest(candidate.files, path)))
  end
  if candidate.pyproject then
    local depth, dir = nearest({ "pyproject.toml" }, path)
    if dir and read(dir .. "/pyproject.toml"):find(candidate.pyproject) then
      take(depth)
    end
  end
  if candidate.golangci then
    local depth, dir = nearest(golangci_configs, path)
    if dir then
      local cfg = vim.fs.find(golangci_configs, { path = dir, limit = 1 })[1]
      if cfg and golangci_formats(cfg) then
        take(depth)
      end
    end
  end
  return best
end

--- The candidate the project configures for this buffer, or nil.
---@param candidates table[] { name, use, files?, pyproject?, golangci? }
function M.pick(candidates, bufnr)
  local path = buf_path(bufnr)
  local chosen, chosen_depth
  for _, candidate in ipairs(candidates) do
    local depth = detect(candidate, path)
    if depth and (not chosen_depth or depth < chosen_depth) then
      chosen, chosen_depth = candidate, depth
    end
  end
  return chosen
end

--- A conform `formatters_by_ft` entry for `candidates`, with `fallback` when the
--- project configures none of them.
function M.choose(candidates, fallback)
  return function(bufnr)
    local chosen = M.pick(candidates, bufnr)
    return chosen and chosen.use or fallback
  end
end

M.formatter_candidates = {
  python = {
    {
      name = "ruff",
      use = { "ruff_organize_imports", "ruff_format" },
      files = { "ruff.toml", ".ruff.toml" },
      pyproject = "%[tool%.ruff",
    },
    { name = "black", use = { "isort", "black" }, pyproject = "%[tool%.black%]" },
    { name = "yapf", use = { "isort", "yapf" }, files = { ".style.yapf" }, pyproject = "%[tool%.yapf%]" },
    { name = "autopep8", use = { "isort", "autopep8" }, pyproject = "%[tool%.autopep8%]" },
  },
  go = {
    { name = "golangci-lint", use = { "golangci-lint" }, golangci = true },
  },
  sql = {
    { name = "sqruff", use = { "sqruff" }, files = { ".sqruff" } },
    { name = "sqlfluff", use = { "sqlfluff" }, files = { ".sqlfluff" }, pyproject = "%[tool%.sqlfluff" },
  },
  markdown = {
    {
      name = "markdownlint-cli2",
      use = { "markdownlint-cli2", "injected" },
      files = {
        ".markdownlint-cli2.jsonc",
        ".markdownlint-cli2.yaml",
        ".markdownlint-cli2.cjs",
        ".markdownlint-cli2.mjs",
      },
    },
    {
      name = "rumdl",
      use = { "rumdl", "injected" },
      files = { ".rumdl.toml", "rumdl.toml" },
      pyproject = "%[tool%.rumdl",
    },
  },
  yaml = {
    {
      name = "yamlfmt",
      use = { "yamlfmt" },
      files = { ".yamlfmt", ".yamlfmt.yml", ".yamlfmt.yaml", "yamlfmt.yml", "yamlfmt.yaml" },
    },
  },
  toml = {
    { name = "taplo", use = { "taplo" }, files = { ".taplo.toml", "taplo.toml" } },
  },
}

M.linter_candidates = {
  sql = M.formatter_candidates.sql,
  markdown = M.formatter_candidates.markdown,
  yaml = {
    { name = "yamllint", files = { ".yamllint", ".yamllint.yml", ".yamllint.yaml" } },
  },
}

--- Formatters for file types that the JS formatters also cover (Markdown, YAML,
--- TOML): the project's oxfmt/Prettier/Biome first, then its other tools, then
--- `fallback`. The nearest config of either kind wins.
function M.web_or(candidates, fallback)
  local web = M.formatters(fallback)
  return function(bufnr)
    local path = buf_path(bufnr)
    local tool = M.project_formatter(bufnr)
    local other = M.pick(candidates, bufnr)
    if tool and vim.tbl_contains(supports[tool], vim.bo[bufnr].filetype) then
      local web_depth = nearest(configs[tool], path) or package_json_prettier(path) or math.huge
      if not other or web_depth <= detect(other, path) then
        return conform_names[tool]
      end
    end
    if other then
      return other.use
    end
    return web(bufnr)
  end
end

--- Whether the project picked linter `name` for this buffer's file type.
function M.uses_linter(name, bufnr)
  local candidates = M.linter_candidates[vim.bo[bufnr].filetype] or {}
  local chosen = M.pick(candidates, bufnr)
  return chosen ~= nil and chosen.name == name, chosen
end

return M
