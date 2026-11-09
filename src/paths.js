// Where things live.
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'

/** Claude Code's config directory (CLAUDE_CONFIG_DIR, else ~/.claude). */
export const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
/**
 * A subagent's transcript (<project>/<session>/subagents/agent-<id>.jsonl) belongs to its session's main transcript
 * (<project>/<session>.jsonl): that path, or null for a main transcript.
 */
export function parentOf(file) {
  const dir = dirname(file)
  if (basename(dir) !== 'subagents') return null
  const sessionDir = dirname(dir)
  return join(dirname(sessionDir), basename(sessionDir) + '.jsonl')
}
/** The config directory a transcript belongs to (<config>/projects/<project>/<id>.jsonl), else the default one. */
export function configDirOf(file) {
  const projects = dirname(dirname(parentOf(file) ?? file))
  return basename(projects) === 'projects' ? dirname(projects) : configDir()
}
/** Where this tool keeps its own files: settings, archive, backups, image numbers, the hook log. */
export const dataDir = (cfg = configDir()) => join(cfg, 'burn-after-reading')
