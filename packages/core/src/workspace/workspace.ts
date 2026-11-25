/**
 * Clone cache, git worktree at base_commit, strip hidden tests,
 * apply hidden tests from fix_commit after agent run, capture agent diff.
 */
export interface Workspace {
  path: string
  baseCommit: string
}

export interface WorkspaceManager {
  prepare(repo: string, baseCommit: string, hiddenTests: string[]): Promise<Workspace>
  diff(ws: Workspace): Promise<string>
  applyHiddenTests(ws: Workspace, fixCommit: string, hiddenTests: string[]): Promise<void>
  dispose(ws: Workspace): Promise<void>
}
