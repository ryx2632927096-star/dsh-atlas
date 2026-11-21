import { safeFetchJson } from './upstream.js'

export async function searchGithubRepo(packageName, options = {}) {
  const raw = String(packageName || "").trim()
  if (!raw) return { candidates: [], tried: [], error: "包名为空" }

  const bare = raw.replace(/^@[^/]+\//, "")
  const terms = [bare]
  const stripped = bare.replace(/^dsh[-_]/, "")
  if (stripped && stripped !== bare && stripped.length >= 3) terms.push(stripped)

  const perPage = Number.isFinite(options.perPage) ? Math.max(1, Math.min(10, options.perPage)) : 5
  const tried = []

  for (const term of terms) {
    tried.push(term)
    const q = encodeURIComponent(term + " in:name")
    const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perPage}`
    try {
      const data = await safeFetchJson(url, { timeoutMs: options.timeoutMs || 15000 })
      const items = Array.isArray(data && data.items) ? data.items : []
      if (!items.length) continue

      const candidates = items.map((it) => ({
        fullName: it.full_name,
        url: it.html_url,
        description: String(it.description || "").slice(0, 120),
        stars: it.stargazers_count,
        updatedAt: it.pushed_at,
        exact: String(it.name || "").toLowerCase() === term.toLowerCase(),
      }))
      candidates.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0) || b.stars - a.stars)
      return { candidates, tried }
    } catch (error) {
      const msg = String((error && error.message) || error)
      if (/HTTP 403/.test(msg)) return { candidates: [], tried, error: "GitHub 配额用完（403），稍后再试" }
      if (/HTTP 404/.test(msg)) continue
      return { candidates: [], tried, error: msg.slice(0, 160) }
    }
  }

  return { candidates: [], tried }
}
