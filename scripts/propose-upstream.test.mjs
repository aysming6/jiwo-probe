import test from 'node:test'
import assert from 'node:assert/strict'
import sync from './propose-upstream.cjs'

function fixture() {
  const pr = { number: 2, state: 'open', base: { sha: 'base1' }, head: { sha: 'upstream1' }, html_url: 'https://example.com/pr/2', mergeable: true, merge_commit_sha: 'merge1' }
  const state = { ahead: 1, open: [], closed: [], comments: [], creates: 0, writes: 0, checks: [] }
  const api = {
    repos: {
      compareCommitsWithBasehead: async request => {
        assert.equal(request.basehead, 'main...chnnic:main')
        return { data: { ahead_by: state.ahead } }
      },
      getBranch: async () => ({ data: { commit: { sha: pr.head.sha } } }),
    },
    pulls: {
      list: async ({ state: filter }) => ({ data: state[filter] }),
      create: async ({ owner, head, base }) => {
        assert.deepEqual([owner, head, base], ['fork', 'chnnic:main', 'main'])
        state.creates++
        state.open = [pr]
        return { data: pr }
      },
      get: async () => ({ data: pr }),
    },
    issues: {
      listComments() {},
      createComment: async ({ body }) => { state.writes++; state.comments.push({ id: 7, user: { login: 'github-actions[bot]' }, body }) },
      updateComment: async ({ comment_id, body }) => { state.writes++; state.comments.find(c => c.id === comment_id).body = body },
    },
  }
  const github = { rest: api, paginate: { async *iterator() { yield { data: state.comments } } } }
  const run = (eventName = 'schedule') => sync.propose({
    github, context: { repo: { owner: 'fork', repo: 'jiwo-probe' }, ref: 'refs/heads/main', eventName, runId: 1, serverUrl: 'https://github.com' },
    core: { info() {}, setOutput(name, sha) { assert.equal(name, 'merge_sha'); state.checks.push(sha) } },
  })
  return { pr, state, run }
}

test('already integrated upstream leaves the fork untouched', async () => {
  const { state, run } = fixture()
  state.ahead = 0
  await run()
  assert.equal(state.creates + state.writes + state.checks.length, 0)
})

test('one upstream PR and one status comment track changing head and base', async () => {
  const { pr, state, run } = fixture()
  await run()
  await run()
  assert.deepEqual(state.checks, ['merge1'])
  pr.head.sha = 'upstream2'
  pr.mergeable = false
  await run()
  await run()
  assert.equal(state.writes, 2)
  assert.match(state.comments[0].body, /合并冲突/)
  pr.base.sha = 'base2'
  pr.mergeable = true
  pr.merge_commit_sha = 'merge2'
  await run()
  assert.equal(state.creates, 1)
  assert.equal(state.comments.length, 1)
  assert.deepEqual(state.checks, ['merge1', 'merge2'])
  await run('workflow_dispatch')
  assert.deepEqual(state.checks, ['merge1', 'merge2', 'merge2'])
})

test('closing an update PR suppresses daily recreation until the upstream changes', async () => {
  const { pr, state, run } = fixture()
  state.closed.push({ head: { sha: pr.head.sha } })
  await run()
  assert.equal(state.creates, 0)
  pr.head.sha = 'next'
  await run()
  assert.equal(state.creates, 1)
})
