// Manifest -> SQL that registers (or updates) a game in the catalog. Shared by manifest-to-sql.mjs and approve-game.mjs.
// The SQL only upserts the catalog row and calls public.apply_manifest(); it never deletes anything.

/** SQL string literal (or null). */
export const sqlLiteral = (s) => (s == null || s === "" ? "null" : "'" + String(s).replace(/'/g, "''") + "'");

/**
 * @param {object} m parsed obsigama-manifest.json
 * @param {{ status?: "listed" | "draft", repo?: string, description?: string, iconUrl?: string, header?: string }} [o]
 */
export function manifestToSql(m, o = {}) {
  const json = JSON.stringify(m);
  if (json.includes("$manifest$")) throw new Error("manifest contains the dollar-quote tag $manifest$");
  const q = sqlLiteral;
  const status = o.status ?? "draft";
  return `${o.header ? o.header.trimEnd() + "\n" : ""}-- ${m.name} (${m.gameId}) manifest v${m.manifestVersion}
insert into public.games (id, plugin_id, name, description, repo_url, icon_url, status)
values (${q(m.gameId)}, ${q(m.pluginId)}, ${q(m.name)}, ${q(o.description)}, ${q(o.repo)}, ${q(o.iconUrl)}, ${q(status)})
on conflict (id) do update set plugin_id = excluded.plugin_id, name = excluded.name,
  description = coalesce(excluded.description, public.games.description),
  repo_url = coalesce(excluded.repo_url, public.games.repo_url),
  icon_url = coalesce(excluded.icon_url, public.games.icon_url), status = excluded.status;
select public.apply_manifest(${q(m.gameId)}, $manifest$${json}$manifest$::jsonb);
`;
}
