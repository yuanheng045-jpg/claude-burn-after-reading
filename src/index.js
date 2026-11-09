// Library entry: use these from your own tooling (for example an app that stops Claude Code, burns, then resumes).
export { burnLines, withoutMedia, checkLine } from './burn.js'
export { burnFile, burnSession, subagentFiles, findSession, projectSessions, liveSessions, liveSessionIds, projectDirName, configDir } from './transcript.js'
export { runHook, countMedia, mediaItems } from './hook.js'
export { loadSettings, saveSettings, DEFAULTS as DEFAULT_SETTINGS } from './settings.js'
export { imageSize, imageTokens } from './media.js'
