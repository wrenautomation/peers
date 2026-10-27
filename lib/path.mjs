// Windows paths, spelled one way so they compare as POSIX ones do: `/` separators, an upper-case drive,
// Git Bash `/c/x` as `C:/x`. Git prints `C:/x`; tools, the cwd and homedir() may give `c:\\x`.
// win: from the home folder's shape, as the mod has no platform API. Off it, every path stays as given.
// Served to the browser as well: no imports.
export const winOf = home => /^[A-Za-z]:[\\/]/.test(home ?? '')
export const slash = (p, win) => (win && p ? p.replace(/\\/g, '/').replace(/^\/([A-Za-z])(?=\/|$)/, '$1:').replace(/^[a-z]:/, d => d.toUpperCase()) : p)
export const isAbs = p => /^([A-Za-z]:)?\//.test(p)
// home, spelled as slash spells it.
export const homeOf = home => slash(home, winOf(home))
