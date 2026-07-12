We spent weeks getting our agent token usage under control. The surprise wasn't how much we saved. It was that the output got better while we did it.

Everyone treats this as a tradeoff. More context and more thinking for accuracy, less of both to save money. Pick a point on the line. We don't believe that anymore.

Here's why. Most of what runs up a token bill is noise, and noise is exactly what makes a model wrong. A 12,000-token file dump when it needed three lines. A wall of build output. A three-hour session nobody ever cleaned up. The model wades through all of it on every turn and makes mistakes it wouldn't make with a clean context. Cut the noise and both numbers move the right way.

A few of the moves that did the most:

- Compress tool output before it hits the context. Build logs and file dumps shrink 60 to 90 percent, and the model reads results instead of scrollback.
- Retrieve, don't dump. Index the code and inject the few relevant snippets, not whole files.
- Route by complexity. Mechanical work goes to a small fast model. The expensive one is for reasoning, not renaming variables.
- Review with a different model than the one that wrote the code. A model can't see its own blind spots.
- Let effort be adaptive, and cap it. Maximum reasoning on a trivial task is money spent to make the model overthink.

That last one was our most embarrassing win. We were pinned to maximum effort the whole time and didn't know it, paying a premium for worse, second-guessed answers. The fix was one setting.

Efficiency and accuracy are not opposite ends of a dial. The cheaper system is usually the more accurate one.

Full write-up here: [link]
