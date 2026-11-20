const UPSTREAM = 'chnnic'
const HEAD = UPSTREAM + ':main'
const MARKER = '<!-- jiwo-upstream-check '

function statusComment(base, head, mergeable, runUrl) {
  const decision = mergeable ? 'validate' : 'conflict'
  const key = MARKER + [base, head, decision].join(':') + ' -->'
  const body = mergeable
    ? '已提交该版本的合并预检。类型检查、测试、生产构建及 Wrangler 打包结果见[本次运行](' + runUrl + ')。'
    : 'GitHub 检测到此版本有合并冲突。请在自己仓库的修复分支合并上游并保留两侧历史，检查通过后再合入目标分支。'
  return { key, body: key + '\n\n' + body }
}

async function propose({ github, context, core }) {
  const { owner, repo } = context.repo
  const base = context.ref.replace(/^refs\/heads\//, '')
  if (context.ref === base) throw new Error('请从分支运行同步。')
  const repository = { owner, repo }
  const { pulls, repos, issues } = github.rest
  const comparison = await repos.compareCommitsWithBasehead({
    ...repository, basehead: base + '...' + HEAD, per_page: 1,
  })
  if (comparison.data.ahead_by === 0) {
    core.info('上游提交均已合入。')
    return
  }

  const query = { ...repository, head: HEAD, base }
  const { data: open } = await pulls.list({ ...query, state: 'open' })
  let pr = open[0]
  if (!pr) {
    const { data: closed } = await pulls.list({ ...query, state: 'closed', sort: 'updated', direction: 'desc', per_page: 1 })
    if (closed.length && context.eventName !== 'workflow_dispatch') {
      const { data: upstream } = await repos.getBranch({ owner: UPSTREAM, repo: 'jiwo-probe', branch: 'main' })
      if (closed[0].head.sha === upstream.commit.sha) {
        core.info('此上游版本的 PR 已关闭。可手动运行以重新提议。')
        return
      }
    }
    const created = await pulls.create({
      ...query, title: '同步 chnnic/jiwo-probe 上游更新',
      body: '此 PR 跟踪上游 main。请检查定制功能并使用 **Create a merge commit** 合入，以便下次同步识别已包含的提交。',
      maintainer_can_modify: false,
    })
    pr = created.data
  }

  const pull = { ...repository, pull_number: pr.number }
  for (let attempt = 0; attempt < 10; attempt++) {
    pr = (await pulls.get(pull)).data
    if (pr.state !== 'open') return
    if (pr.mergeable !== null && (!pr.mergeable || pr.merge_commit_sha)) break
    if (attempt === 9) throw new Error('GitHub 尚未完成 PR 合并状态计算，请重试本次运行。')
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  const runUrl = context.serverUrl + '/' + owner + '/' + repo + '/actions/runs/' + context.runId
  const note = statusComment(pr.base.sha, pr.head.sha, pr.mergeable, runUrl)
  const issue = { ...repository, issue_number: pr.number }
  let previous
  for await (const { data } of github.paginate.iterator(issues.listComments, { ...issue, per_page: 100 })) {
    previous = data.find(comment => comment.user.login === 'github-actions[bot]' && comment.body.startsWith(MARKER))
    if (previous) break
  }
  if (previous?.body.startsWith(note.key) && (context.eventName !== 'workflow_dispatch' || !pr.mergeable)) {
    core.info('同一对提交已有结果：' + pr.html_url)
    return
  }
  if (previous) await issues.updateComment({ ...repository, comment_id: previous.id, body: note.body })
  else await issues.createComment({ ...issue, body: note.body })
  core.info(pr.html_url)
  if (pr.mergeable) core.setOutput('merge_sha', pr.merge_commit_sha)
}

module.exports = { propose }
