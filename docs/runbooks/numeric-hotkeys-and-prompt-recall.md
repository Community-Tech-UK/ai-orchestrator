# Numeric Hotkeys And Prompt Recall Runbook

Use this runbook when instance selection or prompt recall does not behave as expected.

## Visible Instance Hotkeys

- `Cmd/Ctrl+1` through `Cmd/Ctrl+9` select the visible nth instance in the rail.
- Hidden rows do not count. Collapsed children, filters, and search results change the visible index.
- Plain number keys typed inside the composer are text input; selection only happens through the configured modifier binding.

## Prompt Recall

- Up recalls older prompts for the active instance.
- Down moves toward newer prompts and eventually restores the stashed draft.
- Esc cancels recall and restores the draft that was present before recall began.
- Sent prompts are persisted by `prompt-history`, so restart-safe recall depends on the prompt-history IPC/store path being available.

## Reverse Search

When enabled, the reverse-search action opens a prompt-history overlay. Pick a row to replace the composer contents; Esc exits without changing the draft.

## Session And Model Pickers

- Session picker ranks live, history, and archived entries with Wave 1 usage frecency as a ranking input.
- Selecting a live session focuses it. Selecting history restores it.
- Model picker lists compatible models first and leaves incompatible models visible with a disabled reason.

## Rail Filter Performance

The rail filter is debounce-backed. If filtering feels slow, check for large instance lists, expensive computed dependencies, and console warnings before changing debounce timing.
