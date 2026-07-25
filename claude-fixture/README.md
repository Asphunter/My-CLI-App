# Claude read-only fixture

This tiny dependency-free fixture is used for the Claude CODING acceptance
checks. The intended read-only task is to inspect `math.js` and `math.test.js`
and report the exported functions and test cases without editing files.

Run the deterministic local check with:

```text
node --test math.test.js
```
