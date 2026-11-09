---
description: Choose what burn-after-reading does with each kind of thing (keep, archive or burn) and see what it did lately
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/burn-after-reading.js" settings:*), AskUserQuestion
---
These are the current burn-after-reading settings and what it did lately:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/burn-after-reading.js" settings`

Help the user look at these settings and change them. Talk in the user's language, in plain everyday words: they may not be technical at all.

1. In a few short lines, say what happens now to each kind of thing: images attached to a message, images and PDFs from tools (screenshots and the like), images and PDFs read from files, and very long text results. The three choices are:
   - keep: leave it in the conversation
   - archive: take it out of the conversation, but keep a copy that you (Claude) can read again later
   - burn: take it out and destroy it
   Mention why it matters in one sentence: whatever stays in the conversation is sent again with every later message.
2. If the user already said what they want ("$ARGUMENTS"), go straight to step 4.
3. Otherwise ask with the AskUserQuestion tool: one question per kind (four questions in one call), the three choices as the options, the current choice first and marked as current. Only ask about the other settings (how long archive copies are kept, placeholder language, numbering, backups) if the user brings them up.
4. Save with a single command, for example:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/burn-after-reading.js" settings user=archive screenshot=burn file=burn text=keep`
   Other keys you can set the same way: text-over=<characters>, archive-days=<days>, keep-latest=<n>, lang=en|zh, labels=on|off, backup=on|off.
5. Confirm in one or two sentences what is now set. Changes apply from the next time a session ends.
