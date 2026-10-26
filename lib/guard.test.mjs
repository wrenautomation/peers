// node lib/guard.test.mjs
import { scan } from './guard.mjs'

const W = null // whole tree
const cases = [
  // staging
  ['git add -A', 'stage', W],
  ['cd x && git add . && git commit -m x', 'stage', ['.']],
  ['git commit -am "x"', 'stage', W],
  ['git -C /r commit -a', 'stage', W],
  ['git add -- a.ts b.ts', 'stage', ['a.ts', 'b.ts']],
  ['git add src', 'stage', ['src']],
  ['git commit -m "msg"', null],
  ['git commit --only -m x -- a', 'stage', ['a']],
  ['git status; git add -A', 'stage', W],
  // discards
  ['git stash', 'discard', W],
  ['git stash push -m "wip"', 'discard', W],
  ['git stash -u', 'discard', W],
  ['git stash list', null],
  ['git stash pop', null],
  ['git stash push -- a.ts', 'discard', ['a.ts']],
  ['git reset --hard', 'discard', W],
  ['git reset --hard origin/main', 'discard', W],
  ['git reset HEAD~1', null],
  ['git checkout -- .', 'discard', ['.']],
  ['git checkout .', 'discard', ['.']],
  ['git checkout -- src/a.ts', 'discard', ['src/a.ts']],
  ['git checkout main', 'discard', ['main']],
  ['git checkout -b feat', null],
  ['git checkout -f main', 'discard', W],
  ['git restore .', 'discard', ['.']],
  ['git restore --staged a.ts', null],
  ['git restore --source HEAD~2 a.ts', 'discard', ['a.ts']],
  ['git clean -fd', 'discard', W],
  ['git clean -n', null],
  ['git switch main', 'switch', W],
  ['git switch -c feat', null],
  ['git rm -r src/old', 'discard', ['src/old']],
  // formatters
  ['pnpm biome check --write .', 'format', ['.']],
  ['pnpm -s biome check --write', 'format', W],
  ['npx biome format --write src', 'format', ['src']],
  ['pnpm biome check --write src/a.ts', 'format', ['src/a.ts']],
  ['pnpm biome check --write $(mine files)', 'format', []],
  ['pnpm biome check .', null],
  ['pnpm lint:fix', 'format', W],
  ['pnpm -s run lint:fix', 'format', W],
  ['npm run format', 'format', W],
  ['pnpm lint', null],
  ['./node_modules/.bin/prettier -w "src/**/*.ts"', 'format', W],
  ['eslint --fix src/a.ts', 'format', ['src/a.ts']],
  ['ruff format', 'format', W],
  ['ruff format --check', null],
  ['cargo fmt', 'format', W],
  // prose
  ['echo "git reset --hard"', null],
  ["echo 'git stash'", null],
  ['python3 - <<EOF\ngit reset --hard\nEOF', null],
  ['mine commit -m "git add -A"', null],
  ['git log --oneline -5', null],
  ['grep -rn "git checkout" .', null],
]
let bad = 0
for (const [cmd, rule, targets] of cases) {
  const h = scan(cmd)[0] ?? null
  const ok = rule === null ? h === null : h?.rule === rule && JSON.stringify(h.targets) === JSON.stringify(targets)
  if (!ok) bad++
  console.log(ok ? 'ok ' : 'BAD', JSON.stringify(cmd).slice(0, 52).padEnd(52), ok ? '' : JSON.stringify(h))
}
console.log(bad ? `${bad} failed` : `${cases.length} passed`)
process.exit(bad ? 1 : 0)
