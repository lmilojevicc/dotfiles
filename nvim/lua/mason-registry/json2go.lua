return {
  name = "json2go",
  description = "Convert json to Go type annotations.",
  homepage = "https://github.com/olexsmir/json2go",
  licenses = { "Unlicense" },
  languages = { "Go" },
  categories = {},
  source = {
    id = "pkg:golang/olexsmir.xyz/json2go@v0.1.3#cmd/json2go",
  },
  bin = {
    json2go = "golang:json2go",
  },
}
